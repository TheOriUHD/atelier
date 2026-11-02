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

  /** Cheapest checks first; the messages (every part of every message of the account's sessions) last. */
  private lookup(userId: string, sha: string): boolean {
    const db = this.db.$client;
    const has = (sql: string, ...params: string[]) => db.prepare(sql).get(...params) !== undefined;
    // Avatars are shown to everyone in the app.
    if (has(`SELECT 1 FROM users WHERE avatar_blob = ? LIMIT 1`, sha)) return true;
    const mine = `(SELECT id FROM sessions WHERE user_id = ?)`;
    return (
      // Uploads and generated images, by their owner, in their sessions, or in their projects.
      has(
        `SELECT 1 FROM files WHERE blob = ? AND (user_id = ? OR session_id IN ${mine} OR project_id IN (SELECT id FROM projects WHERE user_id = ?)) LIMIT 1`,
        sha,
        userId,
        userId,
        userId,
      ) ||
      has(`SELECT 1 FROM generated_images WHERE blob = ? AND (user_id = ? OR session_id IN ${mine}) LIMIT 1`, sha, userId, userId) ||
      has(`SELECT 1 FROM sessions WHERE user_id = ? AND (system_snapshot = ? OR tools_snapshot = ?) LIMIT 1`, userId, sha, sha) ||
      has(`SELECT 1 FROM checkpoints WHERE before_blob = ? AND session_id IN ${mine} LIMIT 1`, sha, userId) ||
      // Images and documents in messages, tool results and generated images: every one is a `"blob":"<sha>"` member. The
      // quotes matter: text a person typed is JSON-escaped (`\"blob\":\"…`), so writing a hash in a message grants nothing.
      has(`SELECT 1 FROM messages WHERE session_id IN ${mine} AND instr(parts, ?) > 0 LIMIT 1`, userId, `"blob":"${sha}"`)
    );
  }
}
