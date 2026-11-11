// Builds Atelier for Chrome into dist/: the service worker bundled with esbuild, the manifest and the icon. The desktop
// app ships dist/ as a resource (Settings › Computer use › Browser shows where, for "Load unpacked").
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
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
cpSync(join(root, 'manifest.json'), join(out, 'manifest.json'));
cpSync(join(root, 'icon-128.png'), join(out, 'icon-128.png'));
console.log(`built ${out}`);
