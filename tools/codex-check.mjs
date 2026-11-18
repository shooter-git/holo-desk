// Whether HO[LO] can still seal a given Codex (docs/agent-harnesses.md, "Codex"), checked the way the
// runner checks it: `codex debug prompt-input` with a run's switches, in an empty CODEX_HOME. Nothing
// signs in and no model is called. .github/workflows/codex-check.yml runs it every day against Codex's
// newest release and newest test build, so a Codex that HO[LO] would refuse is found before users update.
//
//   node tools/codex-check.mjs <path to codex> [release | test build]
//
// Prints what it found as Markdown (and, on GitHub, as the job's summary, with a title and body for an
// issue). Exits 1 when HO[LO] would refuse this Codex.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODEX_DISABLED, codexExtraTools, codexProbeArgs } from '../packages/agent/src/harness/codex.ts';

const code = (s) => `\`${s}\``;

/** Feature names in `codex features list` (name, stage, on), with their stage. */
export function featureStages(stdout) {
  const stages = new Map();
  for (const line of stdout.split('\n')) {
    const [name, stage, on] = line.trim().split(/\s{2,}/);
    if (name && stage && on) stages.set(name, stage);
  }
  return stages;
}

/**
 * What the check found. The title names the finding but not the version, so the daily run adds to one
 * open issue per finding instead of opening one for every Codex build that has it.
 */
export function codexReport({ version, channel, probe, features }) {
  const which = `Codex ${version} (${channel})`;
  const lines = [];
  let title = '';
  if (probe.status !== 0) {
    const said = probe.stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('WARNING'));
    if (!said.length) said.push(probe.status === null ? 'it was stopped or never started' : `exit ${probe.status}`);
    title = `Codex couldn't list its tools: ${(said.at(-1) ?? '').slice(0, 120)}`;
    lines.push(`**${which} couldn't list its tools**, so HO[LO] would refuse it.`, '', '```', ...said.slice(-8), '```');
  } else {
    const extra = codexExtraTools(probe.stdout);
    if (!extra) {
      title = "Codex didn't list its tools";
      lines.push(`**${which} didn't list its tools**, so HO[LO] would refuse it.`);
    } else if (extra.length) {
      title = `Codex gives the model tools HO[LO] doesn't know: ${extra.join(', ')}`.slice(0, 200);
      lines.push(
        `**${which} gives the model tools HO[LO] doesn't know**, so HO[LO] would refuse it:`,
        '',
        ...extra.map((t) => `- ${code(t)}`),
        '',
        'For each, find out what it can do: `codex debug prompt-input` with the switches in',
        '`docs/agent-harnesses.md` ("Codex") shows its description. Turn it off with a setting if there is one;',
        "allow it in `packages/agent/src/harness/codex.ts` only if it can't reach files, commands or the network.",
      );
    } else {
      lines.push(`${which} can be sealed: the model gets only the tools HO[LO] allows.`);
    }
  }
  if (features !== null) {
    const stages = featureStages(features);
    const gone = CODEX_DISABLED.filter((f) => !stages.has(f) || stages.get(f) === 'removed');
    if (gone.length)
      lines.push(
        '',
        `HO[LO] switches off features this Codex has removed or doesn't know: ${gone.map(code).join(', ')}.`,
        "That's harmless (a setting for an unknown feature is ignored); they can leave `CODEX_DISABLED` once no",
        'Codex in use has them.',
      );
  }
  return { sealed: !title, title, body: lines.join('\n') };
}

/** Appends a (possibly multi-line) output for the next steps of a GitHub job. */
function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const end = `END_${Math.random().toString(36).slice(2)}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${end}\n${value}\n${end}\n`);
}

function main() {
  const [bin, channel = 'release'] = process.argv.slice(2);
  if (!bin) {
    console.error('Usage: node tools/codex-check.mjs <path to codex> [release | test build]');
    process.exit(2);
  }
  // an empty CODEX_HOME (and HOME) of its own: nobody's config, sign-in or MCP servers
  const home = mkdtempSync(join(tmpdir(), 'codex-check-'));
  const run = (args) =>
    spawnSync(bin, args, {
      cwd: home,
      env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: home, LANG: 'C.UTF-8' },
      encoding: 'utf8',
      timeout: 60_000,
    });
  try {
    const version = /\d+\.\d+\.\d+[\w.-]*/.exec(run(['--version']).stdout)?.[0] ?? 'of unknown version';
    const probe = run(codexProbeArgs());
    const list = run(['features', 'list']);
    const r = codexReport({
      version,
      channel,
      probe: { status: probe.status, stdout: probe.stdout ?? '', stderr: probe.stderr ?? String(probe.error ?? '') },
      features: list.status === 0 ? list.stdout : null,
    });
    console.log(r.body);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${r.body}\n`);
    output('version', version);
    output('title', r.title);
    output('body', r.body);
    process.exitCode = r.sealed ? 0 : 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
