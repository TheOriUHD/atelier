import { describe, expect, it } from 'vitest';
import { PROJECT_FILE_BUDGET_TOKENS, projectFilesInPrompt } from './domain.ts';

const file = (id: string, tokens: number | null) => ({ id, tokens });

describe('projectFilesInPrompt', () => {
  it('includes every text file while the total fits', () => {
    const files = [file('a', 10_000), file('b', 50_000)];
    expect(projectFilesInPrompt(files)).toEqual(files);
  });

  it('skips files past the budget but keeps later ones that still fit', () => {
    const files = [file('a', 40_000), file('big', 30_000), file('c', 20_000), file('d', 1)];
    expect(projectFilesInPrompt(files).map((f) => f.id)).toEqual(['a', 'c']);
  });

  it('never includes files without extractable text', () => {
    expect(projectFilesInPrompt([file('img', null), file('txt', 5)]).map((f) => f.id)).toEqual(['txt']);
  });

  it('defaults to the shared budget', () => {
    expect(projectFilesInPrompt([file('exact', PROJECT_FILE_BUDGET_TOKENS)])).toHaveLength(1);
    expect(projectFilesInPrompt([file('over', PROJECT_FILE_BUDGET_TOKENS + 1)])).toHaveLength(0);
  });
});
