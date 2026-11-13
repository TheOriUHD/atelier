import { describe, expect, it, vi } from 'vitest';
import { createUpdater, failureText, looksLocal, manifestSizes, pullProgress, type Docker } from './updater.ts';

const SECRET = 'shared-secret-from-the-volume';
const AUTH = `Bearer ${SECRET}`;

/** A Docker host with one compose project, recording every command it was given. */
function fakeDocker({ image = 'ghcr.io/theoriuhd/atelier:latest', digests = ['ghcr.io/theoriuhd/atelier@sha256:1'], failPull = false } = {}) {
  const calls: string[][] = [];
  const docker: Docker = async (args, onLine) => {
    calls.push(args);
    if (args[0] === 'inspect' && args[1] === 'self-id') {
      return JSON.stringify([
        {
          Config: {
            Labels: {
              'com.docker.compose.project': 'atelier',
              'com.docker.compose.project.working_dir': '/home/ada/atelier',
              'com.docker.compose.project.config_files': '/home/ada/atelier/compose.yaml',
            },
          },
        },
      ]);
    }
    if (args[0] === 'ps') return args.includes('label=com.docker.compose.service=atelier') ? 'c-atelier\n' : 'c-sandbox\n';
    if (args[0] === 'inspect' && args[1] === '--type') return JSON.stringify([{ RepoDigests: digests }]);
    if (args[0] === 'inspect') return JSON.stringify([{ Image: `sha256:${args[1]}`, Config: { Image: args[1] === 'c-atelier' ? image : 'ghcr.io/theoriuhd/atelier-sandbox:latest' } }]);
    if (args[0] === 'version') return 'linux/amd64\n';
    if (args.includes('config')) return JSON.stringify({ services: { atelier: { image: 'ghcr.io/theoriuhd/atelier:latest' }, sandbox: { image: 'ghcr.io/theoriuhd/atelier-sandbox:latest' } } });
    if (args[0] === 'manifest') {
      // The server's image has two layers, one of them on this host already; the sandbox's can't be read.
      if (args.at(-1)!.includes('sandbox')) throw new Error('denied');
      const layers = [{ digest: `sha256:${'a'.repeat(64)}`, size: 200 }, { digest: `sha256:${'b'.repeat(64)}`, size: 999 }];
      return JSON.stringify([{ Descriptor: { platform: { os: 'linux', architecture: 'arm64' } }, OCIManifest: { layers: [] } }, { Descriptor: { platform: { os: 'linux', architecture: 'amd64' } }, OCIManifest: { layers } }]);
    }
    if (args.includes('pull')) {
      const image = 'Image ghcr.io/theoriuhd/atelier:latest';
      onLine?.(JSON.stringify({ id: image, status: 'Working', text: 'Pulling' }));
      onLine?.(JSON.stringify({ id: 'aaaaaaaaaaaa', parent_id: image, status: 'Working', text: 'Pulling fs layer' }));
      onLine?.(JSON.stringify({ id: 'bbbbbbbbbbbb', parent_id: image, status: 'Done', text: 'Already exists' }));
      // Before the first byte: the size is known from the registry.
      onLine?.(JSON.stringify({ id: 'aaaaaaaaaaaa', parent_id: image, status: 'Working', text: 'Downloading', current: 50, total: 200 }));
      if (failPull) throw new Error('manifest unknown');
      onLine?.(JSON.stringify({ id: 'aaaaaaaaaaaa', parent_id: image, status: 'Done', text: 'Pull complete', percent: 100 }));
    }
    return '';
  };
  return { docker, calls };
}

function setup(options: Parameters<typeof fakeDocker>[0] = {}) {
  const docker = fakeDocker(options);
  const link = vi.fn(async () => {});
  const updater = createUpdater({ docker: docker.docker, self: 'self-id', secret: async () => SECRET, link, now: () => 1000 });
  return { ...docker, updater, link };
}

