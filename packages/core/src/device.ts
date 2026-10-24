/**
 * What a desktop app's server-mode process uses to lend this computer to a server (ARCHITECTURE §21): reaching SSH hosts
 * with this computer's ssh and runner builds, the same way its own backend does. A narrow entry, so that process doesn't
 * bundle the whole backend.
 */
export { bootstrapRunner, remoteRunnerChannel, sshConfigHosts, type RemoteShell } from './workspaces/ssh.ts';
export { probeSsh, runOnce, throughShell, writeAskpass } from './workspaces/ssh-access.ts';
export type { RunnerChannel } from './workspaces/runner-client.ts';
