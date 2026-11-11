/**
 * A tool's arguments, declared once: the JSON Schema the harness shows the model, and the check that
 * runs on what the model actually sends. Models send numbers as strings and booleans as words now
 * and then, so the check forgives those, and says plainly what's wrong with anything else.
 */

export type ArgType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'object' | 'array' | 'json';

export interface ArgDef {
  name: string;
  type: ArgType;
  /** What it is, for the model: units and an example. */
  describe: string;
  required?: boolean;
  /** An enum's values. */
  values?: readonly string[];
  /** A number's range. */
  min?: number;
  max?: number;
  /** A string's longest length, or an array's most items. */
  maxLength?: number;
  /** An array's items, when they're all one kind. */
  items?: 'string' | 'number' | 'object';
  /** Used when the argument is left out. */
  default?: unknown;
}

export type Args = Record<string, unknown>;

export type CheckResult = { ok: true; args: Args } | { ok: false; errors: string[] };

type Schema = Record<string, unknown>;

function propertySchema(def: ArgDef): Schema {
  const out: Schema = {};
  switch (def.type) {
    case 'string':
      out.type = 'string';
      if (def.maxLength !== undefined) out.maxLength = def.maxLength;
      break;
    case 'number':
    case 'integer':
      out.type = def.type;
      if (def.min !== undefined) out.minimum = def.min;
      if (def.max !== undefined) out.maximum = def.max;
      break;
    case 'boolean':
      out.type = 'boolean';
      break;
    case 'enum':
      out.type = 'string';
      out.enum = [...(def.values ?? [])];
      break;
    case 'object':
      out.type = 'object';
      break;
    case 'array':
      out.type = 'array';
      if (def.items) out.items = { type: def.items };
      if (def.maxLength !== undefined) out.maxItems = def.maxLength;
      break;
    case 'json':
      // any JSON value: no type keyword at all
      break;
  }
  out.description = def.describe;
  if (def.default !== undefined) out.default = def.default;
  return out;
}

/** The input schema of a tool (JSON Schema, draft-07 keywords only). */
export function toJsonSchema(defs: readonly ArgDef[]): Schema {
  const properties: Record<string, Schema> = {};
  for (const d of defs) properties[d.name] = propertySchema(d);
  const required = defs.filter((d) => d.required).map((d) => d.name);
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const NUMERIC = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

/** A value as one argument's type, or why it isn't. */
function coerce(def: ArgDef, value: unknown): { value: unknown } | { error: string } {
  const name = `"${def.name}"`;
  switch (def.type) {
    case 'string': {
      const s = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
      if (typeof s !== 'string') return { error: `${name} must be text` };
      if (def.maxLength !== undefined && s.length > def.maxLength)
        return { error: `${name} is ${s.length} characters long; at most ${def.maxLength}` };
      return { value: s };
    }
    case 'number':
    case 'integer': {
      const n = typeof value === 'string' && NUMERIC.test(value) ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n))
        return { error: `${name} must be a ${def.type === 'integer' ? 'whole number' : 'number'}` };
      if (def.type === 'integer' && !Number.isInteger(n)) return { error: `${name} must be a whole number` };
      if (def.min !== undefined && n < def.min) return { error: `${name} must be at least ${def.min} (got ${n})` };
      if (def.max !== undefined && n > def.max) return { error: `${name} must be at most ${def.max} (got ${n})` };
      return { value: n };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { value };
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim()))
        return { value: value.trim().toLowerCase() === 'true' };
      return { error: `${name} must be true or false` };
    }
    case 'enum': {
      const values = def.values ?? [];
      const s = typeof value === 'number' ? String(value) : value;
      if (typeof s === 'string') {
        if (values.includes(s)) return { value: s };
        // the same word in other capitals is meant
        const lower = s.trim().toLowerCase();
        const found = values.find((v) => v.toLowerCase() === lower);
        if (found !== undefined) return { value: found };
      }
      return { error: `${name} must be one of ${values.map((v) => `"${v}"`).join(', ')}` };
    }
    case 'object': {
      const v = typeof value === 'string' && value.trim().startsWith('{') ? parseJson(value) : value;
      if (!isPlainObject(v)) return { error: `${name} must be an object, e.g. {"key": 1}` };
      return { value: v };
    }
    case 'array': {
      const v = typeof value === 'string' && value.trim().startsWith('[') ? parseJson(value) : value;
      if (!Array.isArray(v)) return { error: `${name} must be a list, e.g. [1, 2]` };
      if (def.maxLength !== undefined && v.length > def.maxLength)
        return { error: `${name} has ${v.length} items; at most ${def.maxLength}` };
      if (def.items) {
        const bad = v.findIndex((x) =>
          def.items === 'object'
            ? !isPlainObject(x)
            : typeof x !== def.items || (def.items === 'number' && !Number.isFinite(x)),
        );
        if (bad >= 0)
          return { error: `${name}[${bad}] must be ${def.items === 'object' ? 'an object' : `a ${def.items}`}` };
      }
      return { value: v };
    }
    case 'json':
      return { value };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The model's arguments checked against a tool's: coerced where the intent is plain, defaults filled
 * in, and every problem listed at once so one retry can fix them all.
 */
export function check(defs: readonly ArgDef[], input: unknown): CheckResult {
  const given = input === undefined || input === null ? {} : input;
  if (!isPlainObject(given)) return { ok: false, errors: ['The arguments must be an object of named fields'] };
  const errors: string[] = [];
  const args: Args = {};
  const known = new Set(defs.map((d) => d.name));
  for (const key of Object.keys(given)) {
    if (!known.has(key)) {
      errors.push(
        `Unknown field "${key}"${known.size ? `; the fields are ${[...known].map((k) => `"${k}"`).join(', ')}` : '; this tool takes none'}`,
      );
    }
  }
  for (const def of defs) {
    const raw = given[def.name];
    // a null says "not given", as some models write optional fields
    if (raw === undefined || raw === null) {
      if (def.default !== undefined) args[def.name] = def.default;
      else if (def.required) errors.push(`"${def.name}" is required: ${def.describe}`);
      continue;
    }
    const out = coerce(def, raw);
    if ('error' in out) errors.push(out.error);
    else args[def.name] = out.value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, args };
}
