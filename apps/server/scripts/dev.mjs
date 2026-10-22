// Runs the server from TypeScript sources with Node's type stripping disabled for deps: bundle on change.
import { context } from 'esbuild';
import { spawn } from 'node:child_process';

let child;
const restart = () => {
  child?.kill();
  child = spawn(process.execPath, ['--enable-source-maps', 'dist/server.mjs'], { stdio: 'inherit', env: { ...process.env, ATELIER_DATA_DIR: process.env.ATELIER_DATA_DIR ?? '.atelier-data' } });
};
const ctx = await context({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  banner: { js: "import { createRequire as createBundleRequire } from 'node:module'; const require = createBundleRequire(import.meta.url);" },
  plugins: [{ name: 'restart', setup: (b) => b.onEnd((r) => r.errors.length === 0 && restart()) }],
});
await ctx.watch();
