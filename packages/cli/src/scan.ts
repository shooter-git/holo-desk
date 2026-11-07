/**
 * `holo scan`: sheet music photographed or scanned in the studio, read into a song a system at a
 * time. `show` brings the pages and each system's strip to a folder here (the server may be in Docker)
 * and says what each system holds; the AI reads a strip, writes its bars with `holo score write
 * --scan`, and marks how far it got.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Scan, ScanSystem, SystemState } from '@holo/score';

export interface ScanContext {
  words: string[];
  flag: (k: string) => string | undefined;
  call: <T>(path: string, init?: RequestInit) => Promise<T>;
  base: string;
  songId: () => Promise<string>;
}

export const SCAN_HELP = `holo scan: sheet music photographed or scanned in the studio, on its way into the song
  holo scan list                      the song's scans: pages, and how far each is read
  holo scan show SCAN [--out DIR]     its pages and each system's strip, saved to DIR (./scan-SCAN by
                                      default), and what each system holds: staves, bars, state
  holo scan status SCAN PAGE.SYSTEM read|checked|approved [--bars 5-8] [--flag "text"…]
Write a system's bars with: holo score write --scan SCAN --system PAGE.SYSTEM FILE`;

const STATES = new Set<SystemState>(['new', 'read', 'checked', 'approved']);

/** "1.2" → page 1, system 2 (both from 0, as `show` numbers them). */
export function systemRef(text: string | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)$/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function describe(s: ScanSystem, page: number): string {
  const bars = Math.max(0, s.bars.length - 1);
  const where = s.written ? `, written as bars ${s.written[0]}–${s.written[1]}` : '';
  const flags = s.flags?.length ? `\n      flagged: ${s.flags.join('; ')}` : '';
  return `  ${page}.${s.k}: ${s.staves} stave${s.staves === 1 ? '' : 's'}, about ${bars} bar${bars === 1 ? '' : 's'}, ${s.state}${where}${flags}`;
}

export async function scanCommand(ctx: ScanContext): Promise<void> {
  const [sub = 'help', id, ...rest] = ctx.words;
  if (sub === 'help') {
    console.log(SCAN_HELP);
    return;
  }
  if (sub === 'list') {
    const song = await ctx.songId();
    const rows = await ctx.call<
      { id: string; title: string; created: string; pages: number; progress: Record<string, number> }[]
    >(`/api/scans?project=${song}`);
    if (!rows.length) console.log('No scans for this song. Scan pages in the studio (Score → Scan).');
    for (const r of rows) {
      const p = r.progress;
      console.log(
        `${r.id}  "${r.title}"  ${r.pages} page${r.pages === 1 ? '' : 's'}: ${p.approved ?? 0} approved, ${p.checked ?? 0} checked, ${p.read ?? 0} read, ${p.new ?? 0} to read`,
      );
    }
    return;
  }
  if (!id) throw new Error('Which scan? holo scan list shows them');
  const scan = await ctx.call<Scan>(`/api/scans/${id}`);
  if (sub === 'show') {
    const out = resolve(ctx.flag('out') ?? `scan-${scan.id}`);
    mkdirSync(out, { recursive: true });
    const save = async (path: string, file: string) => {
      const res = await fetch(`${ctx.base}${path}`);
      if (!res.ok) return null;
      const target = join(out, file);
      writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      return target;
    };
    console.log(`"${scan.title}" (${scan.id}) for song ${scan.project}${scan.track ? `, track ${scan.track}` : ''}`);
    let next = 1;
    for (const page of scan.pages) {
      const pagePath = await save(`/api/scans/${scan.id}/pages/${page.n}`, `page-${page.n}.${page.type}`);
      console.log(`page ${page.n}: ${pagePath ?? '(no image)'}`);
      for (const s of page.systems) {
        const strip = await save(
          `/api/scans/${scan.id}/strips/${page.n}/${s.k}`,
          `system-${page.n}-${s.k}.${page.type}`,
        );
        console.log(describe(s, page.n));
        console.log(`      strip: ${strip ?? '(no image)'}`);
        if (s.written) next = Math.max(next, s.written[1] + 1);
      }
    }
    console.log(
      `\nThe next bar to write is ${next}. Read a strip, then: holo score write --scan ${scan.id} --system PAGE.SYSTEM FILE`,
    );
    return;
  }
  if (sub === 'status') {
    const ref = systemRef(rest[0]);
    const state = rest[1] as SystemState | undefined;
    if (!ref || !state || !STATES.has(state))
      throw new Error('holo scan status SCAN PAGE.SYSTEM read|checked|approved');
    const body: { state: SystemState; written?: [number, number]; flags?: string[] } = { state };
    const bars = ctx.flag('bars');
    if (bars) {
      const [a, b] = bars.split(/[-–]/).map(Number);
      if (a !== undefined && !Number.isNaN(a)) body.written = [a, b !== undefined && !Number.isNaN(b) ? b : a];
    }
    const flag = ctx.flag('flag');
    if (flag) body.flags = [flag];
    await ctx.call(`/api/scans/${scan.id}/systems/${ref[0]}/${ref[1]}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    console.log(`${ref[0]}.${ref[1]}: ${state}`);
    return;
  }
  console.log(SCAN_HELP);
}
