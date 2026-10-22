/**
 * Memory (ARCHITECTURE › Memory): the digest a conversation's system prompt carries, the memory and past-chat tools,
 * changes a model makes from the person's words (Settings › Memory) or from another assistant's export, and the
 * background update that reads a conversation once it has gone idle. All of it goes through `memoryFor`.
 */
import { z } from 'zod';
import {
  APP,
  FIXED_MEMORY_TITLES,
  isFixedMemorySection,
  MemorySection,
  memoryDetails,
  memoryLines,
  mergeMemoryLines,
  messageText,
  splitMemoryExport,
  type MemoryChange,
  type MemoryEntry,
  type MemorySource,
  type PromptTier,
  type Settings,
  type Usage,
  type UserPrefs,
} from '@atelier/protocol';
import { collectText, type ModelResolver, type ResolvedModel } from '../agent/chat-service.ts';
import { escapeTags } from '../prompts/escape.ts';
import { firstUsableModel, usableModel } from '../providers/model-choice.ts';
import { render, template, type Overrides } from '../prompts/templates.ts';
import type { QueuePriority } from '../providers/types.ts';
import type { SessionRepo, SessionRow } from '../sessions/session-repo.ts';
import type { Db } from '../store/db.ts';
import type { Tool } from '../tools/types.ts';
import { memoryFor, NO_MEMORY, type MemoryAccess } from './access.ts';
import { chatSearchResult, readChat, searchChats } from './chat-search.ts';
import { MemoryRepo, SECTION_ORDER, visibleIn } from './memory-repo.ts';
import {
  createChatReadTool,
  createChatSearchTool,
  createMemorySearchTool,
  createMemoryUpdateTool,
  createMemoryViewTool,
  MEMORY_SEARCH_MAX,
  type MemoryToolBackend,
  type MemoryUpdateInput,
} from './tools.ts';

/** How long a conversation stays idle before the background update reads it. */
export const MEMORY_IDLE_MS = 10 * 60_000;
/** The newest part of a conversation the background update reads, at most. */
const TRANSCRIPT_CHARS = 16_000;
/** The current memory as a model reads it, at most. */
const MEMORY_CHARS = 60_000;

/** What the digest holds, per tier: Preferences, Profile, the project's own entries, and the list of other entries. */
const DIGEST_LIMITS: Record<'full' | 'compact', { preferences: number; profile: number; project: number; entries: number; listChars: number }> = {
  full: { preferences: 4_000, profile: 2_500, project: 2_500, entries: 40, listChars: 4_000 },
  compact: { preferences: 900, profile: 500, project: 400, entries: 8, listChars: 700 },
};

/** What the chat service asks of memory (agent/chat-service.ts). */
export interface MemoryHooks {
  access(session: SessionRow): Promise<MemoryAccess>;
  /** The `<memory>` block for the system prompt; null when there is nothing to tell. */
  digest(session: SessionRow, access: MemoryAccess, opts: { tier: PromptTier; has(name: string): boolean }): Promise<string | null>;
  tools(session: SessionRow, access: MemoryAccess): Tool[];
  /** A turn of a top-level session ended: the background update reads it once it has been idle a while. */
  turnEnded(session: SessionRow): void;
}

export interface MemoryServiceDeps {
  db: Db;
  sessions: SessionRepo;
  prefs(userId: string): Promise<UserPrefs>;
  /** How the assistant addresses the person (their "call me", else their account name). */
  name(userId: string): Promise<string>;
  models: ModelResolver;
  settings(): Settings;
  promptOverrides(): Overrides;
  /** The person's memory changed: their windows reload it. */
  changed(userId: string): void;
  recordUsage?(entry: { model: ResolvedModel['info']; sessionId: string | null; userId: string; usage: Usage }): void;
  onError?(message: string, error: unknown): void;
  idleMs?: number;
  now?: () => number;
  /** Entry ids (tests pin them). */
  newId?: () => string;
}

