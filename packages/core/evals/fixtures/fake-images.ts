/** The scripted image server of the end-to-end tests (e2e/fake-images.mjs), started on a free port for an eval run. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', '..', 'e2e', 'fake-images.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface FakeImages {
  url: string;
  stop(): void;
}

export async function startFakeImages(): Promise<FakeImages> {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, String(port)], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error('The fake image server stopped at once.');
    if (await fetch(`${url}/v1/models`).then((r) => r.ok, () => false)) return { url, stop: () => void child.kill() };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('The fake image server did not come up.');
}
