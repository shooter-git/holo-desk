/**
 * The agent asks which of the studio's commands a button in its reply can run (`agent-commands`):
 * the bar's own, by id and title, those it can run now. The bar's list is the one list, so a command
 * added to it is the agent's to use too.
 */
import { registerAgentRequest } from './agent-studio.ts';
import { studioCommands } from './bar-actions.ts';

registerAgentRequest('agent-commands', (_msg, ack) => {
  ack(true, { commands: studioCommands().map((c) => ({ id: c.id, title: c.title })) });
});