/** Facts as a model gives them: a list, or a bullet list in one string. */
const Lines = z.union([z.string(), z.array(z.string())]);
const lines = (value: string | string[] | undefined): string[] => (value === undefined ? [] : (Array.isArray(value) ? value : [value]).flatMap(memoryLines));

/**
 * One change as a model writes it. `details` are a new entry's facts; on an update `add` appends facts, `replace`
 * rewrites the lines a newer fact supersedes and `remove` drops lines, so an entry never loses what nobody asked to
 * drop. `personal` marks health, beliefs and similar topics; `project` names the Atelier project a `project` entry is for.
 */
const ModelOp = z.object({
  op: z.enum(['create', 'update', 'delete']),
  id: z.string().optional(),
  section: MemorySection.optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  details: Lines.optional(),
  add: Lines.optional(),
  replace: z.array(z.object({ old: z.string(), new: z.string() })).optional(),
  remove: Lines.optional(),
  personal: z.boolean().optional(),
  project: z.string().optional(),
});
type ModelOp = z.infer<typeof ModelOp>;

/** Where a change comes from and what it may do. */
interface ApplyContext {
  source: MemorySource;
  sessionId: string | null;
  sensitive: boolean;
  /** `details` on an update replace the entry's: only when the person asked in their own words (Settings). */
  rewrite: boolean;
  /** A conversation's project (null outside one): the only project whose entries it sees. Undefined in Settings. */
  scope?: string | null;
}

/** The ops in a model's reply: the JSON object it was asked for, found inside whatever surrounds it. */
export function parseOps(reply: string): ModelOp[] {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const ops = Array.isArray(parsed) ? parsed : (parsed as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) return [];
  return ops.flatMap((op) => {
    const r = ModelOp.safeParse(op);
    return r.success ? [r.data] : [];
  });
}

/**
 * The person's memory as the system prompt carries it, or null when there is nothing in it: Preferences as their
 * standing instructions (`<user_instructions source="memory">`), the rest as background (`<memory>`). Only the
 * general entries and, inside a project, that project's own.
 */
export function memoryDigest(
  entries: readonly MemoryEntry[],
  opts: { name: string; sensitive: boolean; tier: PromptTier; has(name: string): boolean; project?: { id: string; name: string } | null },
): string | null {
  const limits = DIGEST_LIMITS[opts.tier === 'compact' ? 'compact' : 'full'];
  const usable = entries.filter((e) => (opts.sensitive || !e.sensitive) && (e.details.trim() || e.summary.trim()) && visibleIn(opts.project?.id)(e));
  if (!usable.length) return null;
  const name = escapeTags(opts.name || 'the person');
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).replace(/\n[^\n]*$/, '')}\n[…]` : text);
  const body = (e: MemoryEntry, max: number) => escapeTags(cut(e.details.trim() || e.summary, max));
  const blocks: string[] = [];
  const prefs = usable.find((e) => e.section === 'preferences');
  if (prefs) {
    blocks.push(
      `<user_instructions source="memory">\nHow ${name} wants you to respond, saved from earlier conversations. These are their standing instructions: follow them in every reply, starting with the first one, whatever it is about, without being reminded.\n${body(prefs, limits.preferences)}\n</user_instructions>`,
    );
  }
  const parts: string[] = [];
  const profile = usable.find((e) => e.section === 'profile');
  if (profile) parts.push(`## Profile: who ${name} is\n${body(profile, limits.profile)}`);
  const own = usable.filter((e) => e.section === 'project');
  if (own.length && opts.project) {
    let room = limits.project;
    const shown = own.map((e) => {
      const text = `### ${escapeTags(e.title)} (id ${e.id})\n${e.summary ? `${escapeTags(e.summary)}\n` : ''}${room > 0 ? body(e, room) : '[MemoryView shows the details.]'}`;
      room -= e.details.length;
      return text;
    });
    parts.push(`## This project, ${escapeTags(opts.project.name)}: what ${name} keeps about it\n${shown.join('\n')}`);
  }
  const others = usable.filter((e) => !isFixedMemorySection(e.section) && e.section !== 'project').sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || b.updatedAt - a.updatedAt);
  if (others.length) {
    const list: string[] = [];
    let chars = 0;
    for (const e of others) {
      const line = `- ${e.section}: ${escapeTags(e.title)}${e.summary ? `: ${escapeTags(e.summary)}` : ''} (id ${e.id})`;
      if (list.length >= limits.entries || chars + line.length > limits.listChars) break;
      list.push(line);
      chars += line.length + 1;
    }
    const rest = others.length - list.length;
    const find = opts.has('MemorySearch') ? '; MemorySearch finds them' : '';
    const view = opts.has('MemoryView') ? ' MemoryView shows their details.' : '';
    parts.push(`## Other memories\n${list.join('\n')}${rest > 0 ? `\n[${rest} more${find}.]` : ''}${view ? `\n${view.trim()}` : ''}`);
  }
  if (parts.length) {
    blocks.push(
      `<memory>\nWhat ${APP.name} knows about ${name} from earlier conversations, as background. Use it when it is relevant to what they ask; don't list what you know about them, and don't mention memory unless they ask about it.\n\n${parts.join('\n\n')}\n</memory>`,
    );
  }
  return blocks.join('\n\n');
}

