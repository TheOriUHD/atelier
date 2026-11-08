/**
 * The background service: it refuses a client without this user's token (the backend's `auth.localSignIn` needs no
 * secret, so the token is the lock), welcomes one with it, says how it stands, and stops when asked.
 */
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { servicePath } from '../src/paths.ts';
import { BUNDLE, canRun, ended, removeAll } from './harness.ts';

function talk(path: string, frame: unknown): Promise<unknown[]> {
  return new Promise((resolve) => {
    const replies: unknown[] = [];
    const s = connect(path, () => s.write(`${JSON.stringify(frame)}\n`));
    const lines = createInterface({ input: s });
    // readline passes the socket's errors on and throws them when nothing listens on it.
    lines.on('error', () => undefined);
    lines.on('line', (l) => {
      replies.push(JSON.parse(l));
      if (replies.length === 1) setTimeout(() => (s.destroy(), resolve(replies)), 100);
    });
    s.on('error', () => resolve(replies));
    s.on('close', () => resolve(replies));
  });
}

it.skipIf(!canRun())('lets in only its own user’s clients, and stops when asked', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-cli-daemon-'));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, ATELIER_CLI_DIR: join(dir, 'cli'), ATELIER_CLI_CREDENTIALS: 'file', ATELIER_COOP_RELAY: '' };
  const child = spawn(process.execPath, [BUNDLE, 'daemon', 'run', '--local'], { env, stdio: 'ignore' });
  let where = '';
  try {
    // Under a full test run the backend can take a while to start.
    for (let i = 0; i < 300 && !(await readFile(join(dir, 'cli', 'run', 'daemon.token'), 'utf8').catch(() => '')); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 300; i++) {
      where = (await servicePath(join(dir, 'cli'))) ?? '';
      if (where && (await talk(where, { t: 'status' })).length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const want = { mode: 'local' };
    expect(await talk(where, { t: 'hello', token: 'f'.repeat(64), version: 'x', want })).toEqual([{ t: 'refused', reason: 'Not this user’s service.' }]);
    expect(await talk(where, { t: 'status' })).toEqual([{ t: 'refused', reason: 'Not this user’s service.' }]);
    const token = (await readFile(join(dir, 'cli', 'run', 'daemon.token'), 'utf8')).trim();
    const [welcome] = (await talk(where, { t: 'hello', token, version: 'x', want })) as { t: string; status: { want: unknown; busy: number } }[];
    expect(welcome).toMatchObject({ t: 'welcome', status: { want, busy: 0 } });
    // A stop from someone with the token ends it.
    const stopped = new Promise((r) => child.once('exit', r));
    await new Promise<void>((resolve, reject) => {
      const s = connect(where, () => {
        s.write(`${JSON.stringify({ t: 'hello', token, version: 'x', want })}\n${JSON.stringify({ t: 'stop' })}\n`);
        // Read what it says, or the end of the stream never comes.
        s.resume();
        s.on('close', () => resolve());
      });
      s.on('error', async (e) => reject(new Error(`${e.message}\n${await readFile(join(dir, 'cli', 'logs', 'daemon.log'), 'utf8').catch(() => 'no log')}`)));
    });
    await stopped;
  } finally {
    await ended(child);
    await removeAll(dir);
  }
});
