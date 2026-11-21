// Builds the extension from one source: the worker bundled with esbuild, the manifest and the icon.
//
//   node scripts/build.mjs                     Atelier for Chrome, unpacked, into dist/ (the desktop app ships it as a
//                                              resource: Settings › Computer use › Browser shows where, for "Load unpacked")
//   node scripts/build.mjs --store             the Chrome Web Store upload: out/store/ and out/atelier-for-chrome-<v>.zip,
//                                              the manifest's `key` left out (the store gives the extension an id of its own)
//   node scripts/build.mjs --firefox           Atelier for Firefox, unpacked, into dist-firefox/ (about:debugging › Load
//                                              Temporary Add-on, or the end-to-end test)
//   node scripts/build.mjs --firefox --store   the addons.mozilla.org upload: out/firefox/, out/atelier-for-firefox-<v>.zip
//                                              and the source package reviewers rebuild it from, out/atelier-for-firefox-<v>-source.zip
//
// The Firefox build is the same worker with a manifest of Firefox's own (store/firefox.md says why each part is there).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.argv.includes('--store');
const firefox = process.argv.includes('--firefox');
const out = join(root, firefox ? (store ? 'out/firefox' : 'dist-firefox') : store ? 'out/store' : 'dist');

/** Atelier for Firefox's add-on id: packages/protocol/src/browser.ts FIREFOX_EXTENSION_ID, which the desktop's host allows. */
const FIREFOX_ID = 'atelier@atelierhq.dev';

/** The manifest as Firefox takes it: no Chrome key or debugger, a background script instead of a service worker. */
export function firefoxManifest(chrome) {
  const { key: _key, minimum_chrome_version: _min, background: _bg, ...rest } = chrome;
  return {
    ...rest,
    name: 'Atelier for Firefox',
    // Firefox has no debugger for extensions: input happens inside the page (src/page-input.ts).
    permissions: chrome.permissions.filter((p) => p !== 'debugger'),
    background: { scripts: ['worker.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_ID,
        // 139 brought tab groups to extensions, 140 the built-in data consent the declaration below needs.
        strict_min_version: '140.0',
        // What the extension sends out of the browser (to the Atelier desktop app, and from there to the model the person
        // chose): the pages it works in, which can show a person's details, payments and messages. Required: it can't work
        // without reading the page.
        data_collection_permissions: { required: ['websiteContent', 'personallyIdentifyingInfo', 'financialAndPaymentInfo', 'personalCommunications'] },
      },
    },
  };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/worker.ts')],
  outfile: join(out, 'worker.js'),
  // Paths in the bundle's comments are from here, wherever the build is started: the same worker.js from the source package.
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  target: firefox ? 'firefox140' : 'chrome120',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const base = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const manifest = firefox ? firefoxManifest(base) : base;
if (store) delete manifest.key;
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, 'icon-128.png'), join(out, 'icon-128.png'));

const zip = (file, cwd, entries = ['.']) => {
  rmSync(file, { force: true });
  execFileSync('zip', ['-q', '-X', '-r', file, ...entries], { cwd });
  console.log(`built ${file}`);
};

if (store && !firefox) zip(join(root, 'out', `atelier-for-chrome-${manifest.version}.zip`), out);
else if (store && firefox) {
  zip(join(root, 'out', `atelier-for-firefox-${manifest.version}.zip`), out);
  // In the repository only: the source package itself has no store/ folder, and its build makes just the add-on.
  if (existsSync(join(root, 'store', 'firefox-source-readme.md'))) sourcePackage(manifest.version);
} else console.log(`built ${out}`);

/**
 * addons.mozilla.org reviews bundled code from its source: the extension's own files, the one protocol module it bundles,
 * the build script and the pinned esbuild, laid out as in the repository so the same command builds the same worker.js
 * (store/firefox-source-readme.md says how).
 */
function sourcePackage(version) {
  const repo = join(root, '..', '..');
  const staging = join(root, 'out', 'firefox-source');
  rmSync(staging, { recursive: true, force: true });
  const ext = join(staging, 'apps', 'browser-extension');
  mkdirSync(join(ext, 'scripts'), { recursive: true });
  mkdirSync(join(staging, 'packages', 'protocol', 'src'), { recursive: true });
  cpSync(join(root, 'src'), join(ext, 'src'), { recursive: true, filter: (path) => !path.endsWith('.test.ts') });
  for (const file of ['manifest.json', 'icon-128.png', 'tsconfig.json']) cpSync(join(root, file), join(ext, file));
  // esbuild reads the TypeScript settings, so the build there must see the same ones.
  cpSync(join(repo, 'tsconfig.base.json'), join(staging, 'tsconfig.base.json'));
  cpSync(join(root, 'scripts', 'build.mjs'), join(ext, 'scripts', 'build.mjs'));
  cpSync(join(repo, 'packages', 'protocol', 'src', 'browser.ts'), join(staging, 'packages', 'protocol', 'src', 'browser.ts'));
  const esbuild = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.esbuild;
  writeFileSync(
    join(staging, 'package.json'),
    `${JSON.stringify({ name: 'atelier-for-firefox-source', version, private: true, type: 'module', license: 'PolyForm-Noncommercial-1.0.0', scripts: { build: 'node apps/browser-extension/scripts/build.mjs --firefox --store' }, devDependencies: { esbuild } }, null, 2)}\n`,
  );
  cpSync(join(root, 'store', 'firefox-source-readme.md'), join(staging, 'README.md'));
  zip(join(root, 'out', `atelier-for-firefox-${version}-source.zip`), staging);
  rmSync(staging, { recursive: true, force: true });
}
