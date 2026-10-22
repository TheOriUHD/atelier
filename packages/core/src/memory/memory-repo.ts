/**
 * A person's memory entries (ARCHITECTURE › Memory). Every read and write takes the owner's id: one person's memory is
 * never reachable from another's, even with a known entry id.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  FIXED_MEMORY_TITLES,
  isFixedMemorySection,
  MEMORY_DETAILS_MAX,
  MEMORY_SUMMARY_MAX,
  MEMORY_TITLE_MAX,
  type MemoryEntry,
  type MemorySection,
  type MemorySource,
} from '@atelier/protocol';
import type { Db } from '../store/db.ts';
import { memoryEntries, memoryProgress, projects } from '../store/schema.ts';
import { newId } from '../util/ids.ts';

type Row = typeof memoryEntries.$inferSelect;

export interface MemoryDraft {
  section: MemorySection;
  title: string;
  summary: string;
  details: string;
  /** Section `project` only: the Atelier project it belongs to. */
  projectId?: string | null;
  sensitive?: boolean;
  source: MemorySource;
  sourceSessionId?: string | null;
}

/** Sections in the order the settings page and the digest list them. */
export const SECTION_ORDER: readonly MemorySection[] = ['preferences', 'profile', 'topic', 'area', 'person', 'project'];
const BY_TITLE = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** What a conversation reads: the person's general memory, and its own project's entries when it is in one. */
export const visibleIn = (projectId: string | null | undefined) => (e: MemoryEntry) => e.projectId === null || e.projectId === projectId;

