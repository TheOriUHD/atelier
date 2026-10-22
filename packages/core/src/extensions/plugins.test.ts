import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCommands } from './commands.ts';
import { claudeCodePlugins, pluginHooks, pluginSources } from './plugins.ts';
import { discoverSkills, renderSkill } from './skills.ts';

let home: string;
const put = async (path: string, text: string) => {
  await mkdir(join(home, path, '..'), { recursive: true });
  await writeFile(join(home, path), text);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'atelier-plugins-'));
  const cache = (name: string) => join(home, '.claude', 'plugins', 'cache', 'mkt', name, '1.0.0');
  await put(
    '.claude/plugins/installed_plugins.json',
    JSON.stringify({
      version: 2,
      plugins: {
        'deploy@mkt': [{ scope: 'user', installPath: cache('deploy'), version: '1.0.0' }],
        'docs@mkt': [{ scope: 'user', installPath: cache('docs'), version: '1.0.0' }],
      },
    }),
  );
  await put('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'docs@mkt': false } }));
  await put('.claude/plugins/cache/mkt/deploy/1.0.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'deploy', description: 'Ship it', version: '1.0.0', skills: './tools' }));
  await put('.claude/plugins/cache/mkt/deploy/1.0.0/tools/release/SKILL.md', '---\nname: release\ndescription: Cut a release\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/release.sh');
  await put('.claude/plugins/cache/mkt/deploy/1.0.0/commands/rollback.md', 'Roll back the last deploy');
  await put('.claude/plugins/cache/mkt/docs/1.0.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'docs' }));
  await put('.claude/plugins/cache/mkt/docs/1.0.0/skills/write/SKILL.md', '---\nname: write\ndescription: Write docs\n---\nBody');
  const hooks = (command: string) => JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command }] }] } });
  await put('.claude/plugins/cache/mkt/deploy/1.0.0/hooks/hooks.json', hooks('"${CLAUDE_PLUGIN_ROOT}/bin/fmt.sh"'));
  await put('.claude/plugins/cache/mkt/docs/1.0.0/hooks/hooks.json', hooks('docs-only'));
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe('Claude Code plugins', () => {
  it('reads installs and manifests, with Atelier’s switches over Claude Code’s', async () => {
    const plugins = await claudeCodePlugins(home, {});
    expect(plugins.map((p) => [p.id, p.name, p.description, p.enabled])).toEqual([
      ['deploy@mkt', 'deploy', 'Ship it', true],
      ['docs@mkt', 'docs', '', false],
    ]);
    expect((await claudeCodePlugins(home, { 'docs@mkt': true, 'deploy@mkt': false })).map((p) => p.enabled)).toEqual([false, true]);
    expect(await claudeCodePlugins(join(home, 'nowhere'), {})).toEqual([]);
  });

  it('adds enabled plugins’ skills and commands under plugin:name, with CLAUDE_PLUGIN_ROOT', async () => {
    const plugins = await claudeCodePlugins(home, {});
    const skills = await discoverSkills(pluginSources(plugins, 'skills'));
    expect(skills.map((s) => [s.name, s.scope])).toEqual([['deploy:release', 'plugin']]);
    const root = plugins[0]!.root;
    expect(renderSkill(skills[0]!, '---\nname: release\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/release.sh', '', { projectDir: '', sessionId: 's' })).toContain(`Run ${root}/bin/release.sh`);
    expect((await discoverCommands(pluginSources(plugins, 'commands'))).map((c) => c.name)).toEqual(['deploy:rollback']);
  });

  it('runs enabled plugins’ hooks with CLAUDE_PLUGIN_ROOT filled in', async () => {
    const plugins = await claudeCodePlugins(home, {});
    expect(await pluginHooks(plugins)).toEqual([
      { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `"${plugins[0]!.root}/bin/fmt.sh"` }] }] },
    ]);
  });
});