/** The current memory as a model that changes it reads it, with the projects `project` entries may belong to. */
function renderMemory(entries: readonly MemoryEntry[], sensitive: boolean, projects: readonly { id: string; name: string }[]): string {
  const shown = entries.filter((e) => sensitive || !e.sensitive);
  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? id;
  let text = shown
    .map(
      (e) =>
        `### id: ${e.id} | ${e.section} | ${escapeTags(e.title)}${e.projectId ? ` | project: ${e.projectId} (${escapeTags(projectName(e.projectId) ?? '')})` : ''}\nSummary: ${escapeTags(e.summary)}\nDetails:\n${escapeTags(e.details) || '(none)'}`,
    )
    .join('\n\n');
  if (text.length > MEMORY_CHARS) text = `${text.slice(0, MEMORY_CHARS)}\n[… the rest of memory is left out]`;
  const list = projects.length ? `Their Atelier projects (for \`project\` entries):\n${projects.map((p) => `- id: ${p.id} | ${escapeTags(p.name)}`).join('\n')}\n\n` : '';
  return `${list}${text || '(empty)'}`;
}

export class MemoryService implements MemoryHooks {
  readonly repo: MemoryRepo;
  /** Conversations waiting for the background update, by session: the owner and the timer. */
  private pending = new Map<string, { userId: string; timer: ReturnType<typeof setTimeout> }>();
  /** Changes for one person run one after another, so two never merge from the same stale memory. */
  private chains = new Map<string, Promise<unknown>>();
  private running = new Set<Promise<unknown>>();

  constructor(private readonly deps: MemoryServiceDeps) {
    this.repo = new MemoryRepo(deps.db, deps.now, deps.newId);
  }

  // ------------------------------------------------------------------ conversations

  async access(session: SessionRow): Promise<MemoryAccess> {
    if (!session.userId) return NO_MEMORY;
    return memoryFor(session, await this.deps.prefs(session.userId));
  }

  async digest(session: SessionRow, access: MemoryAccess, opts: { tier: PromptTier; has(name: string): boolean }): Promise<string | null> {
    if (!access.read || !session.userId) return null;
    const entries = await this.repo.list(session.userId);
    if (!entries.length) return null;
    const project = session.projectId ? ((await this.repo.projects(session.userId)).find((p) => p.id === session.projectId) ?? null) : null;
    return memoryDigest(entries, { name: await this.deps.name(session.userId), sensitive: access.sensitive, project, ...opts });
  }

