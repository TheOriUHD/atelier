// Playwright webServer: the scripted fakes (Ollama, image server, identity provider) plus the built web server on a temp data dir.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Overridable so several checkouts can run their E2E suites at once (see e2e/fixtures.ts).
const [ollamaPort, webPort, oidcPort, imagesPort, videoPort, audioPort] = [Number(process.env.ATELIER_E2E_OLLAMA_PORT ?? 11510), Number(process.env.ATELIER_E2E_WEB_PORT ?? 7360), Number(process.env.ATELIER_E2E_OIDC_PORT ?? 7362), Number(process.env.ATELIER_E2E_IMAGES_PORT ?? 11610), Number(process.env.ATELIER_E2E_VIDEO_PORT ?? 11620), Number(process.env.ATELIER_E2E_AUDIO_PORT ?? 11630)];
const dataDir = await mkdtemp(join(tmpdir(), 'atelier-e2e-web-'));
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify({
    providers: [{ id: 'fake', type: 'ollama', name: 'Fake Ollama', baseUrl: `http://127.0.0.1:${ollamaPort}` }],
    // As IMAGE_SETTINGS in e2e/fixtures.ts, without the price: the usage specs count on nothing having one.
    imageProviders: [
      { id: 'fake-images', type: 'openai-images', preset: 'openai-compatible', name: 'Fake Images', baseUrl: `http://127.0.0.1:${imagesPort}` },
      { id: 'fake-video', type: 'openrouter-video', preset: 'openrouter-video', name: 'Fake Video', baseUrl: `http://127.0.0.1:${videoPort}/api` },
      { id: 'fake-audio', type: 'openai-speech', preset: 'localai-speech', name: 'Fake Audio', baseUrl: `http://127.0.0.1:${audioPort}` },
    ],
    // The video model people get unless they name one: the other needs no picture here, but is a different model.
    models: { defaults: { video: 'fake-video/fake/dusk' }, overrides: { 'fake/fake-eyes:8b': { promptTier: 'full' } } },
  }),
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
  spawn(process.execPath, ['e2e/fake-oidc.mjs', String(oidcPort)], { stdio: 'inherit' }),
  spawn(process.execPath, ['e2e/fake-images.mjs', String(imagesPort)], { stdio: 'inherit' }),
  spawn(process.execPath, ['e2e/fake-video.mjs', String(videoPort)], { stdio: 'inherit' }),
  spawn(process.execPath, ['e2e/fake-audio.mjs', String(audioPort)], { stdio: 'inherit' }),
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
