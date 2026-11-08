/**
 * What a client that lends its computer to a server uses (ARCHITECTURE §21): the desktop app's server-mode process and
 * the terminal app's background service. Reaching SSH hosts with this computer's ssh and runner builds, the device link
 * and its services, the person's consent per server (`lending.json`), and finding and checking servers. A narrow entry,
 * so those processes don't bundle the whole backend.
 */
export { bootstrapRunner, remoteRunnerChannel, sshConfigHosts, type RemoteShell } from './workspaces/ssh.ts';
export { probeSsh, runOnce, throughShell, writeAskpass } from './workspaces/ssh-access.ts';
export type { RunnerChannel } from './workspaces/runner-client.ts';
export { plainHttpFetch } from './providers/plain-http.ts';
export { detectLocalServers } from './providers/local-servers.ts';
export { detectImageServers } from './images/detect.ts';
// Personal connectors' programs, Claude Code's connectors and the person's home config, for a server (device services).
export { programChannel } from './mcp/line-transport.ts';
export { importClaudeCode } from './mcp/import.ts';
export { homeFs, scanHome, watchHome } from './extensions/home.ts';
export { interpolate } from './util/interpolate.ts';
export { networkCode } from './util/network-error.ts';
// The device link, what it lends, and the person's say-so for each server.
export { backoff } from './device/backoff.ts';
export { createDeviceLink, insideTrusted, readTrustedFolders, trustedPath, type DeviceLinkOptions, type DeviceLinkState } from './device/link.ts';
export { deviceServices, lentHeaders, Refusal, withinAddress, withinSocketAddress, type DeviceServices, type DeviceServicesOptions } from './device/services.ts';
export { applyLending, changeLending, connectorFingerprint, LendingChange, readLending } from './device/lending.ts';
// Finding a server and saying what's wrong with the way to it.
export { isPrivateHost, parseConnection, type Connection } from './device/connection.ts';
export { GUESS_TIMEOUT_MS, healthCheck, resolveConnection, resolveServer, type HealthCheck, type ServerConnection } from './device/server-url.ts';
export { DEFAULT_PORT, localSubnets, scanNetwork, type FoundServer, type Interfaces, type ScanOptions } from './device/discovery.ts';
export { describeFailure, diagnose, type LinkProblem } from './device/link-problem.ts';