  tools(session: SessionRow, access: MemoryAccess): Tool[] {
    const userId = session.userId;
    if (!userId) return [];
    // A side chat's main conversation is what it talks about already: past-chat search leaves it out too.
    const asking = (sessionId: string) => session.parentSessionId ?? sessionId;
    const backend: MemoryToolBackend = {
      search: (query) => this.repo.search(userId, query, { limit: MEMORY_SEARCH_MAX, sensitive: access.sensitive, projectId: session.projectId }),
      view: async (ids) => (await this.repo.getMany(userId, ids)).filter((e) => (access.sensitive || !e.sensitive) && visibleIn(session.projectId)(e)),
      update: (input, sessionId) => this.updateFromTool(userId, input, sessionId, access, session.projectId),
      chatSearch: async (query, limit, sessionId) => chatSearchResult(query, searchChats(this.deps.db, { userId, excludeSessionId: asking(sessionId), query, limit })),
      chatRead: (input, sessionId) =>
        readChat(this.deps.sessions, {
          userId,
          excludeSessionId: asking(sessionId),
          sessionId: input.session_id,
          ...(input.around ? { around: input.around } : {}),
          ...(input.before !== undefined ? { before: input.before } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
        }),
    };
    return [
      ...(access.read ? [createMemorySearchTool(backend), createMemoryViewTool(backend)] : []),
      ...(access.write ? [createMemoryUpdateTool(backend, access.write === 'explicit')] : []),
      ...(access.searchChats ? [createChatSearchTool(backend), createChatReadTool(backend)] : []),
    ] as Tool[];
  }

  private async updateFromTool(userId: string, input: MemoryUpdateInput, sessionId: string, access: MemoryAccess, projectId: string | null): Promise<{ text: string; isError?: boolean }> {
    const op: ModelOp = {
      op: input.op,
      ...(input.id ? { id: input.id } : {}),
      ...(input.section ? { section: input.section } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      // On an update the tool's details are facts to add: a chat never drops what it didn't mention.
      ...(input.details !== undefined ? (input.op === 'update' ? { add: input.details } : { details: input.details }) : {}),
      ...(input.replace ? { replace: input.replace } : {}),
      ...(input.remove ? { remove: input.remove } : {}),
      ...(input.private_topic !== undefined ? { personal: input.private_topic } : {}),
    };
    const result = await this.locked(userId, () => this.applyOne(userId, op, { source: 'chat', sessionId, sensitive: access.sensitive, rewrite: false, scope: projectId }));
    if ('error' in result) return { text: result.error, isError: true };
    this.deps.changed(userId);
    const verb = { created: 'Saved', updated: 'Updated', deleted: 'Forgot' }[result.change.op];
    return { text: `${verb} the memory "${result.change.title}" (id: ${result.change.id}).` };
  }

  // ------------------------------------------------------------------ Settings › Memory

  /**
   * "Tell Atelier what to change": a model turns the person's words into changes, to `target.entryId` alone when
   * given, or to a fixed section (Preferences, Profile) alone.
   */
  async instruct(userId: string, text: string, target: { entryId?: string; section?: MemorySection } = {}, opts: { model?: string } = {}): Promise<MemoryChange[]> {
    return this.locked(userId, async () => {
      const entries = await this.repo.list(userId);
      const fixed = target.section && isFixedMemorySection(target.section) ? target.section : null;
      const entry = target.entryId ? entries.find((e) => e.id === target.entryId) : fixed ? entries.find((e) => e.section === fixed) : undefined;
      if (target.entryId && !entry) throw new MemoryNotFoundError();
      const prefs = await this.deps.prefs(userId);
      const scope = entry
        ? `an instruction from them about the entry with id ${entry.id} ("${escapeTags(entry.title)}"). Change only that entry (update or delete it); make no other change`
        : fixed
          ? `an instruction from them about their ${fixed} entry, which is empty so far. Change only that entry ("op":"update" with "section":"${fixed}"); make no other change`
          : 'something they just told you directly, to remember, change or forget. Do what it asks; it may touch several entries';
      const task = `${scope}. When they ask to rewrite, shorten or reorder an entry, give its complete new details as "details" on the update; otherwise add and replace lines as usual`;
      const user = `<memory>\n${renderMemory(entries, true, await this.repo.projects(userId))}\n</memory>\n\n<document name="what they said">\n${escapeTags(text)}\n</document>`;
      const ops = await this.ask(userId, task, user, prefs.memory.sensitive || !!entry?.sensitive, { maxOutputTokens: 8_000, priority: 'urgent', model: opts.model });
      const allowed = entry
        ? ops.filter((op) => op.op !== 'create' && (op.id === entry.id || (!op.id && op.section === entry.section && isFixedMemorySection(entry.section))))
        : fixed
          ? ops.filter((op) => !op.id && op.section === fixed && op.op !== 'delete')
          : ops;
      return this.applyAll(userId, allowed, { source: 'settings', sessionId: null, sensitive: prefs.memory.sensitive || !!entry?.sensitive, rewrite: true });
    });
  }

  /**
   * Another assistant's export, pasted in, merged into the person's memory on `opts.model` when they chose one. It is
   * read in parts so no reply has to hold all of it; every part sees the memory the parts before it wrote.
   */
  async import(userId: string, text: string, opts: { model?: string; onProgress?(done: number, total: number): void } = {}): Promise<MemoryChange[]> {
    const parts = splitMemoryExport(text);
    const changes: MemoryChange[] = [];
    for (const [i, part] of parts.entries()) {
      opts.onProgress?.(i, parts.length);
      changes.push(...(await this.importPart(userId, part, { index: i, total: parts.length }, opts.model)));
    }
    opts.onProgress?.(parts.length, parts.length);
    return changes;
  }

  private importPart(userId: string, part: string, at: { index: number; total: number }, model: string | undefined): Promise<MemoryChange[]> {
    return this.locked(userId, async () => {
      const entries = await this.repo.list(userId);
      const prefs = await this.deps.prefs(userId);
      const which = at.total > 1 ? ` (part ${at.index + 1} of ${at.total}; the parts before it are in memory already)` : '';
      const task = [
        `an export of what another assistant remembered about them, which they pasted in${which}. Turn every fact in it into memory: leave nothing out and don't summarize or shorten. Each line of the export becomes one line of details, in its own wording, with its date written into the line when it has one (drop markers like "[unknown]")`,
        'Sort by what each fact is about: instructions and preferences go into `preferences`; identity and career into `profile`; a hobby or interest with several facts gets its own `topic`; a larger ongoing endeavour of theirs (something they are building or running) gets an `area`; each person in their life a `person`; a project that matches one of their Atelier projects by name goes into a `project` entry with that project\'s id, any other project becomes an `area`',
        'Merge with the entries there are: add the lines they lack, replace a line only when the export has a newer version of the same fact, and never delete',
      ].join('. ');
      const user = `<memory>\n${renderMemory(entries, true, await this.repo.projects(userId))}\n</memory>\n\n<document name="pasted export">\n${escapeTags(part)}\n</document>`;
      const ops = await this.ask(userId, task, user, prefs.memory.sensitive, { maxOutputTokens: 16_000, priority: 'urgent', model });
      return this.applyAll(userId, ops, { source: 'import', sessionId: null, sensitive: prefs.memory.sensitive, rewrite: false });
    });
  }

  /**
   * An entry edited by hand (Settings › Memory › Edit), only while the administrator allows it. `details` is one fact
   * per line; a fixed section not written yet is created.
   */
  async edit(userId: string, target: { id?: string; section?: MemorySection }, patch: { title?: string; summary?: string; details?: string }): Promise<MemoryEntry> {
    if (!this.deps.settings().memory.manualEditing) throw new MemoryEditingOffError();
    return this.locked(userId, async () => {
      const fixed = target.section && isFixedMemorySection(target.section) ? target.section : null;
      const entry = target.id ? await this.repo.get(userId, target.id) : fixed ? await this.repo.fixed(userId, fixed) : undefined;
      const values = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.details !== undefined ? { details: memoryDetails(memoryLines(patch.details)) } : {}),
        source: 'settings' as const,
        sourceSessionId: null,
      };
      if (entry && values.title !== undefined && !isFixedMemorySection(entry.section) && !values.title.trim()) throw new MemoryInvalidError('An entry needs a title.');
      const saved = entry
        ? await this.repo.update(userId, entry.id, values)
        : fixed
          ? await this.repo.create(userId, { section: fixed, title: '', summary: values.summary ?? '', details: values.details ?? '', source: 'settings' })
          : undefined;
      if (!saved) throw new MemoryNotFoundError();
      this.deps.changed(userId);
      return saved;
    });
  }

