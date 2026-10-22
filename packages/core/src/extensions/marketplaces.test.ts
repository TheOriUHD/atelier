import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atelierPlugins, browseMarketplace, installPlugin, uninstallPlugin, type PluginTarget } from './marketplaces.ts';
import { discoverSkills } from './skills.ts';
import { pluginSources } from './plugins.ts';

let work: string;
let target: PluginTarget;
const tarballs = new Map<string, Buffer>();

/** Makes `owner/repo` at commit `sha` with these files, as GitHub would serve it. */
async function repo(name: string, sha: string, files: Record<string, string>) {
  const top = join(work, 'src', `${name.replace('/', '-')}-${sha}`);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(top, path, '..'), { recursive: true });
    await writeFile(join(top, path), text);
  }
  const file = join(work, `${sha}.tar.gz`);
  await createTar({ gzip: true, file, cwd: join(work, 'src') }, [`${name.replace('/', '-')}-${sha}`]);
  tarballs.set(name, await readFile(file));
}

const github = async (url: string): Promise<Response> => {
  const api = /^https:\/\/api\.github\.com\/repos\/([\w-]+\/[\w-]+)(\/commits\/.+)?$/.exec(url);
  if (api && tarballs.has(api[1]!)) return Response.json(api[2] ? { sha: api[1] === 'acme/market' ? 'm1' : 'r1' } : { default_branch: 'main' });
  const code = /^https:\/\/codeload\.github\.com\/([\w-]+\/[\w-]+)\/tar\.gz\//.exec(url);
  if (code && tarballs.has(code[1]!)) return new Response(new Uint8Array(tarballs.get(code[1]!)!));
  return new Response('', { status: 404 });
};

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'atelier-market-'));
  target = { cache: join(work, 'config', 'plugins', 'cache'), registry: join(work, 'config', 'plugins', 'installed.json') };
  const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} things\n---\nBody`;
  await repo('acme/market', 'm1', {
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'acme',
      plugins: [
        { name: 'fmt', description: 'Formatting', version: '1.2.0', source: './plugins/fmt' },
        { name: 'remote', source: { source: 'github', repo: 'acme/remote-plugin', path: 'plugin' } },
        { name: 'npm-one', source: { source: 'npm', package: 'x' } },
        { name: 'escape', source: '../../etc' },
        { name: 'climb', version: '../../..', source: './plugins/fmt' },
      ],
    }),
    'plugins/fmt/.claude-plugin/plugin.json': JSON.stringify({ name: 'fmt', description: 'Formats code' }),
    'plugins/fmt/skills/prettier/SKILL.md': skill('prettier'),
  });
  await repo('acme/remote-plugin', 'r1', { 'plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'remote' }), 'plugin/skills/deploy/SKILL.md': skill('deploy') });
});
afterEach(() => rm(work, { recursive: true, force: true }));

describe('marketplaces', () => {
  it('lists a marketplace’s plugins and says which can’t be installed', async () => {
    expect(await browseMarketplace('acme/market', github)).toEqual({
      name: 'acme',
      plugins: [
        { name: 'fmt', description: 'Formatting', version: '1.2.0' },
        { name: 'remote', description: '', version: '' },
        { name: 'npm-one', description: '', version: '', unsupported: 'Plugins from “npm” sources can’t be installed yet.'.replace('’', "'") },
        { name: 'escape', description: '', version: '' },
        { name: 'climb', description: '', version: '' },
      ],
    });
  });

  it('installs from the marketplace repo or the plugin’s own, and uninstalls', async () => {
    expect(await installPlugin('https://github.com/acme/market', 'fmt', target, github)).toBe('fmt@acme');
    expect(await installPlugin('acme/market', 'remote', target, github)).toBe('remote@acme');
    const plugins = await atelierPlugins(target, { 'remote@acme': false });
    expect(plugins.map((p) => [p.id, p.description, p.version, p.source, p.enabled])).toEqual([
      ['fmt@acme', 'Formats code', '1.2.0', 'atelier', true],
      ['remote@acme', '', 'r1', 'atelier', false],
    ]);
    expect((await discoverSkills(pluginSources(plugins, 'skills'))).map((s) => s.name)).toEqual(['fmt:prettier']);

    await expect(installPlugin('acme/market', 'npm-one', target, github)).rejects.toThrow(/“npm” sources/);
    await expect(installPlugin('acme/market', 'escape', target, github)).rejects.toThrow(/outside its marketplace/);
    await expect(installPlugin('acme/market', 'nope', target, github)).rejects.toThrow(/no plugin named/);
    // A version that would climb out of the cache is ignored: the install is named by the commit.
    expect(await installPlugin('acme/market', 'climb', target, github)).toBe('climb@acme');
    expect((await atelierPlugins(target, {})).find((p) => p.id === 'climb@acme')?.version).toBe('m1');

    await uninstallPlugin('fmt@acme', target);
    await uninstallPlugin('climb@acme', target);
    expect((await atelierPlugins(target, {})).map((p) => p.id)).toEqual(['remote@acme']);
    await expect(uninstallPlugin('fmt@acme', target)).rejects.toThrow(/wasn't installed by Atelier/);
  });
  it('refuses marketplaces whose names would leave the cache', async () => {
    await repo('evil/market', 'e1', { '.claude-plugin/marketplace.json': JSON.stringify({ name: '..', plugins: [{ name: '..', source: './x' }] }), 'x/README.md': 'x' });
    await expect(installPlugin('evil/market', '..', target, github)).rejects.toThrow(/no valid .claude-plugin\/marketplace.json/);
  });

  it('never deletes outside the cache when uninstalling', async () => {
    const outside = join(work, 'precious');
    await mkdir(join(outside, 'data'), { recursive: true });
    await mkdir(join(target.registry, '..'), { recursive: true });
    await writeFile(target.registry, JSON.stringify({ version: 1, plugins: { 'x@y': { installPath: outside, version: '1', sha: 's', installedAt: '' } } }));
    await uninstallPlugin('x@y', target);
    await expect(readdir(outside)).resolves.toEqual(['data']);
  });

  it('drops links from downloaded archives', async () => {
    const top = join(work, 'src', 'acme-links-l1');
    await mkdir(join(top, '.claude-plugin'), { recursive: true });
    await writeFile(join(top, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'links', plugins: [{ name: 'p', source: './' }] }));
    await symlink('/etc/hosts', join(top, 'hosts'));
    await createTar({ gzip: true, file: join(work, 'l1.tar.gz'), cwd: join(work, 'src') }, ['acme-links-l1']);
    tarballs.set('acme/links', await readFile(join(work, 'l1.tar.gz')));
    await installPlugin('acme/links', 'p', target, github);
    const [installed] = await atelierPlugins(target, {});
    expect(await readdir(installed!.root)).toEqual(['.claude-plugin']);
  });
});
