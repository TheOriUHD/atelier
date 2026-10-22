import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedSkills, installSkills, parseSource, uninstallSkill, type InstallTarget } from './skill-install.ts';

let work: string;
let target: InstallTarget;
let tarball: Buffer;
const requested: string[] = [];

/** GitHub as far as the installer sees it: the repo, a commit and its tarball. */
const github = async (url: string): Promise<Response> => {
  requested.push(url);
  if (url === 'https://api.github.com/repos/acme/skills') return Response.json({ default_branch: 'main' });
  if (url === 'https://api.github.com/repos/acme/skills/commits/main') return Response.json({ sha: 'abc123' });
  if (url === 'https://codeload.github.com/acme/skills/tar.gz/abc123') return new Response(new Uint8Array(tarball));
  return new Response('not found', { status: 404 });
};

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'atelier-install-'));
  const repo = join(work, 'src', 'skills-abc123');
  const put = async (path: string, text: string) => {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), text);
  };
  await put('README.md', '# Skills');
  await put('skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Work with PDFs\n---\nUse scripts/extract.py');
  await put('skills/pdf/scripts/extract.py', 'print("hi")');
  await put('skills/xlsx/SKILL.md', '---\nname: xlsx\ndescription: Spreadsheets\n---\nBody');
  const file = join(work, 'repo.tar.gz');
  await createTar({ gzip: true, file, cwd: join(work, 'src') }, ['skills-abc123']);
  tarball = await readFile(file);
  target = { root: join(work, 'home', '.agents', 'skills'), linkFrom: join(work, 'home', '.claude', 'skills'), lockFile: join(work, 'home', '.atelier', 'skills-lock.json') };
  await mkdir(join(work, 'home', '.atelier'), { recursive: true });
  requested.length = 0;
});
afterEach(() => rm(work, { recursive: true, force: true }));

describe('skill install', () => {
  it('parses sources', () => {
    expect(parseSource('acme/skills')).toEqual({ owner: 'acme', repo: 'skills', path: '' });
    expect(parseSource('acme/skills@v2/skills/pdf')).toEqual({ owner: 'acme', repo: 'skills', ref: 'v2', path: 'skills/pdf' });
    expect(parseSource('https://github.com/acme/skills/tree/main/skills/pdf/')).toEqual({ owner: 'acme', repo: 'skills', ref: 'main', path: 'skills/pdf' });
    expect(() => parseSource('not a source')).toThrow(/owner\/repo/);
  });

  it('installs every skill under the path, links it for Claude Code and records it', async () => {
    expect(await installSkills('acme/skills', target, github)).toEqual(['pdf', 'xlsx']);
    expect(await readFile(join(target.root, 'pdf', 'scripts', 'extract.py'), 'utf8')).toBe('print("hi")');
    expect((await readlink(join(target.linkFrom!, 'pdf'))).replaceAll('\\', '/')).toBe('../../.agents/skills/pdf');
    expect(await installedSkills(target)).toMatchObject({ pdf: { source: 'acme/skills', sha: 'abc123', path: 'skills/pdf' }, xlsx: { path: 'skills/xlsx' } });

    await uninstallSkill('pdf', target);
    expect(await lstat(join(target.root, 'pdf')).catch(() => null)).toBeNull();
    expect(await lstat(join(target.linkFrom!, 'pdf')).catch(() => null)).toBeNull();
    await expect(uninstallSkill('pdf', target)).rejects.toThrow(/wasn't installed by Atelier/);
  });

  it('leaves skills from elsewhere alone unless asked to replace them', async () => {
    await mkdir(join(target.root, 'xlsx'), { recursive: true });
    await writeFile(join(target.root, 'xlsx', 'SKILL.md'), 'someone else’s');
    await expect(installSkills('acme/skills/skills/xlsx', target, github)).rejects.toMatchObject({ code: 'skill_exists', data: { name: 'xlsx' } });
    expect(await installSkills('acme/skills/skills/xlsx', target, github, true)).toEqual(['xlsx']);
    await expect(installSkills('acme/missing', target, github)).rejects.toThrow(/wasn't found/);
    await expect(installSkills('acme/skills/docs', target, github)).rejects.toThrow(/No SKILL.md/);
  });
});
