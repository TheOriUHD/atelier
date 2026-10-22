/**
 * `pnpm --filter @atelier/core exec tsx evals/ssh.ts --host <ssh host> --model <provider>/<model> [--base-url <url>]`:
 * the M4 acceptance run against a real SSH host. On a throwaway backend (same code as the app) it adds the host with a
 * new folder under `~/atelier-ssh-check-<id>` as an SSH workspace, runs a Code session there that creates a file and
 * runs a command, opens a terminal in it, drops the connection and checks that the workspace comes back, then removes
 * the folder it made. What it leaves on the host: the runner build under `~/.atelier/runner/` (the app's own upload).
 * No sudo, no changes outside those two places. The key comes from the model's provider env var, like `pnpm eval`.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { contract, createMemoryTransportPair, createRpcClient, ProviderType, type PendingInteraction } from '@atelier/protocol';
import { createBackend } from '../src/index.ts';

const { values } = parseArgs({ options: { host: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' } } });
const host = values.host;
const ref = values.model;
const type = ProviderType.safeParse(ref?.slice(0, ref.indexOf('/')));
if (!host || !ref || !type.success) {
  console.error('Usage: tsx evals/ssh.ts --host <ssh host> --model <provider>/<model> [--base-url <url>]');
  process.exit(2);
}
const URLS: Partial<Record<ProviderType, string>> = { ollama: 'http://localhost:11434', anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' };
const KEYS: Partial<Record<ProviderType, string>> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
const baseUrl = values['base-url'] ?? URLS[type.data] ?? '';
const keyEnv = KEYS[type.data];

const ssh = (command: string) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], { encoding: 'utf8' });
const folder = `atelier-ssh-check-${Math.random().toString(36).slice(2, 8)}`;
const checks: { name: string; pass: boolean; notes: string }[] = [];
const check = (name: string, pass: boolean, notes = '') => {
  checks.push({ name, pass, notes });
  console.log(`${pass ? 'pass' : 'FAIL'}  ${name}${notes ? ` — ${notes}` : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'atelier-ssh-'));
await mkdir(join(root, 'home'));
// A hermetic HOME for the backend, but ssh still needs the real keys: it reads the real home through the system user.
const realHome = process.env.HOME!;
await writeFile(
  join(root, 'settings.json'),
  JSON.stringify({
    providers: [{ id: type.data, type: type.data, name: 'Check', baseUrl, ...(keyEnv && process.env[keyEnv] ? { apiKey: `\${${keyEnv}}` } : {}) }],
    models: { defaults: { chat: ref, code: ref, work: ref } },
  }),
);
const backend = await createBackend({
  surface: 'desktop',
  configDir: root,
  dataDir: join(root, 'data'),
  cipher: { encrypt: async (s) => s, decrypt: async (s) => s },
  env: { ...process.env, HOME: realHome },
  runnerDir: join(import.meta.dirname, '../../../runner/bin'),
  logger: { info: () => {}, error: (m, e) => console.error(m, e instanceof Error ? e.message : (e ?? '')) },
});
const [clientSide, serverSide] = createMemoryTransportPair();
backend.connect(serverSide, { client: { clientKind: 'desktop' } });
const rpc = createRpcClient(contract, clientSide);
await rpc.call('auth.setup', { username: 'check', name: 'Check', password: 'check-password-1', clientKind: 'desktop' });

let exitCode = 0;
try {
  const remoteHome = ssh('echo $HOME').stdout.trim();
  check('host answers over ssh', remoteHome.startsWith('/'), remoteHome);
  const made = ssh(`mkdir -p ~/${folder}`);
  check('check folder created on the host', made.status === 0, folder);

  // Upload the runner, connect, and open the folder as a workspace.
  const started = Date.now();
  const workspace = await rpc.call('workspaces.addSsh', { host, path: `${remoteHome}/${folder}` });
  check('runner uploaded and workspace opened', !!workspace.id, `${((Date.now() - started) / 1000).toFixed(1)}s`);
  check('runner is on the host', ssh('ls ~/.atelier/runner/*/atelier-runner').status === 0);

  // A Code session that writes a file and runs a command.
  const session = await rpc.call('sessions.create', { mode: 'code', model: ref, permissionMode: 'acceptEdits', workspaceId: workspace.id });
  const asked: string[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out after 5 minutes')), 5 * 60_000);
    let running = false;
    rpc.on('session.event', ({ sessionId, event }) => {
      if (sessionId !== session.id) return;
      if (event.type === 'pending' && event.pending) {
        const p: PendingInteraction = event.pending;
        asked.push(p.kind);
        void rpc.call('chat.respond', { sessionId, interactionId: p.id, answer: { behavior: 'allow' } }).catch(() => undefined);
      }
      if (event.type === 'status') {
        if (event.status === 'running') running = true;
        else if (running && (event.status === 'idle' || event.status === 'error')) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  await rpc.call('sessions.subscribe', { id: session.id });
  await rpc.call('chat.send', {
    sessionId: session.id,
    parts: [{ type: 'text', text: 'Create a file named hello.txt containing exactly the text "from atelier over ssh", then run `uname -s` and tell me what it printed.' }],
  });
  await finished;
  const content = ssh(`cat ~/${folder}/hello.txt`);
  check('the model wrote the file on the host', content.stdout.trim() === 'from atelier over ssh', JSON.stringify(content.stdout.slice(0, 80)));
  const snapshot = await rpc.call('sessions.subscribe', { id: session.id });
  const replies = snapshot.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []))).join(' ');
  check('the command ran on the host, not here', /linux/i.test(replies), replies.slice(-120));

  // The terminal opens on the host and runs a command.
  const out: string[] = [];
  rpc.on('terminals.data', ({ data }) => out.push(data));
  const { terminalId } = await rpc.call('terminals.open', { workspaceId: workspace.id, cols: 80, rows: 24 });
  await rpc.call('terminals.write', { terminalId, data: 'echo "term-$(uname -s)-ok"; pwd\n' });
  for (const deadline = Date.now() + 15_000; !out.join('').includes('term-Linux-ok') && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 200));
  const shown = out.join('');
  check('terminal runs on the host, in the folder', shown.includes('term-Linux-ok') && shown.includes(folder), shown.replace(/\s+/g, ' ').slice(-100));
  await rpc.call('terminals.close', { terminalId });
} catch (error) {
  exitCode = 1;
  check('run completed', false, error instanceof Error ? error.message : String(error));
} finally {
  // Only the folder this run made, named with its random id.
  if (/^atelier-ssh-check-[a-z0-9]{6}$/.test(folder)) ssh(`rm -rf ~/${folder}`);
  await backend.dispose().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(exitCode || (failed.length ? 1 : 0));
