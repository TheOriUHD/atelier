import { describe, expect, it, vi } from 'vitest';
import { createUpdater, looksLocal, type Docker } from './updater.ts';

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
    if (args.includes('pull')) {
      onLine?.('Pulling atelier');
      if (failPull) throw new Error('manifest unknown');
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
      job: { state: 'idle', message: null, startedAt: null, finishedAt: null },
    });
  });

  it('pulls and recreates exactly the atelier and sandbox services of this project', async () => {
    const { updater, calls, link } = setup();
    const answer = await updater.handle('POST', '/update', AUTH);
    expect(answer.status).toBe(202);
    await updater.settled();
    const compose = ['compose', '--project-name', 'atelier', '--project-directory', '/home/ada/atelier', '--file', '/home/ada/atelier/compose.yaml'];
    expect(calls.filter((c) => c[0] === 'compose')).toEqual([
      [...compose, 'pull', 'atelier', 'sandbox'],
      [...compose, 'up', '--detach', '--no-deps', 'atelier', 'sandbox'],
    ]);
    expect(link).toHaveBeenCalledWith('/home/ada/atelier', '/project');
    expect(updater.job()).toEqual({ state: 'done', message: null, startedAt: 1000, finishedAt: 1000 });
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
    expect(updater.job()).toMatchObject({ state: 'failed', message: 'manifest unknown' });
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
