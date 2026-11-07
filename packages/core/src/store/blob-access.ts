/**
 * Who may read a blob. Blobs are content-addressed and shared (two accounts that upload the same file hold one blob), so
 * "signed in" is not enough: an account reads a blob only when something it may see refers to it. The tables that hold
 * blob hashes are the ones `collectUnusedBlobs` (privacy/privacy.ts) lists; keep the two in step.
 */
import type { Db } from './db.ts';

const SHA = /^[0-9a-f]{64}$/;

/** Answers for this long are reused: a gallery asks for dozens of blobs at once, and each answer can scan messages. */
const YES_MS = 60_000;
/** A refusal is kept shorter, so a blob that was just stored (or a message just sent) isn't refused for long, but guessing isn't free either. */
const NO_MS = 5_000;
/** A blob handed to an account that nothing refers to yet (an export, a test image) stays theirs for this long. */
const GRANT_MS = 60 * 60_000;
const MAX_ENTRIES = 20_000;

export class BlobAccess {
  private readonly answers = new Map<string, { ok: boolean; until: number }>();
  private readonly grants = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `userId` was just given a blob that no message, file or avatar holds (yet): the export of their data, an image a
   * provider test made. It is theirs to read for a while.
   */
  grant(userId: string, sha256: string): void {
    if (this.grants.size >= MAX_ENTRIES) this.grants.clear();
    this.grants.set(`${userId}\0${sha256}`, this.now() + GRANT_MS);
    this.answers.delete(`${userId}\0${sha256}`);
  }

  async canRead(userId: string, sha256: string): Promise<boolean> {
    if (!SHA.test(sha256)) return false;
    const key = `${userId}\0${sha256}`;
    const now = this.now();
    const granted = this.grants.get(key);
    if (granted !== undefined) {
      if (granted > now) return true;
      this.grants.delete(key);
    }
    const known = this.answers.get(key);
    if (known && known.until > now) return known.ok;
    const ok = this.lookup(userId, sha256);
    if (this.answers.size >= MAX_ENTRIES) this.answers.clear();
    this.answers.set(key, { ok, until: now + (ok ? YES_MS : NO_MS) });
    return ok;
  }

  /** A person was removed from a co-op session (or it ended): what they could read there they no longer may. */
  forget(userId: string): void {
    for (const key of this.answers.keys()) if (key.startsWith(`${userId}\0`)) this.answers.delete(key);
  }

  /**
   * Whether a session (with its sub-agents and side chats) refers to a blob: what a co-op guest on another computer may
   * fetch of it (coop/host.ts), and attach to their messages there.
   */
  inSession(sessionId: string, sha256: string): boolean {
    if (!SHA.test(sha256)) return false;
    const db = this.db.$client;
    const values: Record<string, string> = { s: sessionId, sha: sha256, quoted: `"blob":"${sha256}"` };
    const has = (sql: string) => db.prepare(sql).get(Object.fromEntries(Object.entries(values).filter(([k]) => sql.includes(`@${k}`)))) !== undefined;
    const ours = `(SELECT @s UNION SELECT id FROM sessions WHERE parent_session_id = @s)`;
    return (
      has(`SELECT 1 FROM users WHERE avatar_blob = @sha LIMIT 1`) ||
      has(`SELECT 1 FROM files WHERE blob = @sha AND session_id IN ${ours} LIMIT 1`) ||
      has(`SELECT 1 FROM generated_images WHERE blob = @sha AND session_id IN ${ours} LIMIT 1`) ||
      has(`SELECT 1 FROM messages WHERE session_id IN ${ours} AND instr(parts, @quoted) > 0 LIMIT 1`)
    );
  }

  /**
   * Cheapest checks first; the messages (every part of every message of the account's sessions) last. The account's
   * sessions are its own, and the co-op sessions it takes part in (coop/participants.ts) with their sub-agents.
   */
  private lookup(userId: string, sha: string): boolean {
    const db = this.db.$client;
    const values: Record<string, string> = { u: userId, sha, quoted: `"blob":"${sha}"` };
    // Only the parameters a statement names: SQLite refuses others.
    const has = (sql: string) => db.prepare(sql).get(Object.fromEntries(Object.entries(values).filter(([k]) => sql.includes(`@${k}`)))) !== undefined;
    // Avatars are shown to everyone in the app.
    if (has(`SELECT 1 FROM users WHERE avatar_blob = @sha LIMIT 1`)) return true;
    const mine = `(SELECT id FROM sessions WHERE user_id = @u
      UNION SELECT session_id FROM session_participants WHERE user_id = @u AND left_at IS NULL
      UNION SELECT s.id FROM sessions s JOIN session_participants p ON s.parent_session_id = p.session_id WHERE p.user_id = @u AND p.left_at IS NULL)`;
    return (
      // Uploads and generated images, by their owner, in their sessions, or in their projects.
      has(`SELECT 1 FROM files WHERE blob = @sha AND (user_id = @u OR session_id IN ${mine} OR project_id IN (SELECT id FROM projects WHERE user_id = @u)) LIMIT 1`) ||
      has(`SELECT 1 FROM generated_images WHERE blob = @sha AND (user_id = @u OR session_id IN ${mine}) LIMIT 1`) ||
      has(`SELECT 1 FROM sessions WHERE user_id = @u AND (system_snapshot = @sha OR tools_snapshot = @sha) LIMIT 1`) ||
      has(`SELECT 1 FROM checkpoints WHERE before_blob = @sha AND session_id IN ${mine} LIMIT 1`) ||
      // Images and documents in messages, tool results and generated images: every one is a `"blob":"<sha>"` member. The
      // quotes matter: text a person typed is JSON-escaped (`\"blob\":\"…`), so writing a hash in a message grants nothing.
      has(`SELECT 1 FROM messages WHERE session_id IN ${mine} AND instr(parts, @quoted) > 0 LIMIT 1`)
    );
  }
}
