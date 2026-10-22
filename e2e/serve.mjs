// Playwright webServer: the scripted fake Ollama plus the built web server on a temp data dir.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Overridable so several checkouts can run their E2E suites at once (see e2e/fixtures.ts).
const [ollamaPort, webPort] = [Number(process.env.ATELIER_E2E_OLLAMA_PORT ?? 11510), Number(process.env.ATELIER_E2E_WEB_PORT ?? 7360)];
const dataDir = await mkdtemp(join(tmpdir(), 'atelier-e2e-web-'));
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify({ providers: [{ id: 'fake', type: 'ollama', name: 'Fake Ollama', baseUrl: `http://127.0.0.1:${ollamaPort}` }] }),
);

// Extensions for e2e/extensions-settings.web.spec.ts: two skills (one recorded as installed by Atelier) and a plugin.
const fixture = async (path, content) => {
  await mkdir(dirname(join(dataDir, path)), { recursive: true });
  await writeFile(join(dataDir, path), typeof content === 'string' ? content : JSON.stringify(content));
};
const plugin = 'plugins/cache/e2e-market/review-kit/1.0.0';
await Promise.all([
  fixture('skills/e2e-notes/SKILL.md', '---\nname: e2e-notes\ndescription: Takes notes for the E2E suite.\n---\nWrite notes.\n'),
  fixture('skills/e2e-style/SKILL.md', '---\nname: e2e-style\ndescription: House style, started by hand.\ndisable-model-invocation: true\n---\nUse the house style.\n'),
  fixture('skills-lock.json', {
    version: 1,
    skills: { 'e2e-notes': { source: 'atelier-e2e/skills', sha: '0123456789abcdef', path: 'e2e-notes', installedAt: '2026-10-01T12:00:00.000Z' } },
  }),
  fixture('plugins/installed.json', {
    version: 1,
    plugins: { 'review-kit@e2e-market': { installPath: join(dataDir, plugin), version: '1.0.0', sha: 'fedcba9876543210', installedAt: '2026-10-01T12:00:00.000Z' } },
  }),
  fixture(`${plugin}/.claude-plugin/plugin.json`, { name: 'review-kit', description: 'Reviews changes.', version: '1.0.0' }),
  fixture(`${plugin}/skills/lint/SKILL.md`, '---\nname: lint\ndescription: Lints the change.\n---\nLint it.\n'),
  fixture(`${plugin}/commands/ship.md`, '---\ndescription: Ships the change.\n---\nShip it.\n'),
]);

const children = [
  spawn(process.execPath, ['e2e/fake-ollama.mjs', String(ollamaPort)], { stdio: 'inherit' }),
  // The setup project (e2e/auth.setup.ts) creates the admin with this token (SETUP_TOKEN in fixtures.ts).
  spawn(process.execPath, ['apps/server/dist/server.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ATELIER_DATA_DIR: dataDir,
      ATELIER_PORT: String(webPort),
      ATELIER_SETUP_TOKEN: 'atelier-e2e-setup-token',
      // Web search reads result pages from the fake server instead of the internet (e2e/web-search.web.spec.ts).
      ATELIER_SEARCH_BASE: `http://127.0.0.1:${ollamaPort}/engines`,
    },
  }),
];
const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
