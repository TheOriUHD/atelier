/**
 * What a desktop app's server-mode process uses to lend this computer to a server (ARCHITECTURE §21): reaching SSH hosts
 * with this computer's ssh and runner builds, the same way its own backend does. A narrow entry, so that process doesn't
 * bundle the whole backend.
 */
export { bootstrapRunner, remoteRunnerChannel, sshConfigHosts, type RemoteShell } from './workspaces/ssh.ts';
export { probeSsh, runOnce, throughShell, writeAskpass } from './workspaces/ssh-access.ts';
export type { RunnerChannel } from './workspaces/runner-client.ts';
export { plainHttpFetch } from './providers/plain-http.ts';
export { detectLocalServers } from './providers/local-servers.ts';
// Personal connectors' programs, Claude Code's connectors and the person's home config, for a server (device services).
export { programChannel } from './mcp/line-transport.ts';
export { importClaudeCode } from './mcp/import.ts';
export { homeFs, scanHome, watchHome } from './extensions/home.ts';
export { interpolate } from './util/interpolate.ts';
