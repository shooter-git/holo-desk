/**
 * Checks on a written score: what a player would stumble on. Notes out of an instrument's range,
 * notes too short to read (usually a slip when it was played in), a part empty for a bar between
 * bars it plays (often a bar a scan missed). Each says the bar, the part and the staff.
 */
import { noteName } from '@holo/session';
import type { ScoreDoc } from './model.ts';
import { partId } from './text.ts';

export interface Flag {
  bar: number;
  part: string;
  staff: number;
  text: string;
}

export function checkScore(doc: ScoreDoc): Flag[] {
  const flags: Flag[] = [];
  doc.parts.forEach((part, pi) => {
    const id = partId(pi);
    for (const staff of part.staves) {
      staff.bars.forEach((sb, b) => {
        const bar = doc.bars[b];
        if (!bar) return;
        for (const v of sb.voices) {
          for (const e of v.events) {
            if (e.kind !== 'chord' || e.grace) continue;
            if (e.value >= 64 && !e.heads.some((h) => h.tie)) {
              flags.push({
                bar: bar.number,
                part: id,
                staff: staff.local,
                text: `a ${e.value === 64 ? '64th' : '128th'} note: played in by mistake?`,
              });
            }
            if (!part.range || part.drums) continue;
            for (const h of e.heads) {
              if (h.tie === 'm' || h.tie === 't') continue;
              const [low, high] = part.range;
              if (h.pitch < low - 2 || h.pitch > high + 2) {
                flags.push({
                  bar: bar.number,
                  part: id,
                  staff: staff.local,
                  text: `${noteName(h.pitch)} is ${h.pitch < low ? 'below' : 'above'} the ${part.name.toLowerCase()}'s range (${noteName(low)}–${noteName(high)})`,
                });
              }
            }
          }
        }
      });
    }
    // a bar of rest between bars the part plays, on a staff that otherwise always plays
    const first = part.staves[0];
    if (!first) return;
    const plays = first.bars.map((sb) => sb.voices.some((v) => v.events.some((e) => e.kind === 'chord')));
    const busy = plays.filter(Boolean).length;
    if (busy >= 8 && busy >= plays.length * 0.8) {
      plays.forEach((p, b) => {
        if (!p && plays[b - 1] && plays[b + 1]) {
          flags.push({
            bar: doc.bars[b]?.number ?? b,
            part: id,
            staff: 1,
            text: 'empty between bars that play: a bar missing?',
          });
        }
      });
    }
  });
  return flags;
}
