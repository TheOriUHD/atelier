// Bundles the terminal app into one file, dist/atelier.mjs (ESM, Node 24), with the licenses of what went into it
// (dist/LICENSES.txt, for `atelier licenses`). The packaging step (scripts/package.mjs) puts it beside Node and the runner.
import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(join(root, 'dist'), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/atelier.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'warning',
  // Ink loads React's devtools only when asked to (DEV=true); a stub stands in for them.
  alias: { 'react-devtools-core': './scripts/devtools-stub.mjs' },
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);" },
});

// Each package in the bundle, once, with its license text.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+))\//.exec(input);
  if (!m || packages.has(m[2])) continue;
  const dir = join(root, m[1]);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const file = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : undefined;
  packages.set(m[2], { name: manifest.name ?? m[2], version: manifest.version ?? '', license: typeof manifest.license === 'string' ? manifest.license : 'see text', text: file ? readFileSync(join(dir, file), 'utf8').trim() : '' });
}
const own = readFileSync(join(root, '../../LICENSE'), 'utf8').trim();
const sections = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `${p.name} ${p.version} (${p.license})\n${'-'.repeat(60)}\n${p.text || `Licensed under ${p.license}.`}`);
await writeFile(
  join(root, 'dist/LICENSES.txt'),
  `Atelier CLI\n${'='.repeat(60)}\n${own}\n\nThe terminal app includes the following third-party code, under their own licenses. It also runs on Node.js (https://nodejs.org, MIT and others: see node/LICENSE in this install) and the Atelier runner, whose licenses come with \`atelier-runner licenses\`.\n\n${sections.join('\n\n')}\n`,
);
const size = (result.metafile.outputs['dist/atelier.mjs'].bytes / 1048576).toFixed(1);
console.log(`dist/atelier.mjs ${size} MB, ${packages.size} packages`);
