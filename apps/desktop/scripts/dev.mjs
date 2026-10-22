// Dev: Vite serves the UI with HMR; main/preload/backend are bundled once and Electron loads the dev URL.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, ['scripts/build.mjs', '--no-ui'], { stdio: 'inherit', cwd: root });
const vite = spawn('pnpm', ['--filter', '@atelier/ui', 'dev'], { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
await new Promise((r) => setTimeout(r, 1500));
const electron = spawn(electronPath, ['.'], { stdio: 'inherit', cwd: root, env: { ...process.env, ATELIER_DEV_URL: 'http://localhost:5199' } });
electron.on('exit', () => {
  vite.kill();
  process.exit(0);
});
