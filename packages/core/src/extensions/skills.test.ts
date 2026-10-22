import { describe, expect, it } from 'vitest';
import { discoverSkills, parseSkill, renderSkill, renderSkillList, type ExtensionFs } from './skills.ts';

/** Files under a root; `links` maps a path to where it really points. */
function memoryFs(files: Record<string, string>, links: Record<string, string> = {}): ExtensionFs {
  return {
    sep: '/',
    list: async (dir) => [...new Set(Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]!))],
    read: async (path) => files[path] ?? null,
    realpath: async (path) => links[path] ?? path,
  };
}
const skill = (name: string, description: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nDo the ${name} thing.\n`;

describe('skills', () => {
  it('prefers project skills, then earlier roots, and counts linked folders once', async () => {
    const project = memoryFs({ '/w/.claude/skills/pdf/SKILL.md': skill('pdf', 'Project PDF tools') });
    const host = memoryFs(
      {
        '/home/.agents/skills/pdf/SKILL.md': skill('pdf', 'Global PDF tools'),
        '/home/.agents/skills/xlsx/SKILL.md': skill('xlsx', 'Spreadsheets'),
        '/home/.claude/skills/xlsx/SKILL.md': skill('xlsx', 'Spreadsheets'),
        '/home/.claude/skills/notes/README.md': 'not a skill',
        '/home/.claude/skills/.hidden/SKILL.md': skill('hidden', 'Hidden'),
      },
      { '/home/.claude/skills/xlsx': '/home/.agents/skills/xlsx' },
    );
    const skills = await discoverSkills([
      { fs: project, location: 'workspace', scope: 'project', roots: ['/w/.atelier/skills', '/w/.claude/skills'] },
      { fs: host, location: 'host', scope: 'global', roots: ['/home/.agents/skills', '/home/.claude/skills'] },
    ]);
    expect(skills.map((s) => [s.name, s.description, s.scope, s.dir])).toEqual([
      ['pdf', 'Project PDF tools', 'project', '/w/.claude/skills/pdf'],
      ['xlsx', 'Spreadsheets', 'global', '/home/.agents/skills/xlsx'],
    ]);
  });

  it('reads real-world frontmatter leniently', () => {
    // An installer that drops a newline after a boolean: repaired, and the rest of the YAML still counts.
    const runTogether = '---\ndisable-model-invocation: truename: academy-guide\ndescription: >\n  Recommends courses\n  for learning to cook.\n---\nBody';
    expect(parseSkill(runTogether, 'academy-guide')).toMatchObject({ name: 'academy-guide', description: 'Recommends courses for learning to cook.', disableModelInvocation: true, warnings: [] });
    // Not YAML at all: the name and folded description are still read.
    const broken = '---\nname: notes\ndescription: >\n  Keeps notes\n  tidy.\nbad: [unclosed\n---\nBody';
    expect(parseSkill(broken, 'notes')).toMatchObject({ name: 'notes', description: 'Keeps notes tidy.', warnings: [expect.stringContaining('isn’t valid YAML')] });
    expect(parseSkill(skill('Other_Name', 'x'), 'tool')).toMatchObject({ name: 'tool', warnings: [expect.stringContaining("isn't a valid skill name")] });
    expect(parseSkill(skill('alpha', 'x'), 'beta')).toMatchObject({ name: 'alpha', warnings: [expect.stringContaining('differs from its folder')] });
    expect(parseSkill('---\nname: empty\n---\nBody', 'empty')).toBeNull();
    expect(parseSkill(skill('manual', 'Only by hand', 'disable-model-invocation: true\nuser-invocable: true\nargument-hint: <file>\n'), 'manual')).toMatchObject({
      disableModelInvocation: true,
      userInvocable: true,
      argumentHint: '<file>',
    });
  });

  it('lists what fits the budget and leaves out skills only people may start', () => {
    const base = { dir: '/s', path: '/s/SKILL.md', scope: 'global' as const, location: 'host' as const, userInvocable: true, warnings: [] };
    const list = [
      { ...base, name: 'a', description: 'First', disableModelInvocation: false },
      { ...base, name: 'b', description: 'Manual only', disableModelInvocation: true },
      { ...base, name: 'c', description: 'x'.repeat(400), disableModelInvocation: false },
    ];
    const text = renderSkillList(list, 60);
    expect(text).toContain('- a: First');
    expect(text).not.toContain('- b');
    expect(text).toContain('(1 more not listed;');
    expect(renderSkillList([list[1]!], 1000)).toBe('');
  });

  it('fills in arguments and variables, or appends the arguments', () => {
    const s = { name: 'fix', description: 'd', dir: '/skills/fix', path: '/skills/fix/SKILL.md', scope: 'global' as const, location: 'host' as const, disableModelInvocation: false, userInvocable: true, warnings: [] };
    const vars = { projectDir: '/w', sessionId: 's1' };
    expect(renderSkill(s, '---\nname: fix\n---\nFix issue $0 in ${CLAUDE_PROJECT_DIR} ($ARGUMENTS), run ${CLAUDE_SKILL_DIR}/check.sh for ${CLAUDE_SESSION_ID}', '123 urgent', vars)).toBe(
      'Base directory for this skill: /skills/fix\n\nFix issue 123 in /w (123 urgent), run /skills/fix/check.sh for s1',
    );
    expect(renderSkill(s, 'Just do it.', 'now', vars)).toBe('Base directory for this skill: /skills/fix\n\nJust do it.\n\nARGUMENTS: now');
  });
});
