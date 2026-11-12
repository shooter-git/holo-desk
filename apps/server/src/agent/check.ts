/**
 * Checking what comes in to the agent's routes (routes.ts, and the job-scoped routes in job-routes/):
 * a body's fields, lines and texts of a length, numbers in a range, ids of the shapes HO[LO] makes. A
 * check that fails throws a 400 Refusal, which the route answers as `{error}`.
 */
import type { FastifyRequest } from 'fastify';
import { Refusal } from './jobs.ts';

export type Body = Record<string, unknown>;
export type Params = Record<string, string>;

export const isObj = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);
export const bad = (message: string) => new Refusal(400, message);
/** Control characters (tabs and line breaks aside). */
export const CONTROL = /(?![\t\n])\p{Cc}/u;
export const ID = /^[\w-]{1,64}$/;

/** A body's fields (none: an empty one). */
export function body(req: FastifyRequest): Body {
  if (req.body === undefined || req.body === null) return {};
  if (!isObj(req.body)) throw bad('The body is a JSON object');
  return req.body;
}

/** A line of text: trimmed, 1 to `max` characters, no line breaks or control characters. */
export function line(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') throw bad(`${what} is text`);
  const text = v.trim();
  if (!text || text.length > max || CONTROL.test(text) || /[\n\r]/.test(text))
    throw bad(`${what} is one line of at most ${max} characters`);
  return text;
}

/** Text that may run over several lines: trimmed, 1 to `max` characters. */
export function text(v: unknown, what: string, max: number, optional = false): string {
  if (optional && (v === undefined || v === null || v === '')) return '';
  if (typeof v !== 'string') throw bad(`${what} is text`);
  const t = v.replace(/\r\n?/g, '\n').trim();
  if ((!t && !optional) || t.length > max || CONTROL.test(t)) throw bad(`${what} is at most ${max} characters`);
  return t;
}

export function int(v: unknown, what: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi)
    throw bad(`${what} is a whole number from ${lo} to ${hi}`);
  return v;
}

export function num(v: unknown, what: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw bad(`${what} is a number from ${lo} to ${hi}`);
  return v;
}
