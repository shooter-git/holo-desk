/**
 * A kit's pads, each with settings of its own: the pads in a grid as the kit lays them out, and the
 * pad picked, with its level, tune and pan, its velocity curve (drawn), its saturator (its curve
 * drawn), and behind More its pitch envelope, filter and whether it plays to its end. Turned, a
 * setting goes into the track's instrument params (`pad:KEY:ID`), over what the pack set, and the
 * hits after it take it.
 *
 * The two graphs are canvases drawn when what they show changes, never on a timer: nothing here
 * runs while the window just sits open, and nothing of it reaches the audio thread but the params.
 */

import {
  cleanPad,
  type Instrument,
  type Op,
  PAD_CHARACTERS,
  PAD_CURVES,
  PAD_FILTERS,
  PAD_PLAYS,
  type PadField,
  type PadKit,
  type PadValues,
  type ParamDef,
  padKnobs,
  padParam,
  padValues,
  padVelocityGain,
  parsePadParam,
  saturate,
  type Track,
} from '@holo/session';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apply, beginGesture, endGesture, ensureAudio, gestureChange } from '../app/actions.ts';
import { engine } from '../audio/engine.ts';
import { type InstrumentMap, instrumentManifest } from '../audio/pack-files.ts';
import { Knob } from './controls.tsx';
import { prepare } from './frame.ts';
import { type PadGrid, padsFor } from './pads.ts';

type Sampler = Extract<Instrument, { type: 'sampler' }>;

