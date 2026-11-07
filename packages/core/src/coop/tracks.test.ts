import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../workspaces/workspace.ts';
import { addTrack, mergeTrack, removeTrack, TrackError, trackBranch, trackDiff } from './tracks.ts';

const run = promisify(execFile);
let dir: string;
const author = { name: 'Ada', email: 'ada@example.com' };

/** A workspace whose runner runs commands here, as the real runner would on the folder's machine. */
function workspace(root: string): Workspace {
  return {
    root,
    runner: {
      call: async (_method: string, params: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
        try {
          const { stdout, stderr } = await run(params.argv[0]!, params.argv.slice(1), { cwd: params.cwd, env: { ...process.env, ...params.env } });
          return { exitCode: 0, stdout, stderr, timedOut: false };
        } catch (e) {
          const err = e as { code?: number; stdout?: string; stderr?: string };
          return { exitCode: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', timedOut: false };
        }
      },
    },
  } as unknown as Workspace;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-tracks-'));
  const repo = join(dir, 'repo');
  await run('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'water.glsl'), 'speed = 1.0;\n');
  await run('git', ['add', '-A'], { cwd: repo });
  await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parallel tracks in git worktrees', () => {
  it('a track works in its own worktree; its changes merge into the folder on its own branch', async () => {
    const main = workspace(join(dir, 'repo'));
    const branch = trackBranch('Ben Müller', '01HXYZABCDEF');
    expect(branch).toBe('atelier/track-ben-m-ller-01hxyzabcd');
    const path = join(dir, 'tracks', 'repo-1');
    const base = await addTrack(main, branch, path);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    // The agent edits one file and adds another, and commits nothing itself.
    writeFileSync(join(path, 'water.glsl'), 'speed = 0.5;\n');
    writeFileSync(join(path, 'foam.glsl'), 'foam = true;\n');
    const track = workspace(path);
    const { diff } = await trackDiff(track, base);
    expect(diff).toContain('-speed = 1.0;');
    expect(diff).toContain('+speed = 0.5;');
    expect(diff).toContain('+foam = true;');
    // The main folder hasn't changed meanwhile.
    expect(readFileSync(join(dir, 'repo', 'water.glsl'), 'utf8')).toBe('speed = 1.0;\n');

    await mergeTrack(main, track, branch, 'Slower waves', author);
    expect(readFileSync(join(dir, 'repo', 'water.glsl'), 'utf8')).toBe('speed = 0.5;\n');
    expect(existsSync(join(dir, 'repo', 'foam.glsl'))).toBe(true);
    const log = (await run('git', ['log', '--format=%an %s', '-3'], { cwd: join(dir, 'repo') })).stdout;
    expect(log).toContain('Ada Merge branch');
    expect(log).toContain('Ada Slower waves');

    await removeTrack(main, branch, path);
    expect(existsSync(path)).toBe(false);
    expect((await run('git', ['branch'], { cwd: join(dir, 'repo') })).stdout).not.toContain(branch);
  });

  it('a track that conflicts with the folder is refused and leaves the folder as it was', async () => {
    const main = workspace(join(dir, 'repo'));
    const branch = trackBranch('Ben', 'two');
    const path = join(dir, 'tracks', 'repo-2');
    await addTrack(main, branch, path);
    writeFileSync(join(path, 'water.glsl'), 'speed = 0.5;\n');
    // Meanwhile the host's own turn changed the same line, and committed it.
    writeFileSync(join(dir, 'repo', 'water.glsl'), 'speed = 2.0;\n');
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'faster'], { cwd: join(dir, 'repo') });
    await expect(mergeTrack(main, workspace(path), branch, 'Slower waves', author)).rejects.toThrow(TrackError);
    expect(readFileSync(join(dir, 'repo', 'water.glsl'), 'utf8')).toBe('speed = 2.0;\n');
    expect((await run('git', ['status', '--porcelain'], { cwd: join(dir, 'repo') })).stdout).toBe('');
  });

  it('needs a repository with a commit', async () => {
    const empty = join(dir, 'empty');
    await run('git', ['init', '-q', empty]);
    await expect(addTrack(workspace(empty), 'atelier/track-x-1', join(dir, 'tracks', 'x'))).rejects.toThrow('at least one commit');
  });
});
