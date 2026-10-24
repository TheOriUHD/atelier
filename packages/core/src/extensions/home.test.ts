import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_LENDING, type DeviceRequest, type HomeScan } from '@atelier/protocol';
import { instructionGlobals } from '../instructions/instructions.ts';
import type { DeviceLinkInfo } from '../workspaces/device-links.ts';
import { DeviceHomes, filterClaudeSettings, homeAllows, homeFs, scanHome, scannedHome } from './home.ts';
import { pluginHooks, pluginSources } from './plugins.ts';
import { discoverSkills } from './skills.ts';

let home: string;
const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-home-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('what a server may read in a home folder', () => {
  it('is the config folders, the instruction files and Markdown, never credentials, history or transcripts', () => {
    const allows = (path: string, how: 'list' | 'read' = 'read') => homeAllows('/Users/ada', '/', path, how);
    expect(allows('/Users/ada/.claude/skills/notes/SKILL.md')).toBe(true);
    expect(allows('/Users/ada/.agents/skills/notes/scripts/run.py')).toBe(true);
    expect(allows('/Users/ada/.atelier/commands', 'list')).toBe(true);
    expect(allows('/Users/ada/.claude/plugins/installed_plugins.json')).toBe(true);
    expect(allows('/Users/ada/.claude/CLAUDE.md')).toBe(true);
    expect(allows('/Users/ada/notes/style.md')).toBe(true);
    // Not Markdown, or not to be listed, outside those folders.
    expect(allows('/Users/ada/notes/todo.txt')).toBe(false);
    expect(allows('/Users/ada/notes', 'list')).toBe(false);
    for (const never of ['/Users/ada/.claude/.credentials.json', '/Users/ada/.claude.json', '/Users/ada/.claude/history.jsonl', '/Users/ada/.claude/projects/app/memory/MEMORY.md', '/Users/ada/.claude/settings.json', '/Users/ada/.ssh/notes.md']) {
      expect(allows(never)).toBe(false);
    }
    // Outside the home folder, relative, or climbing out.
    expect(allows('/Users/bob/notes.md')).toBe(false);
    expect(allows('notes.md')).toBe(false);
    expect(allows('/Users/ada/.claude/skills/../../../bob/x.md')).toBe(false);
  });

  it('joins and compares paths as Windows does there', () => {
    const allows = (path: string) => homeAllows('C:\\Users\\Ada', '\\', path, 'read');
    expect(allows('C:\\Users\\Ada\\.claude\\skills\\notes\\SKILL.md')).toBe(true);
    expect(allows('C:\\Users\\Ada\\.claude\\.credentials.json')).toBe(false);
    expect(allows('D:\\Users\\Ada\\notes.md')).toBe(false);
    expect(instructionGlobals({ configDir: '/srv/atelier', home: 'C:\\Users\\Ada', claudeCode: true, stored: '' }).map((g) => g.path)).toEqual([
      '/srv/atelier/AGENTS.md',
      '/srv/atelier/ATELIER.md',
      'C:\\Users\\Ada\\.claude\\CLAUDE.md',
      'C:\\Users\\Ada\\.atelier\\ATELIER.md',
    ]);
  });

  it.skipIf(process.platform === 'win32')('follows no link to what is off limits', async () => {
    write(join(home, '.claude', '.credentials.json'), '{"token":"secret"}');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, '.claude', '.credentials.json'), join(home, '.claude', 'skills', 'creds.md'));
    expect(await homeFs(home).read(join(home, '.claude', 'skills', 'creds.md'))).toBeNull();
    write(join(home, 'big.md'), 'x'.repeat(300 * 1024));
    expect(await homeFs(home).read(join(home, 'big.md'))).toBeNull();
  });

  it("keeps only settings.json's rules, hooks and switched plugins", () => {
    const settings = filterClaudeSettings(
      JSON.stringify({
        env: { ANTHROPIC_API_KEY: 'sk-secret' },
        apiKeyHelper: 'cat ~/.key',
        permissions: { allow: ['Bash(ls:*)', 42], deny: ['Read(.env)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] }] },
        enabledPlugins: { 'tidy@market': false, odd: 'yes' },
      }),
    );
    expect(settings).toEqual({
      permissions: { allow: ['Bash(ls:*)'], ask: [], deny: ['Read(.env)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] }] },
      enabledPlugins: { 'tidy@market': false },
    });
    expect(JSON.stringify(settings)).not.toContain('sk-secret');
    expect(filterClaudeSettings('not json')).toBeNull();
  });
});

describe("a desktop's home folder on a server", () => {
  it('is found again in what the desktop sent: skills, plugins, instructions and settings', async () => {
    write(join(home, '.agents', 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: Takes notes.\n---\nWrite them down.\n');
    write(join(home, '.claude', 'commands', 'ship.md'), 'Ship it.\n');
    write(join(home, '.claude', 'CLAUDE.md'), 'Be brief. See @~/style.md\n');
    write(join(home, 'style.md'), 'Short sentences.\n');
    write(join(home, '.claude', '.credentials.json'), '{"token":"secret"}');
    write(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { KEY: 'sk-secret' }, permissions: { allow: ['Bash(ls:*)'] } }));
    const plugin = join(home, '.claude', 'plugins', 'cache', 'market', 'tidy', '1.0.0');
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tidy@market': [{ scope: 'user', installPath: plugin, version: '1.0.0' }] } }));
    write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'tidy', description: 'Tidies.' }));
    write(join(plugin, 'skills', 'sweep', 'SKILL.md'), '---\nname: sweep\ndescription: Sweeps.\n---\n');
    write(join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/done.sh' }] }] } }));

    const scan = await scanHome(home);
    expect(JSON.stringify(scan)).not.toContain('secret');
    const read: string[] = [];
    const there = scannedHome(scan, { sameMachine: true, device: { id: 'mac', name: 'MacBook' }, read: async (path) => (read.push(path), path === join(home, 'style.md') ? 'Short sentences.\n' : null) });

    const skills = await discoverSkills([{ fs: there.fs, location: 'home', scope: 'global', roots: there.roots('skills', true) }]);
    expect(skills).toEqual([expect.objectContaining({ name: 'notes', location: 'home', path: join(home, '.agents', 'skills', 'notes', 'SKILL.md') })]);
    const plugins = await there.plugins({});
    expect(plugins.map((p) => [p.id, p.enabled])).toEqual([['tidy@market', true]]);
    expect((await discoverSkills(pluginSources(plugins, 'skills', there.fs, 'home'))).map((s) => s.name)).toEqual(['tidy:sweep']);
    expect(JSON.stringify(await pluginHooks(plugins, there.fs))).toContain(`${plugin}/done.sh`);
    // The person's own switch wins over Claude Code's.
    expect((await there.plugins({ 'tidy@market': false }))[0]?.enabled).toBe(false);
    expect((await there.claudeSettings()).rules.allow).toEqual(['Bash(ls:*)']);
    // Instruction files come with the scan; what they import is asked for.
    expect(await there.reader.read(join(home, '.claude', 'CLAUDE.md'))).toBe('Be brief. See @~/style.md\n');
    expect(await there.reader.read(join(home, 'style.md'))).toBe('Short sentences.\n');
    expect(read).toEqual([join(home, 'style.md')]);
  });

  it('is asked for once, and again when the desktop says it changed or stops lending it', async () => {
    const scan: HomeScan = { home: 'C:\\Users\\Ada', sep: '\\', dirs: { 'C:\\Users\\Ada\\.claude\\skills': ['notes'] }, files: { 'C:\\Users\\Ada\\.claude\\skills\\notes\\SKILL.md': '---\nname: notes\ndescription: Takes notes.\n---\n' }, real: {}, settings: null };
    let info: DeviceLinkInfo | null = { services: ['runner', 'home'], lending: NO_LENDING, home: 'C:\\Users\\Ada', sep: '\\', os: 'win32', app: '0.3.0' };
    const asked: DeviceRequest[] = [];
    const homes = new DeviceHomes(
      {
        ready: async () => info,
        request: async (_userId, _deviceId, request) => (asked.push(request), scan),
      },
      async () => 'Laptop',
    );
    const there = await homes.get('u1', 'pc', false);
    expect(there).toMatchObject({ home: 'C:\\Users\\Ada', sameMachine: false, device: { name: 'Laptop' } });
    expect(there!.roots('skills', true)).toEqual(['C:\\Users\\Ada\\.atelier\\skills', 'C:\\Users\\Ada\\.agents\\skills', 'C:\\Users\\Ada\\.claude\\skills']);
    expect((await discoverSkills([{ fs: there!.fs, location: 'home', scope: 'global', roots: there!.roots('skills', true) }])).map((s) => s.path)).toEqual(['C:\\Users\\Ada\\.claude\\skills\\notes\\SKILL.md']);
    await homes.get('u1', 'pc', true);
    expect(asked).toHaveLength(1);
    homes.forget('u1', 'pc');
    await homes.get('u1', 'pc', true);
    expect(asked).toHaveLength(2);
    info = { ...info, lending: { ...NO_LENDING, home: false } };
    expect(await homes.get('u1', 'pc', true)).toBeNull();
    info = null;
    expect(await homes.get('u1', 'pc', true)).toBeNull();
    expect(asked).toHaveLength(2);
  });
});