function toEntry(r: Row): MemoryEntry {
  // A project entry whose project was deleted stays, as an area.
  const orphan = r.section === 'project' && !r.projectId;
  return {
    id: r.id,
    section: orphan ? 'area' : r.section,
    title: r.title,
    summary: r.summary,
    details: r.details,
    projectId: r.section === 'project' ? r.projectId : null,
    sensitive: r.sensitive,
    source: r.source,
    sourceSessionId: r.sourceSessionId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/** A draft cut to the stored limits; fixed sections keep their own titles. */
function clean(draft: Pick<MemoryDraft, 'section' | 'title' | 'summary' | 'details'>): { title: string; summary: string; details: string } {
  return {
    title: isFixedMemorySection(draft.section) ? FIXED_MEMORY_TITLES[draft.section] : clip(draft.title.replace(/\s+/g, ' ').trim(), MEMORY_TITLE_MAX),
    summary: clip(draft.summary.replace(/\s+/g, ' ').trim(), MEMORY_SUMMARY_MAX),
    details: clip(draft.details.trim(), MEMORY_DETAILS_MAX),
  };
}

export class MemoryRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = newId,
  ) {}

  /** All of a person's entries: sections in order, then by title as people read it ("Entry 3" before "Entry 12"). */
  async list(userId: string): Promise<MemoryEntry[]> {
    const rows = await this.db.select().from(memoryEntries).where(eq(memoryEntries.userId, userId)).all();
    return rows.map(toEntry).sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || BY_TITLE.compare(a.title, b.title));
  }

  async get(userId: string, id: string): Promise<MemoryEntry | undefined> {
    const row = await this.db.select().from(memoryEntries).where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.id, id))).get();
    return row ? toEntry(row) : undefined;
  }

  async getMany(userId: string, ids: readonly string[]): Promise<MemoryEntry[]> {
    if (!ids.length) return [];
    const rows = await this.db.select().from(memoryEntries).where(and(eq(memoryEntries.userId, userId), inArray(memoryEntries.id, [...ids]))).all();
    return rows.map(toEntry);
  }

  /** Preferences or Profile: the one entry, if it was written yet. */
  async fixed(userId: string, section: 'preferences' | 'profile'): Promise<MemoryEntry | undefined> {
    const row = await this.db.select().from(memoryEntries).where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.section, section))).get();
    return row ? toEntry(row) : undefined;
  }

  /** The person's Atelier projects, which project entries may belong to. */
  async projects(userId: string): Promise<{ id: string; name: string }[]> {
    return this.db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.userId, userId)).orderBy(asc(projects.name)).all();
  }

  /** A project id of the person's, else null: a project entry never points into someone else's project. */
  private async ownProject(userId: string, projectId: string | null | undefined): Promise<string | null> {
    if (!projectId) return null;
    const row = await this.db.select({ id: projects.id }).from(projects).where(and(eq(projects.userId, userId), eq(projects.id, projectId))).get();
    return row?.id ?? null;
  }

  /** Creates an entry; for Preferences and Profile it replaces the one there is. */
  async create(userId: string, draft: MemoryDraft): Promise<MemoryEntry> {
    if (isFixedMemorySection(draft.section)) {
      const existing = await this.fixed(userId, draft.section);
      if (existing) return (await this.update(userId, existing.id, draft))!;
    }
    const now = this.now();
    const projectId = draft.section === 'project' ? await this.ownProject(userId, draft.projectId) : null;
    const row = {
      id: this.makeId(),
      userId,
      section: draft.section === 'project' && !projectId ? ('area' as const) : draft.section,
      ...clean(draft),
      projectId,
      sensitive: draft.sensitive ?? false,
      source: draft.source,
      sourceSessionId: draft.sourceSessionId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(memoryEntries).values(row);
    return toEntry(row);
  }

  /** Changes an entry of `userId`'s; undefined when they have none with this id. */
  async update(userId: string, id: string, patch: Partial<MemoryDraft> & Pick<MemoryDraft, 'source'>): Promise<MemoryEntry | undefined> {
    const current = await this.get(userId, id);
    if (!current) return undefined;
    // A fixed entry stays in its section; a list entry can't become a second Preferences or Profile.
    const asked = isFixedMemorySection(current.section) || !patch.section || isFixedMemorySection(patch.section) ? current.section : patch.section;
    // Only a project entry has a project, and only one of the person's own.
    const projectId = asked === 'project' ? await this.ownProject(userId, patch.projectId === undefined ? current.projectId : patch.projectId) : null;
    const section = asked === 'project' && !projectId ? 'area' : asked;
    const next = clean({ section, title: patch.title ?? current.title, summary: patch.summary ?? current.summary, details: patch.details ?? current.details });
    const values = {
      section,
      ...next,
      projectId,
      sensitive: patch.sensitive ?? current.sensitive,
      source: patch.source,
      sourceSessionId: patch.sourceSessionId === undefined ? current.sourceSessionId : patch.sourceSessionId,
      updatedAt: this.now(),
    };
    await this.db.update(memoryEntries).set(values).where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.id, id)));
    return { ...current, ...values };
  }

  /** Removes an entry; a fixed one is emptied instead. False when there was none. */
  async delete(userId: string, id: string): Promise<boolean> {
    const current = await this.get(userId, id);
    if (!current) return false;
    if (isFixedMemorySection(current.section)) {
      await this.update(userId, id, { summary: '', details: '', source: 'settings', sourceSessionId: null });
      return true;
    }
    await this.db.delete(memoryEntries).where(and(eq(memoryEntries.userId, userId), eq(memoryEntries.id, id)));
    return true;
  }

  /**
   * Entries matching any word of `query`, best first: a word in the title counts most, then the summary, then the
   * details. Memory is small (tens to hundreds of entries a person), so it is scored here rather than indexed.
   */
  async search(userId: string, query: string, opts: { limit: number; sensitive: boolean; projectId?: string | null }): Promise<MemoryEntry[]> {
    const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];
    const all = (await this.list(userId)).filter((e) => (opts.sensitive || !e.sensitive) && (e.details || e.summary) && visibleIn(opts.projectId)(e));
    if (!words.length) return all.slice(0, opts.limit);
    const score = (e: MemoryEntry) => {
      const title = e.title.toLowerCase();
      const summary = e.summary.toLowerCase();
      const details = e.details.toLowerCase();
      return words.reduce((n, w) => n + (title.includes(w) ? 5 : 0) + (summary.includes(w) ? 3 : 0) + (details.includes(w) ? 1 : 0), 0);
    };
    return all
      .map((e) => ({ e, s: score(e) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.e.updatedAt - a.e.updatedAt)
      .slice(0, opts.limit)
      .map((x) => x.e);
  }

  // ------------------------------------------------------------- background progress

  async progress(sessionId: string): Promise<string | null> {
    const row = await this.db.select().from(memoryProgress).where(eq(memoryProgress.sessionId, sessionId)).get();
    return row?.throughMessageId ?? null;
  }

  async setProgress(userId: string, sessionId: string, throughMessageId: string | null): Promise<void> {
    const values = { sessionId, userId, throughMessageId, processedAt: this.now() };
    await this.db.insert(memoryProgress).values(values).onConflictDoUpdate({ target: memoryProgress.sessionId, set: { throughMessageId, processedAt: values.processedAt } });
  }
}
