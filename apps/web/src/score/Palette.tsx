/**
 * The Score's writing tools: one row, the few things writing needs most (values, a dot, a rest, a tie,
 * the common articulations and dynamics), the rest in one menu. Every button has a key, shown in its
 * tooltip, so the row can be ignored once the keys are known.
 */
import { keyText } from '@holo/session';
import { useSyncExternalStore } from 'react';
import { openMenuAt } from '../ui/menu.tsx';
import type { Entry } from './entry.ts';

const VALUES: [number, string, string][] = [
  [1, 'Whole note', '7'],
  [2, 'Half note', '6'],
  [4, 'Quarter note', '5'],
  [8, 'Eighth note', '4'],
  [16, 'Sixteenth note', '3'],
  [32, 'Thirty-second note', '2'],
];

/** A note value drawn small: a head (open for whole and half), a stem, its flags. */
function NoteIcon({ value }: { value: number }) {
  const open = value <= 2;
  const flags = value >= 8 ? Math.log2(value) - 2 : 0;
  return (
    <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden="true">
      <ellipse
        cx="5"
        cy="15.5"
        rx="3.6"
        ry="2.6"
        transform="rotate(-20 5 15.5)"
        fill={open ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth="1.4"
      />
      {value > 1 && <line x1="8.2" y1="15" x2="8.2" y2="2" stroke="currentColor" strokeWidth="1.3" />}
      {Array.from({ length: flags }, (_, i) => (
        <path
          key={i}
          d={`M8.2 ${2 + i * 3.2} q4 2 3.6 6`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

const ARTICULATIONS: [string, string, string][] = [
  ['stacc', '·', 'Staccato'],
  ['acc', '>', 'Accent'],
  ['ten', '–', 'Tenuto'],
  ['marc', '^', 'Marcato'],
  ['ferm', '𝄐', 'Fermata'],
];

const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fp', 'sfz'];
const CLEFS: [string, string][] = [
  ['G', 'Treble'],
  ['F', 'Bass'],
  ['C3', 'Alto'],
  ['C4', 'Tenor'],
  ['G8vb', 'Treble, an octave down'],
  ['perc', 'Percussion'],
];
const TIMES: [number, number][] = [
  [2, 4],
  [3, 4],
  [4, 4],
  [5, 4],
  [6, 8],
  [9, 8],
  [12, 8],
  [5, 8],
  [7, 8],
  [2, 2],
];

export function Palette({ entry }: { entry: Entry }) {
  const s = useSyncExternalStore(
    (fn) => entry.subscribe(fn),
    () => entry.state,
  );
  if (!s) return null;
  const more = (el: Element) =>
    openMenuAt(el, [
      { label: 'Respell (F♯ ↔ G♭)', hint: 'J', onSelect: () => entry.respell() },
      { label: 'Tidy rhythms: write played-in notes as shown', onSelect: () => entry.tidy() },
      { heading: 'Clef from this bar' },
      ...CLEFS.map(([c, name]) => ({ label: name, onSelect: () => entry.clef(c) })),
      { heading: 'Time from this bar' },
      ...TIMES.map(([n, d]) => ({ label: `${n}/${d}`, onSelect: () => entry.time(n, d) })),
    ]);
  const keys = (el: Element) =>
    openMenuAt(el, [
      { label: 'No key signature', onSelect: () => entry.key(null) },
      ...(['major', 'minor'] as const).flatMap((mode) => [
        { heading: mode === 'major' ? 'Major' : 'Minor' },
        ...Array.from({ length: 15 }, (_, i) => i - 7).map((fifths) => ({
          label: keyText({ fifths, mode }),
          onSelect: () => entry.key({ fifths, mode }),
        })),
      ]),
    ]);
  return (
    <div className="score-palette" role="toolbar" aria-label="Writing">
      <div className="seg">
        {VALUES.map(([value, name, key]) => (
          <button
            key={value}
            type="button"
            className={`btn icon${s.value === value ? ' on' : ''}`}
            title={`${name} (${key})`}
            aria-label={name}
            aria-pressed={s.value === value}
            onClick={() => entry.setValue(value)}
          >
            <NoteIcon value={value} />
          </button>
        ))}
      </div>
      <div className="seg">
        <button
          type="button"
          className={`btn icon${s.dots ? ' on' : ''}`}
          title="Dotted (.)"
          aria-pressed={!!s.dots}
          onClick={() => entry.toggleDot()}
        >
          <span className="glyph">•</span>
        </button>
        <button
          type="button"
          className={`btn icon${s.triplet ? ' on' : ''}`}
          title="Triplet (;)"
          aria-pressed={!!s.triplet}
          onClick={() => entry.toggleTriplet()}
        >
          <span className="glyph">3</span>
        </button>
        <button type="button" className="btn" title="Rest (0)" onClick={() => entry.rest()}>
          Rest
        </button>
        <button
          type="button"
          className="btn"
          title="Tie on: the last note lasts another value (T)"
          onClick={() => entry.tie()}
        >
          Tie
        </button>
      </div>
      <div className="seg">
        {ARTICULATIONS.map(([art, glyph, name]) => (
          <button
            key={art}
            type="button"
            className="btn icon"
            title={name}
            aria-label={name}
            onClick={() => entry.articulation(art)}
          >
            <span className="glyph">{glyph}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn"
        title="Dynamic at the selected note"
        onClick={(e) =>
          openMenuAt(
            e.currentTarget,
            DYNAMICS.map((d) => ({ label: d, onSelect: () => entry.dynamic(d) })),
          )
        }
      >
        <span className="dyn">mf</span> ▾
      </button>
      <div className="seg">
        <button
          type="button"
          className="btn icon"
          title="Crescendo over the selection"
          onClick={() => entry.span('cresc')}
        >
          <span className="glyph">&lt;</span>
        </button>
        <button
          type="button"
          className="btn icon"
          title="Diminuendo over the selection"
          onClick={() => entry.span('dim')}
        >
          <span className="glyph">&gt;</span>
        </button>
        <button
          type="button"
          className="btn icon"
          title="Slur over the selection (S)"
          onClick={() => entry.span('slur')}
        >
          <span className="glyph">⌒</span>
        </button>
      </div>
      <div className="seg">
        {[1, 2].map((v) => (
          <button
            key={v}
            type="button"
            className={`btn icon${s.voice === v ? ' on' : ''}`}
            title={`Voice ${v} (Alt ${v})`}
            aria-pressed={s.voice === v}
            onClick={() => entry.voice(v)}
          >
            <span className="glyph">{v === 1 ? 'Ⅰ' : 'Ⅱ'}</span>
          </button>
        ))}
      </div>
      <button type="button" className="btn" title="Key from this bar" onClick={(e) => keys(e.currentTarget)}>
        Key ▾
      </button>
      <button
        type="button"
        className="btn"
        title="Clef, time, respelling, tidying"
        onClick={(e) => more(e.currentTarget)}
      >
        More ▾
      </button>
    </div>
  );
}
