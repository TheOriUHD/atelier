/**
 * Settings › Privacy (M4): history retention, exporting everything a person has, deleting their conversations,
 * and removing blobs nothing refers to any more. Deleting is the person's own request; nothing here runs
 * on its own except the retention period they set.
 */
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { strToU8 } from 'fflate';
import type { Message, Part } from '@atelier/protocol';
import { toMessage } from '../sessions/session-repo.ts';
import { notTemporary } from '../sessions/temporary.ts';
import type { BlobStore } from '../store/blobs.ts';
import type { Db } from '../store/db.ts';
import { zipStream, type ZipEntry } from './zip-stream.ts';
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
       UNION SELECT blob FROM generated_images
       UNION SELECT json_tree.value FROM messages, json_tree(messages.parts) WHERE json_tree.key = 'blob'
       UNION SELECT sha256 FROM blobs WHERE created_at > ?`,
    )
    .all(now - GRACE_MS) as { sha: string }[];
  return blobs.collectGarbage(new Set(rows.map((r) => r.sha)));
}

/** The archive stays a valid zip: fflate writes no Zip64, so past these an attachment is listed in the manifest and not added. */
export interface ExportLimits {
  entries: number;
  bytes: number;
}
const DEFAULT_LIMITS: ExportLimits = { entries: 60_000, bytes: 3.5 * 1024 ** 3 };

/** Where a picture or document is kept, for the manifest and the file's name. */
interface BlobUse {
  sha: string;
  mime: string;
  kind: 'image' | 'document' | 'result' | 'generated' | 'saved';
  name?: string;
  messageId: string;
  /** 1-based place of the message in the conversation, in the order it was written. */
  ordinal: number;
}

/** Every blob a message refers to: attachments, images tools returned, images the assistant made or saved. */
export function blobUses(message: Message, ordinal: number): BlobUse[] {
  const uses: BlobUse[] = [];
  const add = (sha: string, mime: string, kind: BlobUse['kind'], name?: string) => uses.push({ sha, mime, kind, ...(name ? { name } : {}), messageId: message.id, ordinal });
  for (const part of message.parts) {
    if (part.type === 'image') add(part.blob, part.mime, 'image');
    else if (part.type === 'document') add(part.blob, part.mime, 'document', part.name);
    else if (part.type === 'tool_result') {
      for (const c of part.content) if (c.type === 'image') add(c.blob, c.mime, 'result');
      for (const g of part.generated ?? []) add(g.blob, g.mime, 'generated');
      if (part.saved) add(part.saved.blob, part.saved.mime, 'saved');
    }
  }
  return uses;
}

const MIME_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a' };
const extensionOf = (mime: string) => MIME_EXTENSIONS[mime] ?? (/^[a-z]+\/([a-z0-9]+)/.exec(mime)?.[1] ?? 'bin');
const safeName = (name: string) => [...name.replace(/[\\/:*?"<>|]/g, '_')].filter((c) => c.charCodeAt(0) >= 32).join('').trim().slice(0, 100) || 'file';
/** Pictures, clips, sounds and PDFs are compressed already; storing them as they are saves the time. A WAV isn't. */
const compressible = (mime: string) => mime === 'audio/wav' || !/^(image\/|video\/|audio\/|application\/(pdf|zip))/.test(mime);

/**
 * Everything the person has, as a zip written chunk by chunk: every conversation with its full message tree (JSON) and its
 * active branch as Markdown, projects with their instructions, artifacts (each version), files, memory entries, and every
 * picture and document the conversations refer to (`attachments/<conversation>/<message>-…`, listed in
 * `attachments.json`), including images that exist only inside messages (pasted, returned by a tool, generated).
 * Memory holds one conversation's messages, or one file, at a time.
 */
export async function* exportStream(db: Db, blobs: BlobStore, userId: string, limits: ExportLimits = DEFAULT_LIMITS): AsyncGenerator<Uint8Array> {
  yield* zipStream(exportEntries(db, blobs, userId, limits));
}

/** The whole archive in memory: for tests and small data; the app streams (`exportStream`). */
export async function exportAll(db: Db, blobs: BlobStore, userId: string, limits?: ExportLimits): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of exportStream(db, blobs, userId, limits)) chunks.push(chunk);
  return concat(chunks);
}

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

async function* exportEntries(db: Db, blobs: BlobStore, userId: string, limits: ExportLimits): AsyncGenerator<ZipEntry> {
  const text = (name: string, value: string): ZipEntry => ({ name, data: strToU8(value), compress: true });
  let entries = 0;
  let bytes = 0;
  /** Where each blob went in the archive, so it is stored once. */
  const stored = new Map<string, string>();
  const manifest: { conversation: string; title: string; message: string; kind: string; sha256: string; mime: string; name?: string; file: string | null; omitted?: string }[] = [];
  const room = (size: number) => entries < limits.entries && bytes + size <= limits.bytes;
  /** The blob as an entry, or why it isn't one. */
  const blobEntry = async (sha: string, name: string, mime: string): Promise<ZipEntry | string> => {
    const info = await blobs.info(sha).catch(() => undefined);
    if (!info) return 'no longer stored';
    if (!room(info.size)) return 'the archive is full';
    entries++;
    bytes += info.size;
    return { name, data: blobs.stream(sha), compress: compressible(mime) };
  };

  // The person's files first: a picture they attached is the same file, and the manifest points at it here.
  for (const f of await db.select().from(files).where(eq(files.userId, userId)).all()) {
    const path = `files/${f.id}-${f.name.replace(/[\\/:]/g, '_')}`;
    const entry = await blobEntry(f.blob, path, f.mime);
    if (typeof entry === 'string') continue;
    if (!stored.has(f.blob)) stored.set(f.blob, path);
    yield entry;
  }
  const own = await db.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.parentSessionId), notTemporary())).all();
  for (const s of own) {
    const stem = fileName(s.title || 'Untitled', s.id);
    const tree = (await db.select().from(messages).where(eq(messages.sessionId, s.id)).orderBy(messages.createdAt).all()).map(toMessage);
    entries++;
    yield text(`conversations/${stem}.md`, markdown(s.title, activeBranch(tree, s.headMessageId)));
    for (const a of await db.select().from(artifacts).where(eq(artifacts.sessionId, s.id)).all()) {
      for (const v of await db.select().from(artifactVersions).where(eq(artifactVersions.artifactId, a.id)).all()) {
        entries++;
        yield text(`artifacts/${fileName(a.title, a.id)}-v${v.version}.${EXTENSIONS[a.type] ?? 'txt'}`, v.content);
      }
    }
    // The pictures and documents of this conversation, each stored once in the archive.
    for (const [index, message] of tree.entries()) {
      for (const use of blobUses(message, index + 1)) {
        const base = { conversation: s.id, title: s.title, message: use.messageId, kind: use.kind, sha256: use.sha, mime: use.mime, ...(use.name ? { name: use.name } : {}) };
        const there = stored.get(use.sha);
        if (there) {
          manifest.push({ ...base, file: there });
          continue;
        }
        const path = `attachments/${stem}/${String(use.ordinal).padStart(3, '0')}-${use.name ? safeName(use.name) : `${use.sha.slice(0, 8)}.${extensionOf(use.mime)}`}`;
        const entry = await blobEntry(use.sha, path, use.mime);
        if (typeof entry === 'string') {
          manifest.push({ ...base, file: null, omitted: entry });
          continue;
        }
        stored.set(use.sha, path);
        manifest.push({ ...base, file: path });
        yield entry;
      }
    }
  }

  // The full trees once more, one conversation at a time, so the JSON is written as it is read.
  entries++;
  yield {
    name: 'conversations.json',
    compress: true,
    data: (async function* () {
      yield strToU8('[');
      let first = true;
      for (const s of own) {
        const tree = (await db.select().from(messages).where(eq(messages.sessionId, s.id)).orderBy(messages.createdAt).all()).map(toMessage);
        const conversation = { id: s.id, title: s.title, mode: s.mode, projectId: s.projectId, model: s.model, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: tree };
        yield strToU8(`${first ? '\n' : ',\n'}${JSON.stringify(conversation, null, 2).replace(/^/gm, '  ')}`);
        first = false;
      }
      yield strToU8(first ? ']' : '\n]');
    })(),
  };
  const ownProjects = await db.select().from(projects).where(eq(projects.userId, userId)).all();
  entries++;
  yield text('projects.json', JSON.stringify(ownProjects.map(({ id, name, description, instructions, createdAt }) => ({ id, name, description, instructions, createdAt })), null, 2));
  const memory = await db.select().from(memoryEntries).where(eq(memoryEntries.userId, userId)).all();
  entries++;
  yield text('memory.json', JSON.stringify(memory.map(({ userId: _owner, ...entry }) => entry), null, 2));
  entries++;
  yield text('attachments.json', JSON.stringify(manifest, null, 2));
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
