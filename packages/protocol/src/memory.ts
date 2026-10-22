/**
 * Memory (ARCHITECTURE › Memory): what Atelier remembers about a person across their chats, and the search over their
 * past chats. The tool result formats live here so the backend writes and the transcript reads the same lines.
 */
import { z } from 'zod';
import { Mode } from './settings.ts';

/**
 * `preferences` and `profile` are one entry each per person ("You"); the rest are lists. `area` holds larger ongoing
 * endeavours of the person's own; `project` entries belong to one of their Atelier projects (`projectId`).
 */
export const MemorySection = z.enum(['preferences', 'profile', 'topic', 'area', 'person', 'project']);
export type MemorySection = z.infer<typeof MemorySection>;

/** Sections with exactly one entry per person, whose title is fixed. */
export const FIXED_MEMORY_SECTIONS = ['preferences', 'profile'] as const satisfies readonly MemorySection[];
export const FIXED_MEMORY_TITLES: Record<(typeof FIXED_MEMORY_SECTIONS)[number], string> = { preferences: 'Preferences', profile: 'Profile' };

export const isFixedMemorySection = (section: MemorySection): section is (typeof FIXED_MEMORY_SECTIONS)[number] => section === 'preferences' || section === 'profile';

/** Where an entry's latest change came from. */
export const MemorySource = z.enum(['chat', 'background', 'settings', 'import']);
export type MemorySource = z.infer<typeof MemorySource>;

export const MEMORY_TITLE_MAX = 120;
export const MEMORY_SUMMARY_MAX = 300;
export const MEMORY_DETAILS_MAX = 24_000;

/** The list sections in the order Settings › Memory and the digest show them, with their headings. */
export const MEMORY_LIST_SECTIONS = [
  { section: 'topic', title: 'Topics' },
  { section: 'area', title: 'Areas' },
  { section: 'person', title: 'People' },
  { section: 'project', title: 'Projects' },
] as const satisfies readonly { section: MemorySection; title: string }[];

