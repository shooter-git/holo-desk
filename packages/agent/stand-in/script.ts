/**
 * What a stand-in run does, read from the request it was given. A request that starts with `standin:`
 * is a script: steps separated by `;`, done in order.
 *
 *     standin: track_add {"name": "Bass"}; wait 500; finish Added a bass track
 *
 * - `TOOL {…}`: call one of HO[LO]'s tools, with its arguments as JSON (or none);
 * - `finish WORDS`: `finish` with those words as the reply (`finish {…}` gives its arguments whole);
 * - `wait MS`: do nothing for a while;
 * - `say WORDS`: write in the harness's own chat (which HO[LO] doesn't show);
 * - `fail WORDS`: end the turn as the harness ends one that failed, with those words as its error.
 *
 * Any other request reads the song and finishes, changing nothing: so does the one a turn is carried
 * on with when it ended without `finish`.
 */

export type Step =
  | { do: 'call'; tool: string; args: Record<string, unknown> }
  | { do: 'wait'; ms: number }
  | { do: 'say'; text: string }
  | { do: 'fail'; error: string };

export const MARK = 'standin:';

/** The longest a script may wait in one step. */
const MAX_WAIT_MS = 600_000;

const HEADING = '## The request\n';

/** The request in a prompt: what follows its last "## The request" (the whole prompt when it has none). */
export function requestOf(prompt: string): string {
  const at = prompt.lastIndexOf(HEADING);
  return (at < 0 ? prompt : prompt.slice(at + HEADING.length)).trim();
}

/** A script's steps as written: split at each `;` that isn't inside quotes, braces or brackets. */
export function splitSteps(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a run does when its request isn't a script. */
export const DEFAULT_STEPS: readonly Step[] = [
  { do: 'call', tool: 'song_status', args: {} },
  {
    do: 'call',
    tool: 'finish',
    args: { label: 'Stand-in', reply: 'The stand-in harness read the song and changed nothing.' },
  },
];

/** The steps of a request, or (a string) what's wrong with its script. */
export function parseScript(request: string): Step[] | string {
  const text = request.trim();
  if (!text.toLowerCase().startsWith(MARK)) return [...DEFAULT_STEPS];
  const steps: Step[] = [];
  for (const part of splitSteps(text.slice(MARK.length))) {
    const verb = /^[A-Za-z][A-Za-z0-9_-]*/.exec(part)?.[0] ?? '';
    const rest = part.slice(verb.length).trim();
    if (!verb) return `not a step: ${part}`;
    if (verb === 'wait') {
      const ms = Number(rest);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_WAIT_MS) return `wait takes milliseconds, up to ${MAX_WAIT_MS}`;
      steps.push({ do: 'wait', ms });
    } else if (verb === 'say') steps.push({ do: 'say', text: rest });
    else if (verb === 'fail') steps.push({ do: 'fail', error: rest || 'The stand-in was told to fail' });
    else if (verb === 'finish' && !rest.startsWith('{'))
      steps.push({ do: 'call', tool: 'finish', args: { label: 'Stand-in', reply: rest || 'Done.' } });
    else if (/^[a-z][a-z0-9_]*$/.test(verb)) {
      let args: unknown = {};
      if (rest) {
        try {
          args = JSON.parse(rest);
        } catch {
          return `${verb}'s arguments aren't JSON: ${rest}`;
        }
      }
      if (!isObject(args)) return `${verb}'s arguments are a JSON object`;
      steps.push({ do: 'call', tool: verb, args });
    } else return `not a step: ${part}`;
  }
  return steps.length ? steps : 'an empty script';
}
