import { describe, expect, it } from 'vitest';
import { type ArgDef, check, toJsonSchema } from '../src/args.ts';

const defs: ArgDef[] = [
  { name: 'track', type: 'string', describe: 'The track', required: true, maxLength: 10 },
  { name: 'volume', type: 'number', describe: 'dB', min: -60, max: 12 },
  { name: 'staves', type: 'integer', describe: 'How many', min: 1, max: 4 },
  { name: 'replace', type: 'boolean', describe: 'Replace', default: false },
  { name: 'unit', type: 'enum', values: ['1/8', '1/16', '1/4T'], describe: 'Unit', default: '1/8' },
  { name: 'knobs', type: 'object', describe: 'Knobs' },
  { name: 'ops', type: 'array', items: 'object', describe: 'Ops', maxLength: 2 },
  { name: 'meta', type: 'json', describe: 'Anything' },
];

describe('input schemas', () => {
  const schema = toJsonSchema(defs) as {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };

  it('is an object of described fields, closed to others', () => {
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['track']);
    for (const d of defs) expect(schema.properties[d.name]?.description).toBe(d.describe);
  });

  it('carries types, ranges, lengths, enums and defaults', () => {
    expect(schema.properties.track).toMatchObject({ type: 'string', maxLength: 10 });
    expect(schema.properties.volume).toMatchObject({ type: 'number', minimum: -60, maximum: 12 });
    expect(schema.properties.staves).toMatchObject({ type: 'integer', minimum: 1, maximum: 4 });
    expect(schema.properties.replace).toMatchObject({ type: 'boolean', default: false });
    expect(schema.properties.unit).toMatchObject({ type: 'string', enum: ['1/8', '1/16', '1/4T'], default: '1/8' });
    expect(schema.properties.knobs).toMatchObject({ type: 'object' });
    expect(schema.properties.ops).toMatchObject({ type: 'array', items: { type: 'object' }, maxItems: 2 });
    // any JSON value: no type at all
    expect(schema.properties.meta?.type).toBeUndefined();
  });

  it('leaves "required" out when nothing is', () => {
    expect(toJsonSchema([{ name: 'a', type: 'string', describe: 'A' }])).not.toHaveProperty('required');
    expect(toJsonSchema([])).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});

describe('checking arguments', () => {
  it('passes good arguments and fills in defaults', () => {
    const r = check(defs, { track: 'Keys', volume: -6 });
    expect(r).toEqual({ ok: true, args: { track: 'Keys', volume: -6, replace: false, unit: '1/8' } });
  });

  it('forgives numbers and booleans sent as text', () => {
    const r = check(defs, { track: 'Keys', volume: '-6.5', staves: '2', replace: 'TRUE' });
    expect(r.ok && r.args).toMatchObject({ volume: -6.5, staves: 2, replace: true });
    // and a number where text is wanted
    expect(check(defs, { track: 7 })).toMatchObject({ ok: true, args: { track: '7' } });
  });

  it('forgives an enum in other capitals, and objects or lists sent as JSON text', () => {
    const r = check(defs, { track: 'K', unit: '1/4t', knobs: '{"cutoff": 500}', ops: '[{"op": "x"}]' });
    expect(r.ok && r.args).toMatchObject({ unit: '1/4T', knobs: { cutoff: 500 }, ops: [{ op: 'x' }] });
  });

  it('takes null as left out', () => {
    expect(check(defs, { track: 'Keys', volume: null })).toMatchObject({ ok: true, args: { track: 'Keys' } });
    expect(check(defs, null)).toMatchObject({ ok: false });
    expect(check([], undefined)).toEqual({ ok: true, args: {} });
  });

  it('refuses unknown fields, naming the real ones', () => {
    const r = check(defs, { track: 'Keys', colour: 'red' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Unknown field "colour".*"track"/);
    const none = check([], { x: 1 });
    expect(!none.ok && none.errors[0]).toMatch(/takes none/);
  });

  it('says what is missing, out of range or of the wrong kind, all at once', () => {
    const r = check(defs, {
      volume: 20,
      staves: 2.5,
      replace: 'maybe',
      unit: '1/5',
      knobs: [1],
      ops: [{}, {}, {}],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      '"track" is required: The track',
      '"volume" must be at most 12 (got 20)',
      '"staves" must be a whole number',
      '"replace" must be true or false',
      '"unit" must be one of "1/8", "1/16", "1/4T"',
      '"knobs" must be an object, e.g. {"key": 1}',
      '"ops" has 3 items; at most 2',
    ]);
  });

  it('checks lengths, low ends and list items', () => {
    const r = check(defs, { track: 'a very long name', volume: -61, ops: [1] });
    expect(!r.ok && r.errors).toEqual([
      '"track" is 16 characters long; at most 10',
      '"volume" must be at least -60 (got -61)',
      '"ops"[0] must be an object',
    ]);
    expect(check(defs, { track: 'x', volume: 'loud' })).toMatchObject({
      ok: false,
      errors: ['"volume" must be a number'],
    });
    expect(check(defs, { track: 'x', volume: Number.NaN })).toMatchObject({ ok: false });
  });

  it('takes anything for a json field', () => {
    expect(check(defs, { track: 'x', meta: [1, { a: null }] })).toMatchObject({
      ok: true,
      args: { meta: [1, { a: null }] },
    });
  });
});
