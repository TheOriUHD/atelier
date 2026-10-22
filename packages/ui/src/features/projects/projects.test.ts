import { describe, expect, it } from 'vitest';
import { PROJECT_FILE_BUDGET_TOKENS, type FileRef } from '@atelier/protocol';
import { fileBudget, fileType, projectMeta, visibleProjects } from './projects.ts';

const project = (name: string, description: string, updatedAt: number) => ({ name, description, updatedAt });
const projects = [project('beta', 'Launch plan', 2), project('Alpha', 'Research notes', 1), project('gamma', 'Plans for the garden', 3)];
const names = (list: { name: string }[]) => list.map((p) => p.name);

describe('visibleProjects', () => {
  it('sorts by most recently updated or by name', () => {
    expect(names(visibleProjects(projects, '', 'updated'))).toEqual(['gamma', 'beta', 'Alpha']);
    expect(names(visibleProjects(projects, '', 'name'))).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('filters by name and description, ignoring case and surrounding space', () => {
    expect(names(visibleProjects(projects, '  PLAN ', 'name'))).toEqual(['beta', 'gamma']);
    expect(names(visibleProjects(projects, 'alp', 'name'))).toEqual(['Alpha']);
    expect(visibleProjects(projects, 'nothing', 'name')).toEqual([]);
  });

  it('leaves the input untouched', () => {
    visibleProjects(projects, '', 'name');
    expect(names(projects)).toEqual(['beta', 'Alpha', 'gamma']);
  });
});

describe('projectMeta', () => {
  const now = Date.UTC(2026, 9, 13, 12);
  it('lists the update time and non-zero counts', () => {
    expect(projectMeta({ updatedAt: now - 3 * 86_400_000, sessionCount: 4, fileCount: 1 }, now)).toBe('Updated 3 days ago · 4 chats · 1 file');
    expect(projectMeta({ updatedAt: now, sessionCount: 0, fileCount: 0 }, now)).toBe('Updated just now');
  });
});

describe('fileBudget', () => {
  const file = (id: string, tokens: number | null): FileRef => ({ id, name: `${id}.txt`, mime: 'text/plain', size: 1, blob: id, kind: 'project', tokens, createdAt: 0 });

  it('totals the text files against the shared budget', () => {
    const budget = fileBudget([file('a', 1000), file('img', null), file('b', 500)]);
    expect(budget).toEqual({ total: 1500, budget: PROJECT_FILE_BUDGET_TOKENS, overBudget: new Set() });
  });

  it('flags the text files that do not fit, in upload order', () => {
    const half = PROJECT_FILE_BUDGET_TOKENS / 2;
    const budget = fileBudget([file('a', half), file('b', half + 1), file('c', half), file('img', null)]);
    expect(budget.total).toBe(3 * half + 1);
    expect([...budget.overBudget]).toEqual(['b']);
  });
});

describe('fileType', () => {
  it('prefers the extension and falls back to the MIME subtype', () => {
    expect(fileType({ name: 'report.final.pdf', mime: 'application/pdf' })).toBe('PDF');
    expect(fileType({ name: 'README', mime: 'text/markdown' })).toBe('MARKDOWN');
  });
});
