import { PROJECT_FILE_BUDGET_TOKENS, projectFilesInPrompt, type FileRef, type Project } from '@atelier/protocol';
import { relativeTime } from '../../lib/dates.ts';

export type ProjectSort = 'updated' | 'name';

/** Projects whose name or description contains the query (case-insensitive), in the chosen order. */
export function visibleProjects<P extends Pick<Project, 'name' | 'description' | 'updatedAt'>>(projects: readonly P[], query: string, sort: ProjectSort): P[] {
  const q = query.trim().toLowerCase();
  const matches = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) : [...projects];
  return matches.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : (a, b) => b.updatedAt - a.updatedAt);
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "Updated 3 days ago · 4 chats · 2 files"; zero counts are left out. */
export function projectMeta(p: { updatedAt: number; sessionCount: number; fileCount: number }, now = Date.now()): string {
  return [`Updated ${relativeTime(p.updatedAt, now)}`, p.sessionCount > 0 && count(p.sessionCount, 'chat'), p.fileCount > 0 && count(p.fileCount, 'file')]
    .filter(Boolean)
    .join(' · ');
}

export interface FileBudget {
  /** Estimated tokens of every file with text. */
  total: number;
  budget: number;
  /** Text files that don't fit the budget and are left out of the prompt. */
  overBudget: Set<string>;
}

/** How a project's files use the prompt budget; mirrors the chat service's selection. */
export function fileBudget(files: readonly FileRef[]): FileBudget {
  const included = new Set(projectFilesInPrompt(files).map((f) => f.id));
  return {
    total: files.reduce((sum, f) => sum + (f.tokens ?? 0), 0),
    budget: PROJECT_FILE_BUDGET_TOKENS,
    overBudget: new Set(files.filter((f) => f.tokens !== null && !included.has(f.id)).map((f) => f.id)),
  };
}

/** Short type label from the extension, else the MIME subtype: "PDF", "MD". */
export function fileType(file: Pick<FileRef, 'name' | 'mime'>): string {
  return (/\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1] ?? file.mime.split('/')[1] ?? 'file').toUpperCase();
}
