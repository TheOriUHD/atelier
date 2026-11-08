import { describe, expect, it } from 'vitest';
import { allowedBy } from './print.ts';

describe('--allow in print mode', () => {
  it('allows a tool, or a tool for matching commands and paths', () => {
    expect(allowedBy(['Edit'], { toolName: 'Write', input: { file_path: '/p/a' } })).toBe(true);
    expect(allowedBy(['Bash(npm test *)'], { toolName: 'Bash', input: { command: 'npm test -- --run' } })).toBe(true);
    expect(allowedBy(['Bash(npm test *)'], { toolName: 'Bash', input: { command: 'npm test' } })).toBe(true);
    expect(allowedBy(['Bash(npm test:*)'], { toolName: 'Bash', input: { command: 'npm test x' } })).toBe(true);
    expect(allowedBy(['Bash(npm test *)'], { toolName: 'Bash', input: { command: 'rm -rf /' } })).toBe(false);
    expect(allowedBy(['Read(/repo/**)'], { toolName: 'Read', input: { file_path: '/repo/src/a.ts' } })).toBe(true);
    expect(allowedBy([], { toolName: 'Read', input: {} })).toBe(false);
    expect(allowedBy(['mcp__docs__*'], { toolName: 'mcp__docs__search', input: {} })).toBe(true);
  });
});
