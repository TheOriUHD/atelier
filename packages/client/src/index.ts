/**
 * What the app and the terminal share as clients of the backend (ARCHITECTURE §3): keeping a session's live state from
 * its snapshot and run events, and saying what tool calls did, how a run is going and what a diff changes. No DOM and no
 * React, so it runs in a browser, in Electron and in Node.
 */
export * from './live-state.ts';
export * from './live-sessions.ts';
export * from './live-context.ts';
export * from './turns.ts';
export * from './activity.ts';
export * from './tools.ts';
export * from './diff.ts';
export * from './paths.ts';
export * from './phase.ts';
export * from './search-result.ts';
export * from './ws-transport.ts';
