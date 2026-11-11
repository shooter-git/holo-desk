/**
 * @holo/agent: HO[LO]'s in-app agent. Its tools work on the open song through the job-scoped
 * endpoints only, and reach the harness through the MCP server in mcp.ts.
 */
export * from './api.ts';
export * from './args.ts';
export { createServer, PROTOCOL_VERSIONS, type Server, type ServerOptions, serveStdio, VERSION } from './mcp.ts';
export * from './tools/common.ts';
export { TOOLS, toolNamed } from './tools/index.ts';
export { notationLength, placeNotes } from './tools/notes.ts';
export { analyzePlayed, keyCandidates, playedText } from './tools/play.ts';
export { instrumentRef } from './tools/tracks.ts';
