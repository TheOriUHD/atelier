/**
 * Utility process entry for server mode: there is no local backend. Each renderer connection is relayed
 * to the server named in argv, and the device link lends this machine's runner for trusted folders
 * (ARCHITECTURE §21).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DeviceInfo, runnerBinaryName } from '@atelier/protocol';
import type { BackendToMain, MainToBackend } from './bridge.ts';
import { createDeviceLink, readTrustedFolders } from './device-link.ts';
import { diagnose, type LinkProblem } from './link-problem.ts';
import { createRelay } from './relay.ts';

const serverUrl = process.argv[2]!;

/** What is wrong with the way to the server, for the window's "Connecting…" screen; null once it connects. Said once, not on every retry. */
let said = '';
let diagnosing = false;
let diagnosedAt = 0;
const report = (problem: LinkProblem | null) => {
  const key = problem ? `${problem.code}|${problem.message}` : '';
  if (key === said) return;
  said = key;
  process.parentPort.postMessage({ kind: 'link', problem } satisfies BackendToMain);
};
const relay = createRelay(serverUrl, undefined, {
  up: () => report(null),
  failed: (failures) => {
    // The socket's own error says nothing; one plain request to the same address says what it is. Not on the first
    // failure (a restarting server fixes itself), and not more than every 15 seconds.
    if (failures < 2 || diagnosing || Date.now() - diagnosedAt < 15_000) return;
    diagnosing = true;
    void diagnose(serverUrl)
      .then(report)
      .finally(() => {
        diagnosing = false;
        diagnosedAt = Date.now();
      });
  },
});
const runnerDir = process.env.ATELIER_RUNNER_DIR;
const runnerBinary = runnerDir ? join(runnerDir, runnerBinaryName(process.platform, process.arch)) : null;
const deviceLink = createDeviceLink({
  serverUrl,
  device: DeviceInfo.parse(JSON.parse(process.argv[3]!)),
  runnerBinary: runnerBinary && existsSync(runnerBinary) ? runnerBinary : null,
  trustedFolders: () => readTrustedFolders(process.env.ATELIER_TRUSTED_FOLDERS!),
});

process.parentPort.on('message', (event: { data: MainToBackend; ports: Electron.MessagePortMain[] }) => {
  const m = event.data;
  if (m.kind === 'connect' && event.ports[0]) relay.link(event.ports[0], m.token);
  else if (m.kind === 'token') deviceLink.setToken(m.token);
  else if (m.kind === 'shutdown') {
    deviceLink.close();
    process.exit(0);
  }
});

process.parentPort.postMessage({ kind: 'ready' } satisfies BackendToMain);
