#!/usr/bin/env node
/**
 * The admin panel and the report collector on this computer (README.md "Local development"): builds the SPA, applies
 * the migrations to a local D1, and runs both Workers with `wrangler dev --local`, sharing one local D1 and R2:
 *
 *   collector  http://127.0.0.1:8787   CHALLENGE_SECRET is a fixed development value
 *   admin      http://localhost:8788   DEV_NO_ACCESS=1: no Cloudflare Access, on localhost only
 *
 *   node deploy/admin/scripts/dev.mjs [--no-build]
 *   node deploy/admin/scripts/seed.mjs              (in another terminal: fake reports and counts)
 *
 * Nothing here touches Cloudflare: every wrangler command runs with --local and its state stays in
 * deploy/admin/.wrangler/dev-state (git ignores .wrangler/). Delete that folder to start over.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(here, '../../..');
export const STATE = join(ROOT, 'deploy/admin/.wrangler/dev-state');
export const DEV_SECRET = 'dev-only-challenge-secret-not-for-production';
export const PORTS = { collector: 8787, admin: 8788 };
const env = { ...process.env, npm_config_prefer_offline: 'true', WRANGLER_SEND_METRICS: 'false', CI: '1' };
const wrangler = (args) => ['--yes', 'wrangler@4', ...args];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(' ')} failed (${r.status})`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes('--no-build')) run('pnpm', ['--filter', '@atelier/admin', 'build'], ROOT);
  run(
    'npx',
    wrangler(['d1', 'migrations', 'apply', 'atelier-admin', '--local', '--persist-to', STATE]),
    join(ROOT, 'deploy/admin'),
  );

  const children = [];
  const start = (name, cwd, args) => {
    const child = spawn(
      'npx',
      wrangler(['dev', '--local', '--persist-to', STATE, '--show-interactive-dev-session=false', ...args]),
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const prefix = (chunk) =>
      String(chunk)
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => `[${name}] ${l}`)
        .join('\n');
    child.stdout.on('data', (c) => console.log(prefix(c)));
    child.stderr.on('data', (c) => console.error(prefix(c)));
    child.on('exit', (code) => {
      console.error(`[${name}] exited (${code})`);
      for (const other of children) other.kill('SIGTERM');
      process.exit(code ?? 1);
    });
    children.push(child);
  };
  // --local-upstream: without it the Workers see their production host (from `routes`) in request.url, and the
  // admin Worker rightly refuses DEV_NO_ACCESS for any host but localhost.
  start('collector', join(ROOT, 'deploy/reports'), [
    '--port',
    String(PORTS.collector),
    '--ip',
    '127.0.0.1',
    '--local-upstream',
    `127.0.0.1:${PORTS.collector}`,
    '--inspector-port',
    '9331',
    '--var',
    `CHALLENGE_SECRET:${DEV_SECRET}`,
  ]);
  start('admin', join(ROOT, 'deploy/admin'), [
    '--port',
    String(PORTS.admin),
    '--ip',
    '127.0.0.1',
    '--local-upstream',
    `localhost:${PORTS.admin}`,
    '--inspector-port',
    '9332',
    '--var',
    'DEV_NO_ACCESS:1',
    '--test-scheduled',
  ]);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      for (const child of children) child.kill('SIGTERM');
      process.exit(0);
    });
}
