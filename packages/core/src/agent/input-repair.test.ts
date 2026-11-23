import { describe, expect, it } from 'vitest';
import { createAskUserTool } from '../tools/ask-user.ts';
import { createSearchTools } from '../tools/code/search.ts';
import { createValidatorCache } from '../providers/prompted-tools.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { parseStringifiedArgs } from './loop.ts';

const validatorFor = createValidatorCache();

// Inputs models really sent in Atelier sessions (2026-10/11), each refused before: now repaired and accepted.
const grep = createSearchTools({ root: '/w' } as unknown as Workspace).find((t) => t.name === 'Grep')!;
const askUser = createAskUserTool(async () => ({ answers: {} }));

describe('repairing a tool call the model got slightly wrong', () => {
  it('reads Grep’s context flags sent without their dash', () => {
    const sent = { pattern: 'TODO', output_mode: 'content', C: 2, A: 1 };
    const validate = validatorFor({ name: 'Grep', description: '', inputSchema: grep.inputSchema })!;
    expect(validate(sent)).toBe(false);
    const repaired = parseStringifiedArgs(sent, grep.inputSchema);
    expect(repaired).toEqual({ pattern: 'TODO', output_mode: 'content', '-C': 2, '-A': 1 });
    expect(validate(repaired)).toBe(true);
  });

  it('keeps a flag sent both ways as the dashed one says', () => {
    expect(parseStringifiedArgs({ pattern: 'x', C: 5, '-C': 1 }, grep.inputSchema)).toBeNull();
  });

  it('shortens an AskUser header over its 12 characters instead of refusing the question', () => {
    const sent = {
      questions: [{ question: 'Which database should the shop use?', header: 'Database engine', options: [{ label: 'Postgres', description: 'Robust' }, { label: 'SQLite', description: 'Simple' }], multiSelect: false }],
    };
    const validate = validatorFor({ name: 'AskUser', description: '', inputSchema: askUser.inputSchema })!;
    expect(validate(sent)).toBe(false);
    const repaired = parseStringifiedArgs(sent, askUser.inputSchema) as typeof sent;
    expect(repaired.questions[0]!.header).toBe('Database en…');
    expect(repaired.questions[0]!.question).toBe('Which database should the shop use?');
    expect(validate(repaired)).toBe(true);
  });

  it('leaves a correct call alone', () => {
    expect(parseStringifiedArgs({ pattern: 'x', '-n': true }, grep.inputSchema)).toBeNull();
  });
});
