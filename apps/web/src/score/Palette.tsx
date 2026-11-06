/**
 * The Score's writing tools: one row, the few things writing needs most (values, a dot, a rest, a tie,
 * the common articulations and dynamics), the rest in one menu. Every button has a key, shown in its
 * tooltip, so the row can be ignored once the keys are known.
 */
import type { FormKind } from '@holo/score';
import { keyText } from '@holo/session';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { unrollRepeats } from '../app/actions.ts';
import { openMenuAt } from '../ui/menu.tsx';
import type { Entry, TextTarget } from './entry.ts';

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

const FORM: [FormKind, string][] = [
  ['start', 'Repeat from here'],
  ['end', 'Repeat to here'],
  ['ending1', '1st ending (with its repeat)'],
  ['ending2', '2nd ending'],
  ['segno', 'Segno 𝄋'],
  ['coda', 'Coda 𝄌'],
  ['toCoda', 'To Coda, at the end'],
  ['fine', 'Fine, at the end'],
  ['dc', 'D.C. at the end'],
  ['dcFine', 'D.C. al Fine at the end'],
  ['dsCoda', 'D.S. al Coda at the end'],
  ['dsFine', 'D.S. al Fine at the end'],
];

export function Palette({ entry }: { entry: Entry }) {
  const s = useSyncExternalStore(
    (fn) => entry.subscribe(fn),
    () => entry.state,
  );
  if (!s) return null;
  const more = (el: Element) =>
    openMenuAt(el, [
      { label: 'Lyrics from the selected note', hint: '⇧L', onSelect: () => entry.lyrics() },
      { label: 'Chord symbols from here', hint: '⇧Q', onSelect: () => entry.chordSymbols() },
      { label: 'Respell (F♯ ↔ G♭)', hint: 'J', onSelect: () => entry.respell() },
      { label: 'Tidy rhythms: write played-in notes as shown', onSelect: () => entry.tidy() },
      { heading: 'Clef from this bar' },
      ...CLEFS.map(([c, name]) => ({ label: name, onSelect: () => entry.clef(c) })),
      { heading: 'Time from this bar' },
      ...TIMES.map(([n, d]) => ({ label: `${n}/${d}`, onSelect: () => entry.time(n, d) })),
      { heading: 'Repeats and jumps in this bar' },
      ...FORM.map(([kind, label]) => ({ label, onSelect: () => entry.form(kind, label) })),
      { label: 'None in this bar', onSelect: () => entry.form(null, 'no repeats here') },
      { label: 'Unroll repeats: write them out as they play', onSelect: () => unrollRepeats() },
      { heading: 'Printed pages, from this bar' },
      { label: 'New system here', onSelect: () => entry.breakHere('system') },
      { label: 'New page here', onSelect: () => entry.breakHere('page') },
      { label: 'No break here', onSelect: () => entry.breakHere(null) },
      { heading: 'Tab (fretted parts)' },
      { label: 'Tab under the staff', onSelect: () => entry.tab('under') },
      { label: 'Tab only', onSelect: () => entry.tab('only') },
      { label: 'No tab', onSelect: () => entry.tab('off') },
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
  // (a new place, a new field: what's there already, ready to type over)
  if (s.text) return <TextEntry key={s.text.n} entry={entry} target={s.text} />;
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

/**
 * Words into the score: a syllable a note (Space or - goes to the next note, - joining them), or a
 * chord symbol a beat (Space goes on a beat). Enter finishes, Esc leaves.
 */
function TextEntry({ entry, target }: { entry: Entry; target: TextTarget }) {
  const [value, setValue] = useState(() => entry.textNow());
  const input = useRef<HTMLInputElement>(null);
  // (asked for with Shift+L or Shift+Q: the typing goes here, over what's there)
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const lyric = target.kind === 'lyric';
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      entry.closeText();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      entry.commitText(value, false);
    } else if (e.key === ' ' || e.key === 'Tab') {
      e.preventDefault();
      entry.commitText(value, true);
    } else if (e.key === '-' && lyric && value.trim()) {
      e.preventDefault();
      entry.commitText(`${value.replace(/-$/, '')}-`, true);
    }
  };
  return (
    <div className="score-palette score-text" role="toolbar" aria-label={lyric ? 'Lyrics' : 'Chord symbols'}>
      <span className="muted">{lyric ? `Lyrics, verse ${target.verse}` : 'Chord symbol'}</span>
      <input
        ref={input}
        className="input"
        value={value}
        spellCheck={false}
        aria-label={lyric ? 'Syllable' : 'Chord symbol'}
        placeholder={lyric ? 'a syllable' : 'Dm7, G7/B, Cmaj7…'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        onBlur={() =>
          // (gone elsewhere: done; the next note's field taking over isn't leaving)
          setTimeout(() => {
            if (!document.activeElement?.closest('.score-text')) entry.closeText();
          }, 0)
        }
      />
      <span className="muted hint">
        {lyric ? 'Space: next note · -: joined to the next · Enter: done' : 'Space: next beat · Enter: done'}
      </span>
      {lyric && (
        <div className="seg">
          {[1, 2, 3].map((v) => (
            <button
              key={v}
              type="button"
              className={`btn${target.verse === v ? ' on' : ''}`}
              title={`Verse ${v}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => entry.lyrics(v)}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
