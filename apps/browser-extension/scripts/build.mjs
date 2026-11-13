// Builds Atelier for Chrome into dist/: the service worker bundled with esbuild, the manifest and the icon. The desktop
// app ships dist/ as a resource (Settings › Computer use › Browser shows where, for "Load unpacked").
// `--store` builds the Chrome Web Store upload instead: out/store/ and out/atelier-for-chrome-<version>.zip, with the
// manifest's `key` left out (the store refuses it and gives the extension an id of its own).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.argv.includes('--store');
const out = join(root, store ? 'out/store' : 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/worker.ts')],
  outfile: join(out, 'worker.js'),
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (store) delete manifest.key;
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, 'icon-128.png'), join(out, 'icon-128.png'));
if (store) {
  const zip = join(root, 'out', `atelier-for-chrome-${manifest.version}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-X', '-r', zip, '.'], { cwd: out });
  console.log(`built ${zip}`);
} else console.log(`built ${out}`);
