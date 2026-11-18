import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, without types
import { codexReport, featureStages } from '../codex-check.mjs';

const FIXTURES = join(import.meta.dirname, '..', '..', 'packages', 'agent', 'test', 'fixtures');
const promptInput = (name: string) => readFileSync(join(FIXTURES, `codex-prompt-input-${name}.json`), 'utf8');

/** `codex features list` as Codex prints it: name, stage, whether it's on. */
const FEATURES = [
  'apps                                     stable             true',
  'browser_use                              stable             true',
  'code_mode                                under development  false',
  'plugin_discovery_prefetch                removed            false',
  'shell_tool                               stable             true',
].join('\n');

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });

describe('the daily Codex check', () => {
  it('passes a Codex whose model gets only the tools HO[LO] allows', () => {
    const r = codexReport({ version: '0.170.0', channel: 'release', probe: ok(promptInput('sealed')), features: null });
    expect(r).toEqual({
      sealed: true,
      title: '',
      body: 'Codex 0.170.0 (release) can be sealed: the model gets only the tools HO[LO] allows.',
    });
  });

  it('names every tool HO[LO] doesn’t know, with a title that leaves out the version', () => {
    const r = codexReport({
      version: '0.171.0-alpha.3',
      channel: 'test build',
      probe: ok(promptInput('loose')),
      features: null,
    });
    expect(r.sealed).toBe(false);
    expect(r.title).toMatch(/^Codex gives the model tools HO\[LO\] doesn't know: /);
    expect(r.title).not.toContain('0.171.0');
    expect(r.title.length).toBeLessThanOrEqual(200);
    expect(r.body).toContain("**Codex 0.171.0-alpha.3 (test build) gives the model tools HO[LO] doesn't know**");
    // the loose fixture's tools, every one listed in the body
    for (const t of ['exec_command', 'write_stdin', 'view_image']) expect(r.body).toContain(`- \`${t}\``);
  });

  it('refuses a Codex that stops before listing its tools, with what it said', () => {
    const r = codexReport({
      version: '0.172.0',
      channel: 'release',
      probe: {
        status: 1,
        stdout: '',
        stderr: 'WARNING: something harmless\nError: Unknown feature flag: shell_tool\n',
      },
      features: null,
    });
    expect(r.sealed).toBe(false);
    expect(r.title).toBe("Codex couldn't list its tools: Error: Unknown feature flag: shell_tool");
    expect(r.body).toContain('Error: Unknown feature flag: shell_tool');
    expect(r.body).not.toContain('WARNING');
  });

  it('refuses output that isn’t a tool list', () => {
    const r = codexReport({ version: '0.172.0', channel: 'release', probe: ok('not json'), features: null });
    expect(r).toMatchObject({ sealed: false, title: "Codex didn't list its tools" });
  });

  it('points out switched-off features that Codex removed or doesn’t know, without failing', () => {
    const r = codexReport({
      version: '0.170.0',
      channel: 'release',
      probe: ok(promptInput('sealed')),
      features: FEATURES,
    });
    expect(r.sealed).toBe(true);
    expect(r.body).toContain('`plugin_discovery_prefetch`');
    // not on Codex's list at all
    expect(r.body).toContain('`multi_agent`');
    // on it and not removed
    expect(r.body).not.toContain('`shell_tool`');
    expect(r.body).not.toContain('`browser_use`,');
  });

  it('reads stages of more than one word', () => {
    expect(featureStages(FEATURES).get('code_mode')).toBe('under development');
    expect(featureStages('').size).toBe(0);
  });
});