describe('the updater service', () => {
  it('answers only with the shared secret', async () => {
    const { updater, calls } = setup();
    expect((await updater.handle('GET', '/status', undefined)).status).toBe(401);
    expect((await updater.handle('POST', '/update', 'Bearer wrong')).status).toBe(401);
    expect((await updater.handle('POST', '/update', `Bearer ${SECRET}x`)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('refuses everyone while the server has made no secret yet', async () => {
    const updater = createUpdater({ docker: fakeDocker().docker, self: 'self-id', secret: async () => null });
    expect((await updater.handle('GET', '/status', 'Bearer ')).status).toBe(401);
  });

  it('knows no other action', async () => {
    const { updater } = setup();
    expect((await updater.handle('POST', '/exec', AUTH)).status).toBe(404);
    expect((await updater.handle('GET', '/update', AUTH)).status).toBe(404);
  });

  it('reports the images of its own project’s services', async () => {
    const { updater } = setup();
    const { status, body } = await updater.handle('GET', '/status', AUTH);
    expect(status).toBe(200);
    expect(body).toEqual({
      project: 'atelier',
      services: { atelier: { image: 'ghcr.io/theoriuhd/atelier:latest', source: false }, sandbox: { image: 'ghcr.io/theoriuhd/atelier-sandbox:latest', source: false } },
      job: { state: 'idle', message: null, startedAt: null, finishedAt: null, progress: null },
    });
  });

  it('pulls and recreates exactly the atelier and sandbox services of this project', async () => {
    const { updater, calls, link } = setup();
    const answer = await updater.handle('POST', '/update', AUTH);
    expect(answer.status).toBe(202);
    await updater.settled();
    const compose = ['compose', '--project-name', 'atelier', '--project-directory', '/home/ada/atelier', '--file', '/home/ada/atelier/compose.yaml'];
    expect(calls.filter((c) => c[0] === 'compose')).toEqual([
      [...compose, 'config', '--format', 'json'],
      [...compose, '--progress', 'json', 'pull', 'atelier', 'sandbox'],
      [...compose, 'up', '--detach', '--no-deps', 'atelier', 'sandbox'],
    ]);
    expect(link).toHaveBeenCalledWith('/home/ada/atelier', '/project');
    expect(updater.job()).toEqual({ state: 'done', message: null, startedAt: 1000, finishedAt: 1000, progress: { done: 200, total: 200, percent: 100, unpacking: false } });
  });

  it('runs one update at a time', async () => {
    const { updater } = setup();
    await updater.handle('POST', '/update', AUTH);
    expect((await updater.handle('POST', '/update', AUTH)).status).toBe(409);
    await updater.settled();
  });

  it('reports a failed pull', async () => {
    const { updater, calls } = setup({ failPull: true });
    await updater.handle('POST', '/update', AUTH);
    await updater.settled();
    expect(updater.job()).toMatchObject({ state: 'failed', message: 'manifest unknown', progress: { done: 50, total: 200, percent: 25 } });
    expect(calls.some((c) => c.includes('up'))).toBe(false);
  });

  it('leaves an image built on the host alone', async () => {
    const { updater, calls } = setup({ image: 'atelier:local', digests: [] });
    expect(((await updater.handle('GET', '/status', AUTH)).body as { services: { atelier: { source: boolean } } }).services.atelier.source).toBe(true);
    await updater.handle('POST', '/update', AUTH);
    await updater.settled();
    expect(updater.job()).toMatchObject({ state: 'failed', message: expect.stringContaining('built from source') });
    expect(calls.some((c) => c[0] === 'compose')).toBe(false);
  });

  it('tells local image names from registry ones', () => {
    expect(looksLocal('atelier:local')).toBe(true);
    expect(looksLocal('atelier')).toBe(true);
    expect(looksLocal('ghcr.io/me/atelier:local')).toBe(true);
    expect(looksLocal('ghcr.io/theoriuhd/atelier:latest')).toBe(false);
    expect(looksLocal('me/atelier')).toBe(false);
    expect(looksLocal('localhost:5000/atelier:0.1.8')).toBe(false);
  });
});

describe('the pull, added up', () => {
  const image = 'Image ghcr.io/theoriuhd/atelier:latest';
  const event = (id: string, text: string, extra: Record<string, number> = {}) => JSON.stringify({ id, parent_id: image, status: 'Working', text, ...extra });

  it('is the bytes of every layer so far, the waiting ones counted as big as the average, never going back', () => {
    const p = pullProgress();
    // Compose's own lines for the image, and anything that isn't JSON, count for nothing.
    p.line(JSON.stringify({ id: image, status: 'Working', text: 'Pulling' }));
    p.line('not json');
    for (const id of ['a', 'b', 'c', 'd']) p.line(event(id, 'Pulling fs layer'));
    p.line(event('d', 'Already exists'));
    expect(p.get()).toBeNull();
    p.line(event('a', 'Downloading', { current: 100, total: 1000 }));
    // a: 100 of 1000; b and c wait, counted as 1000 each.
    expect(p.get()).toEqual({ done: 100, total: 3000, percent: 3, unpacking: false });
    p.line(event('b', 'Downloading', { current: 50, total: 100 }));
    // The average falls to 550: the total shrinks, the percent doesn't go back.
    expect(p.get()).toMatchObject({ done: 150, total: 1650, percent: 9 });
    p.line(event('a', 'Download complete'));
    p.line(event('b', 'Download complete'));
    p.line(event('c', 'Download complete'));
    // c finished without ever saying its size (a small layer): all is down, being unpacked, still short of 100.
    expect(p.get()).toEqual({ done: 1100, total: 1100, percent: 99, unpacking: true });
    for (const id of ['a', 'b', 'c']) p.line(event(id, 'Pull complete'));
    expect(p.get()).toMatchObject({ percent: 99, unpacking: false });
    expect(p.get(true)).toMatchObject({ percent: 100 });
  });

  it('knows every layer’s size from the start when the registry said them', () => {
    const p = pullProgress(new Map([['aaaaaaaaaaaa', 800], ['cccccccccccc', 200]]));
    p.line(event('aaaaaaaaaaaa', 'Pulling fs layer'));
    p.line(event('cccccccccccc', 'Pulling fs layer'));
    expect(p.get()).toEqual({ done: 0, total: 1000, percent: 0, unpacking: false });
    p.line(event('cccccccccccc', 'Downloading', { current: 100, total: 200 }));
    expect(p.get()).toMatchObject({ done: 100, total: 1000, percent: 10 });
  });

  it('reads the sizes for this computer’s platform from the registry’s answer', () => {
    const layers = (hex: string, size: number) => ({ layers: [{ digest: `sha256:${hex.repeat(64)}`, size }] });
    const list = [
      { Descriptor: { platform: { os: 'linux', architecture: 'arm64' } }, OCIManifest: layers('a', 1) },
      { Descriptor: { platform: { os: 'linux', architecture: 'amd64' } }, SchemaV2Manifest: layers('b', 2) },
      { Descriptor: { platform: { os: 'linux', architecture: 's390x' } }, Raw: Buffer.from(JSON.stringify(layers('c', 3))).toString('base64') },
    ];
    expect([...manifestSizes(list, 'linux/amd64')]).toEqual([['bbbbbbbbbbbb', 2]]);
    expect([...manifestSizes(list, 'linux/s390x')]).toEqual([['cccccccccccc', 3]]);
    // One platform only: that one, whatever it says.
    expect([...manifestSizes({ OCIManifest: layers('d', 4) }, 'linux/amd64')]).toEqual([['dddddddddddd', 4]]);
    expect([...manifestSizes(list, 'windows/amd64')]).toEqual([]);
  });

  it('is complete at the end of a pull that had nothing to fetch', () => {
    expect(pullProgress().get(true)).toEqual({ done: 0, total: 0, percent: 100, unpacking: false });
  });
});

describe('a failed docker command', () => {
  it('says compose’s JSON error, or the last lines it printed', () => {
    const printed = [
      '{"id":"Image ghcr.io/x/y:latest","status":"Working","text":"Pulling"}',
      '{"error":true,"message":"Error response from daemon: failed to resolve reference \\"ghcr.io/x/y:latest\\": not found\\nError response from daemon: again"}',
    ].join('\n');
    expect(failureText(printed, 1)).toBe('Error response from daemon: failed to resolve reference "ghcr.io/x/y:latest": not found');
    expect(failureText('one\ntwo\nthree\nfour\n', 1)).toBe('two\nthree\nfour');
    expect(failureText('', 2)).toBe('docker exited with 2');
  });
});