  // ------------------------------------------------------------------ background update

  turnEnded(session: SessionRow): void {
    if (!session.userId || session.parentSessionId) return;
    const userId = session.userId;
    void this.access(session)
      .then((access) => {
        if (!access.generate) return;
        this.cancel(session.id);
        const timer = setTimeout(() => {
          this.pending.delete(session.id);
          this.track(this.generate(session.id));
        }, this.deps.idleMs ?? MEMORY_IDLE_MS);
        timer.unref?.();
        this.pending.set(session.id, { userId, timer });
      })
      .catch((e: unknown) => this.deps.onError?.('scheduling a memory update failed', e));
  }

  /** A new conversation started: the person's conversations waiting for the background update are read now. */
  sessionStarted(userId: string): void {
    for (const [sessionId, p] of [...this.pending]) {
      if (p.userId !== userId) continue;
      this.cancel(sessionId);
      this.track(this.generate(sessionId));
    }
  }

  /** Waits for background updates in progress (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  dispose(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  private cancel(sessionId: string): void {
    const p = this.pending.get(sessionId);
    if (p) clearTimeout(p.timer);
    this.pending.delete(sessionId);
  }

  private track(work: Promise<unknown>): void {
    const done = work.catch((e: unknown) => this.deps.onError?.('the background memory update failed', e)).finally(() => this.running.delete(done));
    this.running.add(done);
  }

  /**
   * Reads the part of a conversation it hasn't read yet and keeps what is worth remembering. Runs only while the
   * conversation's memory access allows it (checked now, not when it was scheduled), on the small model.
   */
  async generate(sessionId: string): Promise<MemoryChange[]> {
    const session = await this.deps.sessions.getRow(sessionId);
    if (!session?.userId) return [];
    const userId = session.userId;
    const access = await this.access(session);
    if (!access.generate) return [];
    const { messages } = await this.deps.sessions.branch(sessionId);
    const through = await this.repo.progress(sessionId);
    const from = through ? messages.findIndex((m) => m.id === through) + 1 : 0;
    const fresh = messages.slice(from).filter((m) => m.kind === 'normal' && (m.role === 'user' || m.role === 'assistant'));
    const last = messages.at(-1);
    if (!last) return [];
    if (!fresh.some((m) => m.role === 'user' && messageText(m.parts).trim())) {
      await this.repo.setProgress(userId, sessionId, last.id);
      return [];
    }
    let transcript = fresh.map((m) => `${m.role === 'user' ? 'Person' : 'Assistant'}: ${messageText(m.parts).trim()}`).join('\n\n');
    if (transcript.length > TRANSCRIPT_CHARS) transcript = `[… earlier part left out]\n${transcript.slice(-TRANSCRIPT_CHARS)}`;
    const scope = session.projectId;
    const changes = await this.locked(userId, async () => {
      const entries = (await this.repo.list(userId)).filter(visibleIn(scope));
      const project = scope ? (await this.repo.projects(userId)).filter((p) => p.id === scope) : [];
      const where = project[0]
        ? `. The conversation is in their Atelier project "${escapeTags(project[0].name)}" (id ${project[0].id}): what matters only for that project goes into a \`project\` entry for it, which only that project's chats read; what is about the person goes where it always does`
        : '. The conversation is in no project: use no `project` entries';
      const task = `the newest part of a conversation they had with you. Keep only what is worth remembering for later conversations; most conversations hold little or nothing of that${where}`;
      const user = `<memory>\n${renderMemory(entries, access.sensitive, project)}\n</memory>\n\n<transcript>\n${escapeTags(transcript)}\n</transcript>`;
      const ops = await this.ask(userId, task, user, access.sensitive, { maxOutputTokens: 8_000, priority: 'background', session });
      return this.applyAll(userId, ops, { source: 'background', sessionId, sensitive: access.sensitive, rewrite: false, scope });
    });
    await this.repo.setProgress(userId, sessionId, last.id);
    return changes;
  }

