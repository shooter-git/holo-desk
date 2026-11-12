/**
 * The studio's answers to more of the agent's requests over the live channel (docs/agent.md), each
 * area's in a module of its own. live.ts answers its own (`agent-ops`, `agent-played`, `agent-compare`…)
 * and hands any other `agent-…` type here.
 *
 * To answer one: the area's module calls `registerAgentRequest` as it loads, and live.ts loads it, from
 * the area's block among its imports. (This module never imports those: they register into it.) Plain,
 * with no browser in it.
 */

/** The studio's answer to the host's request: `{type: 'ack', id, ok, ...extra}`; `{error}` in `extra` when not ok. */
export type AgentAck = (ok: boolean, extra?: Record<string, unknown>) => void;

/** Answers one type of request: the message as it came (its `id` aside), and the answer to send, once. */
export type AgentRequestHandler = (msg: Record<string, unknown>, ack: AgentAck) => void | Promise<void>;

const handlers = new Map<string, AgentRequestHandler>();

/** The studio answers requests of `type` (an `agent-…` type, one handler each) with `handler`. */
export function registerAgentRequest(type: string, handler: AgentRequestHandler): void {
  if (!type.startsWith('agent-')) throw new Error(`${type} isn’t a type of the agent’s requests`);
  if (handlers.has(type)) throw new Error(`${type} already has its handler`);
  handlers.set(type, handler);
}

/**
 * Answers a request with its type's handler (false: none has it, and it goes unanswered). A handler
 * that fails is answered as not ok, with what went wrong.
 */
export async function answerAgentRequest(msg: Record<string, unknown>, ack: AgentAck): Promise<boolean> {
  const handler = typeof msg.type === 'string' ? handlers.get(msg.type) : undefined;
  if (!handler) return false;
  try {
    await handler(msg, ack);
  } catch (err) {
    ack(false, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
