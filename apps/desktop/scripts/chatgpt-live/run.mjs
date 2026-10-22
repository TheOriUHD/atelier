// Bundles the ChatGPT Chat driver and runs main.cjs in Electron. See main.cjs.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const live = process.env.LIVE_DIR || join(tmpdir(), 'atelier-chatgpt-live');
mkdirSync(live, { recursive: true });
await build({ entryPoints: [join(here, '../../src/chatgpt-chat.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(live, 'chatgpt-chat.cjs'), logLevel: 'warning' });
await build({ entryPoints: [join(here, 'adapter-entry.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(live, 'adapter.cjs'), logLevel: 'warning' });
copyFileSync(join(here, 'main.cjs'), join(live, 'main.cjs'));
const electron = createRequire(import.meta.url)('electron');
console.log(`Profile and captures in ${live}`);
const child = spawn(electron, [join(live, 'main.cjs')], { stdio: 'inherit', env: { ...process.env, LIVE_DIR: live, SCENARIOS: process.argv[2] || 'all' } });
child.on('exit', (code) => process.exit(code ?? 0));