  // ------------------------------------------------------------------ models and changes

  private async locked<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const before = this.chains.get(userId) ?? Promise.resolve();
    const next = before.then(run, run);
    const tail = next.catch(() => undefined);
    this.chains.set(userId, tail);
    try {
      return await next;
    } finally {
      if (this.chains.get(userId) === tail) this.chains.delete(userId);
    }
  }

  /** The person's choice, else the first usable of small, conversation, personal, server default, first available. */
  private async model(userId: string, opts: { session?: SessionRow; chosen?: string }): Promise<ResolvedModel> {
    const { models } = this.deps;
    if (opts.chosen) {
      const chosen = await usableModel(models, opts.chosen);
      if (!chosen) throw new ModelChoiceError();
      return chosen;
    }
    const { defaults } = this.deps.settings().models;
    const prefs = await this.deps.prefs(userId);
    const near = opts.session?.model ?? prefs.models.chat ?? defaults.chat;
    const small = defaults.small && near && models.avoidSwap ? models.avoidSwap(defaults.small, near) : defaults.small;
    const model = await firstUsableModel(models, [small, defaults.small, opts.session?.model, prefs.models.chat, defaults.chat, await models.firstAvailable()]);
    if (!model) throw new Error('No model is available to update memory. Add a model provider first.');
    return model;
  }

  private async ask(
    userId: string,
    task: string,
    user: string,
    sensitive: boolean,
    opts: { maxOutputTokens: number; priority: QueuePriority; session?: SessionRow; model?: string | undefined },
  ): Promise<ModelOp[]> {
    const model = await this.model(userId, { ...(opts.session ? { session: opts.session } : {}), ...(opts.model ? { chosen: opts.model } : {}) });
    const name = escapeTags((await this.deps.name(userId)) || 'the person');
    const personal = sensitive
      ? 'Health, religious or political beliefs, sexuality, ethnicity, finances and similar private topics may be kept when the person shares them as lasting facts about themselves; mark those entries with "personal": true.'
      : "Don't keep health, religious or political beliefs, sexuality, ethnicity, finances or similar private topics, even when they come up; the person chose not to have them remembered.";
    const system = render(template('memory-update', this.deps.promptOverrides()), { app: APP.name, name, task, personal_rule: personal });
    const reply = await collectText(model, {
      system: [{ text: system }],
      user,
      maxOutputTokens: Math.min(model.info.maxOutput, opts.maxOutputTokens),
      signal: AbortSignal.timeout(10 * 60_000),
      queue: { priority: opts.priority, ...(opts.session ? { owner: opts.session.id } : {}) },
      onUsage: (usage) => this.deps.recordUsage?.({ model: model.info, sessionId: opts.session?.id ?? null, userId, usage }),
    });
    return parseOps(reply);
  }

  private async applyAll(userId: string, ops: ModelOp[], ctx: ApplyContext): Promise<MemoryChange[]> {
    const changes: MemoryChange[] = [];
    for (const op of ops) {
      const result = await this.applyOne(userId, op, ctx);
      if ('change' in result) changes.push(result.change);
    }
    if (changes.length) this.deps.changed(userId);
    return changes;
  }

  /**
   * One change, checked: an entry of this person's that the context sees, a section that exists, nothing private
   * unless allowed. Details change line by line; only a rewrite the person asked for replaces them.
   */
  private async applyOne(userId: string, op: ModelOp, ctx: ApplyContext): Promise<{ change: MemoryChange } | { error: string }> {
    const fixedSection = op.section && isFixedMemorySection(op.section) ? op.section : null;
    const found = op.id ? await this.repo.get(userId, op.id) : fixedSection ? await this.repo.fixed(userId, fixedSection) : undefined;
    const target = found && (ctx.scope === undefined || visibleIn(ctx.scope)(found)) ? found : undefined;
    const meta = { source: ctx.source, sourceSessionId: ctx.sessionId };
    if (op.personal && !ctx.sensitive) return { error: "The person's settings don't allow remembering health, beliefs or similar private topics, so this wasn't saved." };
    // A conversation's project entries are its own project's; Settings may name any of the person's projects.
    const projectId = ctx.scope !== undefined ? ctx.scope : (op.project ?? null);
    if (op.op === 'delete') {
      if (ctx.source === 'import') return { error: 'An import only adds to memory.' };
      if (!target) return { error: op.id ? `There is no memory with id ${op.id}.` : 'Deleting needs the id of the entry.' };
      await this.repo.delete(userId, target.id);
      return { change: { op: 'deleted', id: target.id, title: target.title, section: target.section } };
    }
    if (op.op === 'update' && op.id && !target) return { error: `There is no memory with id ${op.id}.` };
    if (target) {
      const changesDetails = op.details !== undefined || op.add !== undefined || op.replace !== undefined || op.remove !== undefined;
      let details = target.details;
      if (op.details !== undefined) details = ctx.rewrite ? memoryDetails(lines(op.details)) : mergeMemoryLines(details, { add: lines(op.details) });
      if (changesDetails) details = mergeMemoryLines(details, { add: lines(op.add), replace: op.replace ?? [], remove: ctx.source === 'import' ? [] : lines(op.remove) });
      const updated = await this.repo.update(userId, target.id, {
        ...(op.title !== undefined && op.title.trim() ? { title: op.title } : {}),
        ...(op.summary !== undefined && op.summary.trim() ? { summary: op.summary } : {}),
        ...(changesDetails ? { details } : {}),
        ...(op.section && !fixedSection ? { section: op.section, ...(op.section === 'project' ? { projectId: op.project && ctx.scope === undefined ? op.project : (target.projectId ?? projectId) } : {}) } : {}),
        ...(op.personal !== undefined ? { sensitive: op.personal } : {}),
        ...meta,
      });
      return { change: { op: 'updated', id: target.id, title: updated!.title, section: updated!.section } };
    }
    if (!op.section) return { error: 'A new memory needs a section.' };
    const title = fixedSection ? FIXED_MEMORY_TITLES[fixedSection] : op.title?.trim();
    if (!title) return { error: 'A new memory needs a title.' };
    const facts = [...lines(op.details), ...lines(op.add)];
    if (!facts.length && !op.summary?.trim()) return { error: 'A new memory needs a summary or details.' };
    // The same thing under the same title is updated, not kept twice.
    const same = fixedSection
      ? undefined
      : (await this.repo.list(userId)).find(
          (e) => e.section === op.section && e.title.toLowerCase() === title.toLowerCase() && (op.section !== 'project' || e.projectId === projectId) && (ctx.scope === undefined || visibleIn(ctx.scope)(e)),
        );
    if (same) {
      const { title: _kept, details, ...rest } = op;
      return this.applyOne(userId, { ...rest, op: 'update', id: same.id, add: [...lines(details), ...lines(op.add)] }, ctx);
    }
    const created = await this.repo.create(userId, {
      section: op.section,
      title,
      summary: op.summary ?? '',
      details: memoryDetails(facts),
      projectId: op.section === 'project' ? projectId : null,
      sensitive: op.personal ?? false,
      ...meta,
    });
    return { change: { op: 'created', id: created.id, title: created.title, section: created.section } };
  }
}

/** The model chosen for a memory request is one the person can't use (gone, hidden, its provider off). */
export class ModelChoiceError extends Error {
  constructor() {
    super('The chosen model isn’t available. Choose another one, or Default.');
  }
}

/** Manual editing is off (Admin › Capabilities › Memory). */
export class MemoryEditingOffError extends Error {
  constructor() {
    super('Editing memory by hand is turned off. An administrator can turn it on in Settings.');
  }
}

export class MemoryInvalidError extends Error {}

export class MemoryNotFoundError extends Error {
  constructor() {
    super('That memory no longer exists.');
  }
}
