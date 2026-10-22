import { describe, expect, it } from 'vitest';
import { agentModel, discoverAgents, parseAgent } from './agents.ts';
import type { ExtensionFs } from './skills.ts';

const memoryFs = (files: Record<string, string>): ExtensionFs => ({
  sep: '/',
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
  read: async (path) => files[path] ?? null,
  realpath: async (path) => path,
});

describe('agent definitions', () => {
  it('reads tools, model and turn limits from frontmatter', () => {
    expect(parseAgent('---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep, Glob\nmodel: haiku\nmaxTurns: 5\n---\nYou review code.', 'x')).toEqual({
      name: 'reviewer',
      description: 'Reviews diffs',
      tools: ['Read', 'Grep', 'Glob'],
      disallowedTools: [],
      model: 'haiku',
      maxTurns: 5,
    });
    expect(parseAgent('---\ndescription: Anything\ntools: ["*"]\ndisallowedTools: [Bash]\nmodel: inherit\n---\nBody', 'helper')).toMatchObject({ name: 'helper', tools: null, disallowedTools: ['Bash'], model: null });
    expect(parseAgent('---\nname: nodesc\n---\nBody', 'nodesc')).toBeNull();
  });

  it('prefers project definitions and never replaces general-purpose', async () => {
    const agents = await discoverAgents([
      { fs: memoryFs({ '/w/.claude/agents/reviewer.md': '---\ndescription: Project reviewer\n---\nP' }), location: 'workspace', scope: 'project', roots: ['/w/.claude/agents'] },
      {
        fs: memoryFs({ '/h/agents/reviewer.md': '---\ndescription: Global reviewer\n---\nG', '/h/agents/general-purpose.md': '---\ndescription: Nope\n---\nX', '/h/agents/notes.txt': 'x' }),
        location: 'host',
        scope: 'global',
        roots: ['/h/agents'],
      },
    ]);
    expect(agents.map((a) => [a.name, a.description, a.scope])).toEqual([['reviewer', 'Project reviewer', 'project']]);
  });

  it('maps model aliases through settings and inherits otherwise', () => {
    const def = (model: string | null) => ({ name: 'a', description: 'd', tools: null, disallowedTools: [], model, maxTurns: null, path: '', scope: 'global' as const, location: 'host' as const });
    expect(agentModel(def('haiku'), { haiku: 'anthropic/claude-haiku-5-5' }, 'ollama/qwen3')).toBe('anthropic/claude-haiku-5-5');
    expect(agentModel(def('opus'), {}, 'ollama/qwen3')).toBe('ollama/qwen3');
    expect(agentModel(def(null), {}, 'ollama/qwen3')).toBe('ollama/qwen3');
    expect(agentModel(def('openai/gpt-6'), {}, 'ollama/qwen3')).toBe('openai/gpt-6');
  });
});
