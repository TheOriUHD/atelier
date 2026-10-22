/**
 * Settings › Privacy (M4): history retention, exporting everything a person has, deleting their conversations,
 * and removing blobs nothing refers to any more. Deleting is the person's own request; nothing here runs
 * on its own except the retention period they set.
 */
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { Message, Part } from '@atelier/protocol';
import { toMessage } from '../sessions/session-repo.ts';
import { notTemporary } from '../sessions/temporary.ts';
import type { BlobStore } from '../store/blobs.ts';
import type { Db } from '../store/db.ts';
import { artifacts, artifactVersions, files, memoryEntries, messages, projects, sessions } from '../store/schema.ts';

/** Blobs younger than this are kept even when nothing refers to them yet (an upload not yet sent). */
const GRACE_MS = 3600_000;

/** The person's conversations: all of them, or those last touched more than `olderThanDays` ago (not pinned). */
export async function conversationIds(db: Db, userId: string, olderThanDays?: number, now = Date.now()): Promise<string[]> {
  const age = olderThanDays === undefined ? [] : [isNull(sessions.pinnedAt), lt(sessions.updatedAt, now - olderThanDays * 86_400_000)];
  const rows = await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.parentSessionId), ...age)).all();
  return rows.map((r) => r.id);
}

/** Deletes conversations with their messages, files, artifacts, checkpoints and sub-agent sessions. */
export async function deleteConversations(db: Db, ids: string[]): Promise<void> {
  if (!ids.length) return;
  // Everything but sub-agent sessions goes with its session (foreign keys cascade).
  await db.delete(sessions).where(inArray(sessions.parentSessionId, ids));
  await db.delete(sessions).where(inArray(sessions.id, ids));
}

/** Removes stored blobs that no message, file, snapshot, checkpoint or avatar refers to. */
export async function collectUnusedBlobs(db: Db, blobs: BlobStore, now = Date.now()): Promise<number> {
  const rows = db.$client
    .prepare(
      `SELECT blob AS sha FROM files
       UNION SELECT system_snapshot FROM sessions WHERE system_snapshot IS NOT NULL
       UNION SELECT tools_snapshot FROM sessions WHERE tools_snapshot IS NOT NULL
       UNION SELECT before_blob FROM checkpoints WHERE before_blob IS NOT NULL
       UNION SELECT avatar_blob FROM users WHERE avatar_blob IS NOT NULL
       UNION SELECT json_tree.value FROM messages, json_tree(messages.parts) WHERE json_tree.key = 'blob'
       UNION SELECT sha256 FROM blobs WHERE created_at > ?`,
    )
    .all(now - GRACE_MS) as { sha: string }[];
  return blobs.collectGarbage(new Set(rows.map((r) => r.sha)));
}

/**
 * Everything the person has, as a zip: every conversation with its full message tree (JSON) and its
 * active branch as Markdown, projects with their instructions, artifacts (each version), files and memory entries.
 */
export async function exportAll(db: Db, blobs: BlobStore, userId: string): Promise<Uint8Array> {
  const zip: Zippable = {};
  const own = await db.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.parentSessionId), notTemporary())).all();
  const conversations = [];
  for (const s of own) {
    const tree = (await db.select().from(messages).where(eq(messages.sessionId, s.id)).orderBy(messages.createdAt).all()).map(toMessage);
    conversations.push({ id: s.id, title: s.title, mode: s.mode, projectId: s.projectId, model: s.model, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: tree });
    zip[`conversations/${fileName(s.title || 'Untitled', s.id)}.md`] = strToU8(markdown(s.title, activeBranch(tree, s.headMessageId)));
    for (const a of await db.select().from(artifacts).where(eq(artifacts.sessionId, s.id)).all()) {
      for (const v of await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, a.id)).all()) {
        zip[`artifacts/${fileName(a.title, a.id)}-v${v.version}.${EXTENSIONS[a.type] ?? 'txt'}`] = strToU8(v.content);
      }
    }
  }
  zip['conversations.json'] = strToU8(JSON.stringify(conversations, null, 2));
  const ownProjects = await db.select().from(projects).where(eq(projects.userId, userId)).all();
  zip['projects.json'] = strToU8(JSON.stringify(ownProjects.map(({ id, name, description, instructions, createdAt }) => ({ id, name, description, instructions, createdAt })), null, 2));
  const memory = await db.select().from(memoryEntries).where(eq(memoryEntries.userId, userId)).all();
  zip['memory.json'] = strToU8(JSON.stringify(memory.map(({ userId: _owner, ...entry }) => entry), null, 2));
  for (const f of await db.select().from(files).where(eq(files.userId, userId)).all()) {
    const bytes = await blobs.read(f.blob).catch(() => null);
    if (bytes) zip[`files/${f.id}-${f.name.replace(/[\\/:]/g, '_')}`] = new Uint8Array(bytes);
  }
  return zipSync(zip, { level: 6 });
}

const EXTENSIONS: Record<string, string> = { html: 'html', react: 'jsx', svg: 'svg', mermaid: 'mmd', markdown: 'md', code: 'txt' };

const fileName = (title: string, id: string) => `${title.replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'untitled'}-${id.slice(0, 8)}`;

function activeBranch(tree: Message[], head: string | null): Message[] {
  const byId = new Map(tree.map((m) => [m.id, m]));
  const path: Message[] = [];
  for (let m = head ? byId.get(head) : undefined; m; m = m.parentId ? byId.get(m.parentId) : undefined) path.unshift(m);
  return path;
}

function markdown(title: string, branch: Message[]): string {
  const text = (parts: Part[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : p.type === 'tool_call' ? [`*Used ${p.name}*`] : [])).join('\n\n');
  const turns = branch.filter((m) => m.role !== 'tool' && m.kind === 'normal').map((m) => `## ${m.role === 'user' ? 'You' : 'Assistant'}\n\n${text(m.parts)}`);
  return `# ${title || 'Untitled'}\n\n${turns.join('\n\n')}\n`;
}
