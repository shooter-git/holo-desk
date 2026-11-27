/** The terminal's stems: asked of the host, or rendered here into a folder or a ZIP. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesAccess, ZipFile } from '@holo/music';
import { newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { afterAll, describe, expect, it } from 'vitest';
import { hostStems, renderStems } from '../src/stems.ts';

const BAR = PPQ * 4;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'holo-cli-stems-'));
  dirs.push(d);
  return d;
};

function song(): Project {
  const p = newProject('Terminal');
  p.id = 'prj_t';
  const part = (name: string) => {
    const t = newTrack(name, { type: 'synth', preset: 'Soft Keys' });
    const r = newRegion(0, BAR * 4, name);
    r.notes.push({ t: 0, d: BAR, p: 60, v: 90 });
    t.regions = [r];
    return t;
  };
  p.tracks = [part('Keys'), part('Bass')];
  return p;
}

describe('holo stems', () => {
  function host(states: Record<string, unknown>[]) {
    const asked: { path: string; body?: Record<string, unknown> }[] = [];
    const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
      asked.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.endsWith('/bounces/host')) return { id: 'bnc_1' } as T;
      return (states.shift() ?? states[0]) as T;
    };
    return { asked, call };
  }
  const done = {
    state: 'done',
    line: '',
    error: null,
    file: '2026-01-02 03.04.05 Terminal (stems).zip',
    url: '/api/projects/prj_t/bounces/x.zip',
    path: 'bounces/prj_t/x.zip',
  };

  it('asks the host for the song’s stems, says how they come along, and where they are', async () => {
    const { asked, call } = host([
      { state: 'waiting', line: '', error: null },
      { state: 'running', line: 'Stem 1 of 2, Keys: Rendering 40%', error: null },
      done,
    ]);
    const said: string[] = [];
    const lines: string[] = [];
    const made = await hostStems({
      base: 'http://host',
      call,
      project: song(),
      whole: false,
      log: (t) => said.push(t),
      progress: (t) => lines.push(t),
      every: 0,
    });
    expect(made).toEqual({ path: 'bounces/prj_t/x.zip', url: '/api/projects/prj_t/bounces/x.zip' });
    expect(asked[0]?.path).toBe('/api/projects/prj_t/bounces/host');
    expect(asked[0]?.body).toMatchObject({ stems: true, from: 0, to: BAR * 4, tail: 3, name: 'Terminal (stems)' });
    expect(asked[0]?.body?.doc).toMatchObject({ id: 'prj_t' });
    expect(said[0]).toBe('2 stems of "Terminal": 01 Keys.wav, 02 Bass.wav');
    expect(said.some((t) => /Limiter/.test(t))).toBe(true);
    expect(said.at(-1)).toBe(
      'Exported the stems to bounces/prj_t/x.zip on the host (http://host/api/projects/prj_t/bounces/x.zip)',
    );
    expect(lines).toContain('Waiting for the host…');
    expect(lines).toContain('Stem 1 of 2, Keys: Rendering 40%');
  });

  it('takes the cycle when it’s on, and the whole song when told', async () => {
    const p = song();
    p.cycle = { on: true, start: BAR, end: BAR * 3 };
    const quiet = { log: () => {}, progress: () => {}, every: 0, base: '' };
    const a = host([done]);
    await hostStems({ ...quiet, call: a.call, project: p, whole: false });
    expect(a.asked[0]?.body).toMatchObject({ from: BAR, to: BAR * 3, name: 'Terminal (cycle) (stems)' });
    const b = host([done]);
    await hostStems({ ...quiet, call: b.call, project: p, whole: true });
    expect(b.asked[0]?.body).toMatchObject({ from: 0, to: BAR * 4, name: 'Terminal (stems)' });
  });

  it('says why when the host couldn’t make them, and asks for none of a song with nothing to hear', async () => {
    const quiet = { log: () => {}, progress: () => {}, every: 0, base: '', whole: false };
    const failed = host([{ state: 'failed', line: '', error: 'The host ran out of memory', file: null }]);
    await expect(hostStems({ ...quiet, call: failed.call, project: song() })).rejects.toThrow(
      /failed on the host: The host ran out of memory/,
    );
    const none = host([done]);
    await expect(hostStems({ ...quiet, call: none.call, project: newProject('Empty') })).rejects.toThrow(
      /Nothing in the song would be heard/,
    );
    expect(none.asked).toEqual([]);
  });
});

describe('holo render-audio --stems', () => {
  const render = async (stem: Project, name: string) =>
    new TextEncoder().encode(`${name}:${stem.tracks.filter((t) => !t.inactive).map((t) => t.name)}`);

  it('writes a file for each stem into a folder, each rendered with the other tracks off', async () => {
    const out = join(scratch(), 'stems');
    const made = await renderStems({ project: song(), out, render, log: () => {} });
    expect(made).toEqual(['01 Keys.wav', '02 Bass.wav']);
    expect(readdirSync(out).sort()).toEqual(made);
    expect(readFileSync(join(out, '02 Bass.wav'), 'utf8')).toBe('Bass:Bass');
  });

  it('renders every stem over the same stretch: the whole song, or the one it’s told', async () => {
    const p = song();
    // (the bass stops after a bar: its stem is still as long as the others)
    (p.tracks[1]?.regions[0] as { length: number }).length = BAR;
    const asked: { from: number; to: number }[] = [];
    const seen = async (_s: Project, _n: string, stretch: { from: number; to: number }) => {
      asked.push(stretch);
      return new Uint8Array(1);
    };
    await renderStems({ project: p, out: join(scratch(), 'a'), render: seen, log: () => {} });
    expect(asked).toEqual([
      { from: 0, to: BAR * 4 },
      { from: 0, to: BAR * 4 },
    ]);
    asked.length = 0;
    await renderStems({ project: p, out: join(scratch(), 'b'), from: BAR, to: BAR * 2, render: seen, log: () => {} });
    expect(asked[1]).toEqual({ from: BAR, to: BAR * 2 });
  });

  it('writes them into a ZIP when that’s what it’s given', async () => {
    const out = join(scratch(), 'Stems.zip');
    await renderStems({ project: song(), out, render, log: () => {} });
    const zip = new ZipFile(bytesAccess(new Uint8Array(readFileSync(out))));
    expect(zip.names()).toEqual(['01 Keys.wav', '02 Bass.wav']);
    expect(new TextDecoder().decode(zip.read('01 Keys.wav'))).toBe('Keys:Keys');
  });
});
