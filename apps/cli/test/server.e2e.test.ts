/**
 * The terminal app with an Atelier server, end to end: the wizard finds the server by its address, the terminal signs
 * in through the browser flow (the test approves its code as the admin, as the /link page does), the folder is lent to
 * the server through the background service's device link, and a tool call the server's agent makes writes the file
 * here. Then print mode against the same server, and logging out. Needs the CLI bundle, the server bundle
 * (`pnpm --filter @atelier/server build`) and the runner; skipped without them.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { contract, createRpcClient, type AppContract, type RpcClient } from '@atelier/protocol';
import { wsTransport } from '@atelier/client';
import { BUNDLE, canRun, cliCommand, ended, openScreen, removeAll, type Screen } from './harness.ts';

const SERVER = join(import.meta.dirname, '../../server/dist/server.mjs');
const ready = () => canRun() && existsSync(SERVER);
const show = (title: string, s: Screen) => process.env.SHOW_SCREENS && console.log(`\n===== ${title} =====\n${s.text()}\n`);
const base = 12000 + Math.floor(Math.random() * 2000);
const [ollamaPort, webPort] = [base, base + 1];
const serverUrl = `http://127.0.0.1:${webPort}`;
let home: string;
let project: string;
let children: ChildProcess[] = [];
let admin: RpcClient<AppContract>;
let closeAdmin = () => {};

const env = () => ({ ...process.env, ATELIER_NO_BROWSER: '1', HOME: home, USERPROFILE: home, ATELIER_CLI_DIR: join(home, '.atelier', 'cli'), ATELIER_CLI_CREDENTIALS: 'file', ATELIER_COOP_RELAY: '' });

beforeAll(async () => {
  if (!ready()) return;
  home = realpathSync(await mkdtemp(join(tmpdir(), 'atelier-cli-server-')));
  project = join(home, 'shader');
  const data = join(home, 'server-data');
  await mkdir(project);
  await mkdir(data);
  execFileSync('git', ['init', '-q'], { cwd: project });
  await writeFile(join(data, 'settings.json'), JSON.stringify({ providers: [{ id: 'fake', type: 'ollama', name: 'Fake Ollama', baseUrl: `http://127.0.0.1:${ollamaPort}` }], models: { defaults: { code: 'fake/fake-chat:8b' } } }));
  children = [
    spawn(process.execPath, [join(import.meta.dirname, '../../../e2e/fake-ollama.mjs'), String(ollamaPort)], { stdio: 'ignore' }),
    spawn(process.execPath, [SERVER], { stdio: 'ignore', env: { ...process.env, ATELIER_DATA_DIR: data, ATELIER_PORT: String(webPort), ATELIER_SETUP_TOKEN: 'cli-e2e-setup', ATELIER_COOP_RELAY: '' } }),
  ];
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${serverUrl}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // The admin, as someone signed in in a browser would be.
  const transport = wsTransport({ serverUrl, headers: () => ({}) });
  admin = createRpcClient(contract, transport);
  closeAdmin = () => transport.close();
  await admin.call('auth.setup', { username: 'ada', name: 'Ada', password: 'ada-password-1', clientKind: 'web', setupToken: 'cli-e2e-setup' });
});

afterAll(async () => {
  closeAdmin();
  if (home) {
    try {
      execFileSync(process.execPath, [BUNDLE, 'daemon', 'stop', '--force'], { env: env(), timeout: 10_000 });
    } catch {
      // Not running.
    }
  }
  await Promise.all(children.map(ended));
  if (home) await removeAll(home);
});

it.skipIf(!ready())('signs in through the browser, lends the folder and works in it', { timeout: 240_000 }, async () => {
  const s = await openScreen({ cwd: project, env: env(), command: cliCommand() });
  try {
    // The first start after a build fills Node's compile cache: on a cold machine that takes a while.
    await s.waitFor('press enter to begin', 60_000);
    await s.press('enter');
    await s.waitFor('How should it look?');
    await s.press('enter');
    await s.waitFor('Where should Atelier run?');
    await s.press('enter');
    await s.waitFor('Which server?');
    show('address', s);
    // Servers found on the network come first; another address is typed.
    if (s.text().includes('Another address')) {
      await s.select(/^Another address/);
      await s.press('enter');
    }
    await s.waitFor('The address you open it at');
    await s.type(serverUrl);
    await s.press('enter');
    await s.waitFor('Sign in to 127.0.0.1', 30_000);
    show('method', s);
    await s.press('enter');
    const shown = await s.waitFor(/Approve this terminal in the browser/, 30_000);
    show('browser', s);
    const code = /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(shown.replace(/\s+│\s+/g, ''))?.[1];
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const request = await admin.call('auth.terminalRequest', { code: code! });
    expect(request.deviceName).toContain('terminal');
    await admin.call('auth.terminalDecide', { code: code!, approve: true });
    await s.waitFor('What this computer lends the server', 30_000);
    show('device', s);
    await s.press('enter');
    await s.waitFor('Which model should new sessions use?', 30_000);
    await s.select(/fake-chat/);
    await s.press('enter');
    await s.waitFor('How much should it ask?');
    await s.select(/^Ask/);
    await s.press('enter');
    await s.waitFor('Your terminal');
    await s.select(/^Continue/);
    await s.press('enter');
    await s.waitFor('All set');
    await s.press('enter');
    await s.waitFor('Work in', 30_000);
    show('trust', s);
    expect(s.text()).toContain('can run commands as you here');
    await s.press('enter');
    await s.waitFor('Ada @ 127.0.0.1', 30_000);
    await s.waitFor(/● 127\.0\.0\.1/, 30_000);
    show('session', s);
    await s.type(`call Write {"file_path": "${join(project, 'notes.md').replace(/\\/g, '\\\\')}", "content": "from the server\\n"}`);
    await s.press('enter');
    await s.waitFor(/Create .*notes\.md\?/, 60_000);
    await s.press('enter');
    await s.waitFor(/Created .*notes\.md/, 60_000);
    show('written', s);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('from the server\n');
    // The session is the server's: the admin's list has it, in this computer's folder.
    const sessions = await admin.call('sessions.list', { mode: 'code' });
    expect(sessions.length).toBeGreaterThan(0);
    await s.press('ctrlD');
  } finally {
    await s.close();
  }
  // Print mode through the same server and the same lent folder.
  const out = execFileSync(process.execPath, [BUNDLE, '-p', 'say hi'], { cwd: project, env: env(), encoding: 'utf8', timeout: 60_000 });
  expect(out).toContain('say hi');
  const json = JSON.parse(execFileSync(process.execPath, [BUNDLE, '-p', 'hello json', '--output-format', 'json'], { cwd: project, env: env(), encoding: 'utf8', timeout: 60_000 }).trim().split('\n').at(-1)!) as { result: string; is_error: boolean };
  expect(json.is_error).toBe(false);
  expect(json.result).toContain('hello json');
  // The server lists this terminal's sign-in as a terminal.
  const signIns = await admin.call('account.sessions', {});
  expect(signIns.some((x) => x.clientKind === 'cli')).toBe(true);
  // Logging out ends it on the server.
  execFileSync(process.execPath, [BUNDLE, 'logout'], { env: env(), encoding: 'utf8', timeout: 30_000 });
  const after = await admin.call('account.sessions', {});
  expect(after.some((x) => x.clientKind === 'cli')).toBe(false);
});
