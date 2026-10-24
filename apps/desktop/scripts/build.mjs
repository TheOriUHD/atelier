// Bundles main (ESM), preload (CJS, sandboxed) and the two utility process entries (ESM): the embedded
// backend and the server-mode relay. Copies the UI build.
import { build } from 'esbuild';
import { cp, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skipUi = process.argv.includes('--no-ui');
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: true, logLevel: 'info', absWorkingDir: root };
const esmBanner = { js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);" };

await rm(`${root}/dist`, { recursive: true, force: true });
await mkdir(`${root}/dist`, { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.mjs', format: 'esm', external: ['electron'], banner: esmBanner }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/backend.ts'], outfile: 'dist/backend.mjs', format: 'esm', external: ['electron'], banner: esmBanner }),
  build({ ...common, entryPoints: ['src/remote.ts'], outfile: 'dist/remote.mjs', format: 'esm', external: ['electron'], banner: esmBanner }),
]);
if (!skipUi) {
  // On Windows pnpm is a .cmd file, which only a shell can start.
  execFileSync('pnpm', ['--filter', '@atelier/ui', 'build'], { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
  await cp(`${root}/../../packages/ui/dist`, `${root}/dist/ui`, { recursive: true });
}
