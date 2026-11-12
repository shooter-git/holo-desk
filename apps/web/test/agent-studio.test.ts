import { describe, expect, it } from 'vitest';
import { type AgentAck, answerAgentRequest, registerAgentRequest } from '../src/app/agent-studio.ts';

describe('the studio’s answers to more of the agent’s requests', () => {
  it('answers a type with its handler, says when none has it, and answers a failure as not ok', async () => {
    const acks: [boolean, Record<string, unknown> | undefined][] = [];
    const ack: AgentAck = (ok, extra) => acks.push([ok, extra]);
    registerAgentRequest('agent-test-echo', (msg, answer) => answer(true, { said: msg.text }));
    registerAgentRequest('agent-test-fails', async () => {
      throw new Error('no meters here');
    });

    expect(await answerAgentRequest({ type: 'agent-test-echo', id: 'r1', text: 'hi' }, ack)).toBe(true);
    expect(await answerAgentRequest({ type: 'agent-test-fails', id: 'r2' }, ack)).toBe(true);
    expect(await answerAgentRequest({ type: 'agent-test-unknown', id: 'r3' }, ack)).toBe(false);
    expect(acks).toEqual([
      [true, { said: 'hi' }],
      [false, { error: 'no meters here' }],
    ]);

    // one handler a type, and only the agent's types
    expect(() => registerAgentRequest('agent-test-echo', () => undefined)).toThrow('already has its handler');
    expect(() => registerAgentRequest('ops', () => undefined)).toThrow('isn’t a type of the agent’s requests');
  });
});
