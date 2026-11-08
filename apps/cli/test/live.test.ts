/**
 * A real model through the terminal app, on request (it spends a few tokens): Atelier CLI on this computer with a
 * Mistral provider (the key from the main checkout's `.env.local`), a folder, and `atelier -p`.
 *   LIVE_CLI=1 npx vitest run apps/cli/test/live.test.ts
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { contract, createRpcClient } from '@atelier/protocol';
import { connectService, serviceTransport } from '../src/daemon/client.ts';
import { paths } from '../src/paths.ts';
import { BUNDLE, canRun, ended, removeAll } from './harness.ts';

function key(): string | undefined {
  let file = join(import.meta.dirname, '../../../.env.local');
  if (!existsSync(file)) {
    try {
      file = join(dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim()), '.env.local');
    } catch {
      return undefined;
    }
  }
  if (!existsSync(file)) return undefined;
  return /^\s*MISTRAL_API_KEY\s*=\s*['"]?([^'"\s]+)/m.exec(readFileSync(file, 'utf8'))?.[1];
}

const apiKey = key();

it.skipIf(!process.env.LIVE_CLI || !apiKey || !canRun())('answers with a real Mistral model in print mode', { timeout: 180_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'atelier-cli-live-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ATELIER_CLI_DIR: join(home, 'cli'), ATELIER_CLI_CREDENTIALS: 'file', ATELIER_COOP_RELAY: '', ATELIER_NO_UPDATE_CHECK: '1' };
  const daemon = spawn(process.execPath, [BUNDLE, 'daemon', 'run', '--local'], { env, stdio: 'ignore' });
  const project = join(home, 'project');
  try {
    await mkdir(project);
    execFileSync('git', ['init', '-q'], { cwd: project });
    const p = paths(join(home, 'cli'));
    let link = null;
    for (let i = 0; i < 100 && !link; i++) {
      link = await connectService(p, { mode: 'local' }, { start: false, timeoutMs: 200 }).catch(() => null);
      if (!link) await new Promise((r) => setTimeout(r, 200));
    }
    expect(link).toBeTruthy();
    const transport = serviceTransport(p, link!, { mode: 'local' });
    const rpc = createRpcClient(contract, transport);
    await rpc.call('auth.setupLocal', { name: 'Live', clientKind: 'cli' });
    await rpc.call('providers.save', { id: 'mistral', type: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai', apiKey: apiKey!, headers: {}, enabled: true });
    await rpc.call('workspaces.addLocal', { path: project });
    transport.close();
    await writeFile(join(home, 'cli', 'config.json'), JSON.stringify({ connection: { mode: 'local' }, model: 'mistral/mistral-small-2603' }));
    const out = execFileSync(process.execPath, [BUNDLE, '-p', 'Reply with exactly the word pong and nothing else.', '--output-format', 'json'], { cwd: project, env, encoding: 'utf8', timeout: 150_000 });
    const result = JSON.parse(out.trim().split('\n').at(-1)!) as { result: string; is_error: boolean; model: string; usage: { output: number } };
    console.log(`live: ${result.model} said "${result.result.trim()}" (${result.usage.output} tokens out)`);
    expect(result.is_error).toBe(false);
    expect(result.result.toLowerCase()).toContain('pong');
  } finally {
    try {
      execFileSync(process.execPath, [BUNDLE, 'daemon', 'stop', '--force'], { env, timeout: 10_000 });
    } catch {
      // Not running.
    }
    await ended(daemon);
    await removeAll(home);
  }
});
