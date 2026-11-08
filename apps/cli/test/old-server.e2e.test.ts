/**
 * The terminal app with a server from before 0.6.0 (no browser sign-in, no `cli` client kind): it signs in with the
 * password as the desktop app does, and works in the lent folder. On request, with that server's bundle:
 *   OLD_SERVER=<path to a 0.5.x apps/server/dist/server.mjs> npx vitest run apps/cli/test/old-server.e2e.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { BUNDLE, canRun, cliCommand, ended, openScreen, removeAll } from './harness.ts';

const SERVER = process.env.OLD_SERVER;
const base = 14000 + Math.floor(Math.random() * 1000);
let home = '';
let children: ChildProcess[] = [];
const env = () => ({ ...process.env, ATELIER_NO_BROWSER: '1', HOME: home, USERPROFILE: home, ATELIER_CLI_DIR: join(home, '.atelier', 'cli'), ATELIER_CLI_CREDENTIALS: 'file', ATELIER_COOP_RELAY: '' });

afterAll(async () => {
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

it.skipIf(!SERVER || !canRun())('signs in to an older server with the password and works in the folder', { timeout: 240_000 }, async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), 'atelier-cli-old-')));
  const project = join(home, 'shader');
  const data = join(home, 'server-data');
  await mkdir(project);
  await mkdir(data);
  execFileSync('git', ['init', '-q'], { cwd: project });
  await writeFile(join(data, 'settings.json'), JSON.stringify({ providers: [{ id: 'fake', type: 'ollama', name: 'Fake Ollama', baseUrl: `http://127.0.0.1:${base}` }], models: { defaults: { code: 'fake/fake-chat:8b' } } }));
  children = [
    spawn(process.execPath, [join(import.meta.dirname, '../../../e2e/fake-ollama.mjs'), String(base)], { stdio: 'ignore' }),
    spawn(process.execPath, [SERVER!], { stdio: 'ignore', env: { ...process.env, ATELIER_DATA_DIR: data, ATELIER_PORT: String(base + 1), ATELIER_SETUP_TOKEN: 'old-setup', ATELIER_COOP_RELAY: '' } }),
  ];
  const url = `http://127.0.0.1:${base + 1}`;
  for (let i = 0; i < 100 && !(await fetch(`${url}/api/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200));
  const setup = await fetch(`${url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'old-setup', username: 'ada', name: 'Ada', password: 'ada-password-1' }) });
  expect(setup.status).toBe(200);

  const s = await openScreen({ cwd: project, env: env(), command: cliCommand() });
  try {
    await s.waitFor('Where should Atelier run?', 60_000);
    await s.select(/^(Another server|An Atelier server)/);
    await s.press('enter');
    await s.waitFor('The address you open it at');
    await s.type(url);
    await s.press('enter');
    // A 0.5 server: username and password on one screen.
    await s.waitFor('signs terminals in with a password', 30_000);
    await s.type('ada');
    await s.press('enter');
    await s.type('ada-password-1');
    await s.press('enter');
    await s.waitFor('What this computer lends the server', 30_000);
    await s.press('enter');
    await s.waitFor('Which model, and how much should it ask?', 30_000);
    await s.press('right');
    await s.waitFor('‹ Ask ›');
    await s.press('enter');
    await s.waitFor('All set');
    await s.press('enter');
    await s.waitFor('Work in', 30_000);
    await s.press('enter');
    await s.waitFor('Ada @ 127.0.0.1', 30_000);
    await s.type(`call Write {"file_path": "${join(project, 'notes.md').replace(/\\/g, '\\\\')}", "content": "older server\\n"}`);
    await s.press('enter');
    await s.waitFor(/Create .*notes\.md\?/, 60_000);
    await s.press('enter');
    await s.waitFor(/Created .*notes\.md/, 60_000);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('older server\n');
    await s.press('ctrlD');
  } finally {
    await s.close();
  }
});