export const MemoryEntry = z.object({
  id: z.string(),
  section: MemorySection,
  title: z.string(),
  /** One line, shown in the list. */
  summary: z.string(),
  /** A Markdown bullet list, one fact per line (`memoryLines` reads it). */
  details: z.string(),
  /** The Atelier project the entry belongs to (section `project`): only that project's chats read it. */
  projectId: z.string().nullable(),
  /** Health, religious beliefs and the like: used only while the person allows it. */
  sensitive: z.boolean(),
  source: MemorySource,
  /** The conversation the latest change came from, when one did. */
  sourceSessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/** One change a model made to memory, as the settings page reports it ("Updated Preferences"). */
export const MemoryChange = z.object({ op: z.enum(['created', 'updated', 'deleted']), id: z.string(), title: z.string(), section: MemorySection });
export type MemoryChange = z.infer<typeof MemoryChange>;

/** "Updated Preferences", "Saved Beans and 2 more". */
export function describeMemoryChanges(changes: readonly MemoryChange[]): string {
  if (!changes.length) return 'Nothing to change';
  const verb = { created: 'Saved', updated: 'Updated', deleted: 'Forgot' } as const;
  const first = changes[0]!;
  const rest = changes.length - 1;
  return `${verb[first.op]} ${first.title}${rest ? ` and ${rest} more` : ''}`;
}

/** "Added 4 entries, updated Profile and Preferences": what an import did, each entry counted once. */
export function describeImportChanges(changes: readonly MemoryChange[]): string {
  const created = new Map<string, string>();
  const updated = new Map<string, string>();
  for (const c of changes) {
    if (c.op === 'created') created.set(c.id, c.title);
    else if (c.op === 'updated' && !created.has(c.id)) updated.set(c.id, c.title);
  }
  const parts: string[] = [];
  if (created.size) parts.push(`added ${created.size} ${created.size === 1 ? 'entry' : 'entries'}`);
  if (updated.size) {
    const titles = [...updated.values()];
    parts.push(`updated ${titles.length > 3 ? `${titles.length} entries` : titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`}`);
  }
  if (!parts.length) return 'Nothing in it could be added to memory';
  const text = parts.join(', ');
  return text[0]!.toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- details as lines

/** An entry's details as single facts, without their bullets. */
export function memoryLines(details: string): string[] {
  return details
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

/** Facts back into the stored form: a Markdown bullet list. */
export const memoryDetails = (lines: readonly string[]): string =>
  lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n');

const sameLine = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Details changed line by line, so nothing is lost on the way: `replace` rewrites the lines a newer fact supersedes
 * (or adds the new line when the old one isn't there), `remove` drops lines, `add` appends the facts not there yet.
 */
export function mergeMemoryLines(details: string, change: { add?: readonly string[]; replace?: readonly { old: string; new: string }[]; remove?: readonly string[] }): string {
  let lines = memoryLines(details);
  const extra: string[] = [];
  for (const r of change.replace ?? []) {
    const [fresh] = memoryLines(r.new);
    const at = lines.findIndex((l) => sameLine(l, memoryLines(r.old)[0] ?? ''));
    if (!fresh) continue;
    if (at >= 0) lines[at] = fresh;
    else extra.push(fresh);
  }
  if (change.remove?.length) lines = lines.filter((l) => !change.remove!.some((r) => sameLine(l, memoryLines(r)[0] ?? '')));
  // A superseded line given again among the additions stays superseded.
  const gone = [...(change.replace ?? []).map((r) => r.old), ...(change.remove ?? [])].flatMap(memoryLines);
  for (const line of [...extra, ...(change.add ?? []).flatMap(memoryLines)]) if (!lines.some((l) => sameLine(l, line)) && !gone.some((g) => sameLine(g, line))) lines.push(line);
  return memoryDetails(lines);
}

// ---------------------------------------------------------------- import

/** An export is read in parts of about this size, so no model reply has to hold all of it. */
export const MEMORY_IMPORT_CHUNK_CHARS = 6_000;

/** A heading line of an export: `## Career`, `**Career**`, `Career:`, `3. Career` and the like. */
const HEADING = /^\s*(?:#{1,6}\s+\S.*|\*\*[^*]+\*\*:?|\d{1,2}[.)]\s+[A-Z][\w &/,'-]{0,50}:?|[A-Z][\w &/,'-]{0,50}:)\s*$/;

/**
 * An export cut into parts for import: whole sections where they fit, a long section in runs of lines with its
 * heading repeated, so each part says where its lines came from. Code fences go.
 */
export function splitMemoryExport(text: string, max = MEMORY_IMPORT_CHUNK_CHARS): string[] {
  const sections: { heading: string; lines: string[] }[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) continue;
    const line = raw.trimEnd();
    if (HEADING.test(line) && line.length < 80) sections.push({ heading: line.trim(), lines: [] });
    else if (line.trim()) {
      if (!sections.length) sections.push({ heading: '', lines: [] });
      sections.at(-1)!.lines.push(line);
    }
  }
  const pieces: string[] = [];
  for (const { heading, lines } of sections) {
    if (!lines.length) continue;
    let run: string[] = [];
    let size = heading.length;
    const flush = () => {
      if (run.length) pieces.push([heading, ...run].filter(Boolean).join('\n'));
      run = [];
      size = heading.length;
    };
    for (const line of lines) {
      const cut = line.length > max ? line.slice(0, max) : line;
      if (size + cut.length + 1 > max) flush();
      run.push(cut);
      size += cut.length + 1;
    }
    flush();
  }
  // Small sections share a part.
  const parts: string[] = [];
  for (const piece of pieces) {
    if (parts.length && parts.at(-1)!.length + piece.length + 2 <= max) parts[parts.length - 1] += `\n\n${piece}`;
    else parts.push(piece);
  }
  return parts;
}

// ---------------------------------------------------------------- tool results

/** A memory as MemorySearch lists it. */
export interface MemoryHit {
  id: string;
  section: MemorySection;
  title: string;
  summary: string;
}

/** MemorySearch's and MemoryView's result: a header line, then each entry starting `- id: … | section | title`. */
export function formatMemoryHits(header: string, hits: readonly (MemoryHit & { body?: string })[]): string {
  return [header, ...hits.map((h) => `- id: ${h.id} | ${h.section} | ${oneLine(h.title)}\n  ${oneLine(h.summary)}${h.body ? `\n${indent(h.body)}` : ''}`)].join('\n');
}

export function parseMemoryHits(text: string): MemoryHit[] {
  const hits: MemoryHit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^- id: (\S+) \| (\w+) \| (.*)$/.exec(lines[i]!);
    const section = m && MemorySection.safeParse(m[2]);
    if (!m || !section?.success) continue;
    hits.push({ id: m[1]!, section: section.data, title: m[3]!, summary: lines[i + 1]?.startsWith('  ') ? lines[i + 1]!.trim() : '' });
  }
  return hits;
}

/** MemoryUpdate's result names the entry it changed: `Saved the memory "Beans" (id: …).` */
export function parseMemoryUpdate(text: string): { id: string; title: string } | null {
  const m = /the memory "(.*)" \(id: (\S+)\)/.exec(text);
  return m ? { title: m[1]!, id: m[2]! } : null;
}

/** A past chat as ChatSearch lists it. */
export interface ChatHit {
  sessionId: string;
  messageId: string | null;
  mode: Mode;
  /** `YYYY-MM-DD`. */
  date: string;
  title: string;
  snippet: string;
}

export function formatChatHits(header: string, hits: readonly ChatHit[]): string {
  return [header, ...hits.map((h) => `- session: ${h.sessionId} | message: ${h.messageId ?? '-'} | ${h.mode} | ${h.date} | ${oneLine(h.title) || 'Untitled'}\n  ${oneLine(h.snippet)}`)].join('\n');
}

export function parseChatHits(text: string): ChatHit[] {
  const hits: ChatHit[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^- session: (\S+) \| message: (\S+) \| (chat|work|code) \| (\S+) \| (.*)$/.exec(lines[i]!);
    if (!m) continue;
    hits.push({ sessionId: m[1]!, messageId: m[2] === '-' ? null : m[2]!, mode: m[3] as Mode, date: m[4]!, title: m[5]!, snippet: lines[i + 1]?.startsWith('  ') ? lines[i + 1]!.trim() : '' });
  }
  return hits;
}

/** ChatRead's result starts `Chat "title" (session: …, mode, date)`. */
export function parseChatRead(text: string): { sessionId: string; title: string; mode: Mode } | null {
  const m = /^Chat "(.*)" \(session: (\S+), (chat|work|code), /.exec(text);
  return m ? { title: m[1]!, sessionId: m[2]!, mode: m[3] as Mode } : null;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const indent = (text: string) =>
  text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
