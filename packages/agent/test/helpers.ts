/**
 * What the tools' tests share: a small song, a fake job API over it, and calling a tool as the MCP
 * server does (its arguments checked first, and a memory kept for each fake, as for a run).
 */
import { type MiddleC, newProject, newRegion, newTrack, type Op, PPQ, type Project, type Region } from '@holo/session';
import { expect } from 'vitest';
import { type FakeJobApi, type FakeJobApiOptions, fakeJobApi } from '../src/api.ts';
import { check } from '../src/args.ts';
import { newMemory, ToolError, type ToolMemory, type ToolResult } from '../src/tools/common.ts';
import { toolNamed } from '../src/tools/index.ts';

export const BAR = PPQ * 4;

/** Keys (empty), Strings (bars 1–4 with three notes, and bars 7–8), Bass (empty), Strummed (empty). */
export function song(): Project {
  const p = newProject('Test song');
  const strings = newTrack('Strings', { type: 'synth', preset: 'Warm Pad' });
  const a: Region = { ...newRegion(0, BAR * 4, 'A'), id: 'rgn_a' };
  a.notes = [
    { t: 0, d: PPQ, p: 60, v: 80 },
    { t: BAR, d: PPQ, p: 62, v: 80 },
    { t: BAR * 2, d: PPQ, p: 64, v: 80 },
  ];
  const b: Region = { ...newRegion(BAR * 6, BAR * 2, 'B'), id: 'rgn_b' };
  strings.regions.push(a, b);
  strings.id = 'trk_strings';
  const bass = { ...newTrack('Bass', { type: 'synth', preset: 'Fat Mono' }), id: 'trk_bass' };
  const strummed = { ...newTrack('Strummed', { type: 'synth', preset: 'Soft Keys' }), id: 'trk_strum' };
  p.tracks.push(strings, bass, strummed);
  return p;
}

export function setup(options: FakeJobApiOptions = {}): FakeJobApi {
  return fakeJobApi(song(), options);
}

/** Each fake's memory: as the MCP server keeps one for a run, a test keeps one for its fake. */
const memories = new WeakMap<FakeJobApi, ToolMemory>();
export const memoryOf = (api: FakeJobApi): ToolMemory => {
  const m = memories.get(api) ?? newMemory();
  memories.set(api, m);
  return m;
};

export async function call(
  api: FakeJobApi,
  name: string,
  args: unknown = {},
  middleC: MiddleC = 'C4',
): Promise<ToolResult> {
  const tool = toolNamed(name);
  if (!tool) throw new Error(`no tool ${name}`);
  const checked = check(tool.args, args);
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  return tool.run({ api, middleC, memory: memoryOf(api) }, checked.args);
}

export async function refused(api: FakeJobApi, name: string, args: unknown): Promise<string> {
  try {
    await call(api, name, args);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return (err as Error).message;
  }
  throw new Error(`${name} wasn't refused`);
}

export const lastOps = (api: FakeJobApi): Op[] => api.batches.at(-1)?.ops ?? [];
export const allOps = (api: FakeJobApi): Op[] => api.batches.flatMap((b) => b.ops);
