import { describe, expect, it } from 'vitest';
import { describeImportChanges, mergeMemoryLines, memoryLines, splitMemoryExport } from './memory.ts';

describe('memory details as lines', () => {
  it('read bullets of any kind and merge without losing lines', () => {
    expect(memoryLines('- a\n* b\n\n1. c\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(mergeMemoryLines('- a\n- b', { add: ['c', 'A'], replace: [{ old: 'b', new: 'b2' }, { old: 'missing', new: 'e' }] })).toBe('- a\n- b2\n- e\n- c');
    expect(mergeMemoryLines('- a\n- b', { remove: ['a'], add: ['a'] })).toBe('- b');
  });
});

describe('splitMemoryExport', () => {
  it('keeps every line, cuts long sections with their heading repeated and drops code fences', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `[unknown] - Fact ${i} ${'x'.repeat(60)}`);
    const parts = splitMemoryExport(['```', '## Identity', 'Name is Ada', '## Career', ...lines, '```'].join('\n'), 1_000);
    expect(parts.length).toBeGreaterThan(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1_000);
    expect(parts.join('\n')).not.toContain('```');
    for (let i = 0; i < 50; i++) expect(parts.some((p) => p.includes(`Fact ${i} `))).toBe(true);
    expect(parts.slice(1).every((p) => p.startsWith('## Career'))).toBe(true);
    expect(parts[0]).toMatch(/^## Identity\nName is Ada\n\n## Career/);
  });
});

describe('describeImportChanges', () => {
  it('counts new entries and names updated ones once', () => {
    expect(
      describeImportChanges([
        { op: 'created', id: 'a', title: 'NVR app', section: 'area' },
        { op: 'updated', id: 'a', title: 'NVR app', section: 'area' },
        { op: 'created', id: 'b', title: 'Sam', section: 'person' },
        { op: 'updated', id: 'p', title: 'Profile', section: 'profile' },
        { op: 'updated', id: 'q', title: 'Preferences', section: 'preferences' },
        { op: 'updated', id: 'p', title: 'Profile', section: 'profile' },
      ]),
    ).toBe('Added 2 entries, updated Profile and Preferences');
    expect(describeImportChanges([])).toBe('Nothing in it could be added to memory');
  });
});
