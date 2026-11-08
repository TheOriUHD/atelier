import { describe, expect, it } from 'vitest';
import { filterSlash, mentionAt } from './composer.tsx';
import { COMMANDS, findCommand } from './commands.ts';

describe('the message box menus', () => {
  const items = COMMANDS.map((c) => ({ name: c.name, description: c.description }));
  it('finds commands by their start first, then loosely', () => {
    expect(filterSlash(items, 'co').map((i) => i.name).slice(0, 4)).toEqual(['compact', 'context', 'cost', 'copy']);
    expect(filterSlash(items, 'cmpct').map((i) => i.name)).toContain('compact');
  });
  it('knows an @ file mention at the cursor', () => {
    expect(mentionAt('look at @src/ap', 15)).toEqual({ start: 8, query: 'src/ap' });
    expect(mentionAt('mail me@host', 12)).toBeNull();
  });
  it('finds commands by alias', () => {
    expect(findCommand('exit')?.name).toBe('quit');
    expect(findCommand('usage')?.name).toBe('cost');
  });
});