/** An instrument's map, fetched once (null until it comes, or for none). */
export function useInstrumentMap(inst: Sampler): InstrumentMap | null {
  const key = `${inst.pack}/${inst.name}`;
  const [map, setMap] = useState<{ key: string; map: InstrumentMap } | null>(null);
  useEffect(() => {
    let live = true;
    instrumentManifest(inst.pack, inst.name).then(
      (m) => {
        if (live) setMap({ key, map: m });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [inst.pack, inst.name, key]);
  return map?.key === key ? map.map : null;
}

/** The pads a kit's window can set: its own pads, or its sounds (none for an instrument played by pitch). */
export function kitPadGrid(inst: Sampler, map: InstrumentMap | null): PadGrid | null {
  if (!map) return null;
  const grid = padsFor(inst, map, { wide: false, octave: 3, middleC: 'C4' });
  return grid.chromatic || !grid.pads.length ? null : grid;
}

/** Pan as a window shows it: left and right in percent (a pad keeps it from -1 to 1). */
const PAN_SHOWN: ParamDef = { id: 'pan', name: 'Pan', min: -100, max: 100, default: 0, unit: 'LR' };

/** The last pad picked in each kit, so the window opens on it again. */
const picked = new Map<string, number>();

/** The pads of a kit and the one picked: its settings. */
export function KitPads({
  track,
  inst,
  map,
  grid,
  width,
  phone,
}: {
  track: Track;
  inst: Sampler;
  map: InstrumentMap;
  grid: PadGrid;
  width: number;
  phone: boolean;
}) {
  const kitKey = `${inst.pack}/${inst.name}`;
  const kit: PadKit = useMemo(
    () => ({ velocityRange: map.velocityRange, oneShot: map.oneShot }),
    [map.velocityRange, map.oneShot],
  );
  const defs = useMemo(() => padKnobs(kit), [kit]);
  const packPads = useMemo(() => new Map((map.pads ?? []).map((p) => [p.key, p])), [map]);
  const [key, setKey] = useState(() => {
    const was = picked.get(kitKey);
    return grid.pads.some((p) => p.note === was) ? (was as number) : (grid.pads[0]?.note ?? 36);
  });
  const [more, setMore] = useState(false);
  const pad = grid.pads.find((p) => p.note === key) ?? grid.pads[0];
  const params = inst.params;
  const values = (k: number) => padValues(kit, packPads.get(k), params, k, defs);
  const v = values(key);
  // the pack gives this pad settings of its own
  const kitSets = cleanPad(packPads.get(key)) !== null;
  // the song's own settings for this pad (what Reset takes away)
  const edited = (k: number) => Object.keys(params ?? {}).some((id) => parsePadParam(id)?.key === k);
  const def = (id: PadField) => defs.find((d) => d.id === id) as ParamDef;
  const label = (what: string) => `${pad?.name ?? key}: ${what}`;
  const put = (next: Record<string, number> | undefined) =>
    ({
      op: 'updateTrack',
      track: track.id,
      patch: {
        instrument:
          next && Object.keys(next).length
            ? { ...inst, params: next }
            : { type: 'sampler', pack: inst.pack, name: inst.name },
      },
    }) satisfies Op;
  const change = (id: PadField, value: number) => gestureChange([put({ ...params, [padParam(key, id)]: value })]);
  const choose = (id: PadField, value: number, name: string) => {
    if (Math.round(v[id]) === value) return;
    beginGesture(label(name));
    change(id, value);
    endGesture();
  };
  const knob = (id: PadField, size = 42) => (
    <Knob
      key={id}
      def={def(id)}
      value={v[id]}
      size={size}
      onBegin={() => beginGesture(label(def(id).name))}
      onEnd={endGesture}
      onChange={(x) => change(id, x)}
    />
  );
  const reset = () => {
    const next = Object.fromEntries(Object.entries(params ?? {}).filter(([id]) => parsePadParam(id)?.key !== key));
    apply([put(next)], label('Reset'));
  };
  const pick = (note: number) => {
    setKey(note);
    picked.set(kitKey, note);
    void ensureAudio().then(() => engine.audition(track.id, note, 100, 200));
  };
  // the pad's column: its graphs' room beside their knobs (the window's width less its padding on a phone)
  const side = phone ? width - 28 : 330;
  const satOn = v.drive > 0;
  return (
    <div className={`kit-pads${phone ? ' phone' : ''}`}>
      <fieldset
        className="kit-pad-grid"
        aria-label="Pads"
        style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}
      >
        {grid.pads.map((p) => {
          const pv = values(p.note);
          const tags = padTags(pv, kit);
          return (
            <button
              key={p.note}
              type="button"
              aria-pressed={p.note === key}
              className={`kit-pad${p.note === key ? ' on' : ''}`}
              title={`${p.name}: pick it and hear it`}
              onClick={() => pick(p.note)}
            >
              <span className="kit-pad-name">{p.name}</span>
              <span className="kit-pad-tags">
                {tags.map((t) => (
                  <span key={t} className="kit-pad-tag">
                    {t}
                  </span>
                ))}
                {edited(p.note) && <span className="kit-pad-dot" title="Changed in this song" />}
              </span>
              <span className="kit-pad-level" aria-hidden="true">
                <span style={{ width: `${Math.round(levelShare(pv.level) * 100)}%` }} />
              </span>
            </button>
          );
        })}
      </fieldset>
      <div className="kit-pad-edit">
        <div className="kit-pad-head">
          <span className="name">{pad?.name ?? key}</span>
          <button
            type="button"
            className="btn ghost icon"
            title="Back to the pad as the kit has it"
            aria-label="Back to the pad as the kit has it"
            disabled={!edited(key)}
            onClick={reset}
          >
            <RotateCcw />
          </button>
        </div>
        <div className="kit-pad-row">
          {knob('level')}
          {knob('tune')}
          <Knob
            def={PAN_SHOWN}
            value={v.pan * 100}
            detent={2}
            onBegin={() => beginGesture(label('Pan'))}
            onEnd={endGesture}
            onChange={(x) => change('pan', Math.round(x) / 100)}
          />
        </div>
        <section className="kit-pad-section">
          <div className="kit-pad-title">
            <span>Velocity</span>
            <Choice
              options={PAD_CURVES}
              value={v.curve}
              name="Velocity curve"
              onPick={(i) => choose('curve', i, 'Velocity Curve')}
            />
          </div>
          <div className="kit-pad-graph-row">
            <div className="display kit-pad-display">
              <VelocityGraph values={v} width={side - 72} height={phone ? 96 : 104} />
            </div>
            {v.curve === 0 ? knob('range', 38) : knob('intensity', 38)}
          </div>
        </section>
        <section className="kit-pad-section">
          <div className="kit-pad-title">
            <span>Saturator</span>
            <Choice
              options={PAD_CHARACTERS}
              value={v.character}
              name="Saturator character"
              disabled={!satOn}
              onPick={(i) => choose('character', i, 'Saturator Character')}
            />
          </div>
          <div className="kit-pad-graph-row">
            <div className={`display kit-pad-display square${satOn ? '' : ' off'}`}>
              <SaturatorGraph drive={v.drive} hard={v.character === 1} size={phone ? 84 : 92} />
            </div>
            {knob('drive', 38)}
            <div className={satOn ? undefined : 'kit-pad-dim'}>{knob('output', 38)}</div>
          </div>
        </section>
        <button type="button" className="btn ghost kit-pad-more" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Pitch, filter and play
        </button>
        {more && (
          <>
            <div className="kit-pad-row">
              {knob('pitchEnv', 38)}
              <div className={v.pitchEnv !== 0 ? undefined : 'kit-pad-dim'}>{knob('pitchDecay', 38)}</div>
            </div>
            <div className="kit-pad-title">
              <span>Filter</span>
              <Choice
                options={PAD_FILTERS}
                value={v.filter}
                name="Filter"
                onPick={(i) => choose('filter', i, 'Filter')}
              />
            </div>
            <div className={`kit-pad-row${v.filter ? '' : ' kit-pad-dim'}`}>
              {knob('cutoff', 38)}
              {knob('resonance', 38)}
              {knob('filterVelocity', 38)}
            </div>
            <div className="kit-pad-title">
              <span>Play</span>
              <Choice options={PAD_PLAYS} value={v.play} name="Play" onPick={(i) => choose('play', i, 'Play')} />
            </div>
          </>
        )}
        {kitSets && (
          <div className="muted plugin-hint">
            The kit gives this pad a sound of its own. What you turn here is kept in the song; Reset goes back to the
            kit's.
          </div>
        )}
      </div>
    </div>
  );
}

/** What a pad's tile says it has: a saturator, a curve of its own, a pitch envelope, a filter, gated or one-shot. */
function padTags(v: PadValues, kit: PadKit): string[] {
  const out: string[] = [];
  if (v.drive > 0) out.push('Sat');
  if (v.curve !== 0) out.push(v.curve === 1 ? 'Cubic' : 'Lin');
  if (v.pitchEnv !== 0) out.push('Env');
  if (v.filter !== 0) out.push(v.filter === 1 ? 'LP' : 'HP');
  if (v.play !== (kit.oneShot ? 0 : 1)) out.push(v.play === 1 ? 'Gate' : '1-shot');
  return out;
}

/** A level's place on a tile's bar: -60 dB empty, 0 dB at four fifths, +12 dB full. */
function levelShare(db: number): number {
  return db <= -60 ? 0 : Math.min(1, Math.max(0, (db + 60) / 75));
}

/** A setting of a few names, side by side: the one it is lit. */
function Choice({
  options,
  value,
  name,
  disabled,
  onPick,
}: {
  options: readonly string[];
  value: number;
  name: string;
  disabled?: boolean;
  onPick: (i: number) => void;
}) {
  return (
    <div className="seg kit-pad-choice" role="radiogroup" aria-label={name}>
      {options.map((o, i) => (
        // biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={Math.round(value) === i}
          className={`btn tight${Math.round(value) === i ? ' on' : ''}`}
          disabled={disabled}
          onClick={() => onPick(i)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** The display's colors (the studio's LCD): its glass, its grid, its words, and its two traces. */
const LCD = '#07090b';
const GRID = 'rgba(255,255,255,0.06)';
const WORDS = '#4f7d8c';
const TRACE = '#a6ecff';
const HEAT = '#ffb74d';

/** The lowest dB the velocity graph shows. */
const FLOOR = -48;

/**
 * The pad's velocity curve: a hit's level (dB) for each velocity, its own curve bright and the two
 * others faint behind it, so the choice reads at a glance.
 */
function VelocityGraph({ values, width, height }: { values: PadValues; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { curve, range, intensity } = values;
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, height, true);
    if (!ctx) return;
    const pad = 6;
    const x = (vel: number) => pad + ((vel - 1) / 126) * (width - 2 * pad);
    const y = (db: number) => pad + (Math.max(FLOOR, Math.min(0, db)) / FLOOR) * (height - 2 * pad - 10);
    ctx.fillStyle = LCD;
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID;
    for (const vel of [32, 64, 96]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x(vel)) + 0.5, 0);
      ctx.lineTo(Math.round(x(vel)) + 0.5, height - 12);
      ctx.stroke();
    }
    for (const db of [-12, -24, -36]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y(db)) + 0.5);
      ctx.lineTo(width, Math.round(y(db)) + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = WORDS;
    ctx.font = '600 9.5px Inter Variable, system-ui, sans-serif';
    ctx.fillText('0 dB', 4, 14);
    ctx.fillText('-24', 4, y(-24) - 3);
    ctx.fillText('soft', x(1) + 2, height - 3);
    const hard = 'hard';
    ctx.fillText(hard, x(127) - ctx.measureText(hard).width - 2, height - 3);
    const trace = (c: number) => {
      ctx.beginPath();
      for (let vel = 1; vel <= 127; vel++) {
        const g = padVelocityGain(c, range, intensity / 100, vel);
        const db = g > 0 ? 20 * Math.log10(g) : FLOOR;
        if (vel === 1) ctx.moveTo(x(vel), y(db));
        else ctx.lineTo(x(vel), y(db));
      }
    };
    ctx.lineJoin = 'round';
    for (let c = 0; c < 3; c++) {
      if (c === curve) continue;
      trace(c);
      ctx.strokeStyle = 'rgba(166,236,255,0.14)';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    trace(curve);
    // a wider, fainter stroke under the curve is its glow (a blur would be worked out at every move)
    ctx.strokeStyle = 'rgba(166,236,255,0.16)';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = TRACE;
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [curve, range, intensity, width, height]);
  return <canvas ref={ref} role="img" aria-label={`Velocity curve: ${PAD_CURVES[curve] ?? ''}`} />;
}

/** The saturator's curve: what comes out for what goes in, a straight line where it's off. */
function SaturatorGraph({ drive, hard, size }: { drive: number; hard: boolean; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, size, size, true);
    if (!ctx) return;
    const pad = 6;
    const span = size - 2 * pad;
    // in and out from -1.25 to 1.25: a little past full scale, where the drive shows most
    const at = (u: number) => pad + ((u + 1.25) / 2.5) * span;
    const up = (u: number) => size - at(u);
    ctx.fillStyle = LCD;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (const u of [-1, 0, 1]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(at(u)) + 0.5, 0);
      ctx.lineTo(Math.round(at(u)) + 0.5, size);
      ctx.moveTo(0, Math.round(up(u)) + 0.5);
      ctx.lineTo(size, Math.round(up(u)) + 0.5);
      ctx.stroke();
    }
    // the straight line: what goes in comes out
    ctx.beginPath();
    ctx.moveTo(at(-1.25), up(-1.25));
    ctx.lineTo(at(1.25), up(1.25));
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.stroke();
    if (drive <= 0) return;
    const d = drive / 25;
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const u = -1.25 + (2.5 * i) / 96;
      const o = saturate(u, d, hard);
      if (i === 0) ctx.moveTo(at(u), up(o));
      else ctx.lineTo(at(u), up(o));
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,183,77,0.2)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = HEAT;
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [drive, hard, size]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={
        drive > 0 ? `Saturator curve: ${hard ? 'hard' : 'soft'}, ${Math.round(drive)}% drive` : 'Saturator off'
      }
    />
  );
}
