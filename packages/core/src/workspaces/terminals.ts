/**
 * The Code view's terminals (ARCHITECTURE §6): real PTYs on the workspace's runner. A terminal belongs to the person who
 * opened it and shows on one connection at a time. When that connection goes away (a dropped socket, a reload) the
 * shell keeps running for a few minutes with its recent output kept, so the same person can attach it again and catch
 * up; otherwise it closes. Output is decoded as a UTF-8 stream so characters split across chunks survive.
 */
import { newId } from '../util/ids.ts';
import type { Workspace } from './workspace.ts';

/** How long a terminal without a connection waits to be attached again. */
export const DETACHED_TTL_MS = 5 * 60_000;
/** Output kept for catching up, in characters. */
export const KEPT_OUTPUT_CHARS = 256 * 1024;

interface Terminal<Owner> {
  ws: Workspace;
  ptyId: string;
  /** Who opened it; only they can attach it. */
  userId: string;
  /** The connection showing it; null while detached. */
  owner: Owner | null;
  /** Characters of output so far, and the newest of them. */
  written: number;
  kept: string;
  expiry: ReturnType<typeof setTimeout> | null;
  off: () => void;
}

export interface TerminalEvents<Owner> {
  data(owner: Owner, terminalId: string, data: string): void;
  exit(owner: Owner, terminalId: string, code: number | null): void;
}

export class TerminalManager<Owner> {
  private terminals = new Map<string, Terminal<Owner>>();

  constructor(
    private readonly events: TerminalEvents<Owner>,
    private readonly ttlMs = DETACHED_TTL_MS,
  ) {}

  /** `dir` is relative to the workspace root, which the runner resolves it against and keeps it inside of. */
  async open(owner: Owner, userId: string, ws: Workspace, size: { cols: number; rows: number }, dir?: string): Promise<string> {
    const { ptyId } = await ws.runner.call('pty.open', { cwd: dir || ws.root, cols: size.cols, rows: size.rows });
    const id = newId();
    const decoder = new TextDecoder();
    const offData = ws.runner.on('pty.data', (n) => {
      if (n.ptyId !== ptyId) return;
      const t = this.terminals.get(id);
      if (!t) return;
      const data = decoder.decode(Buffer.from(n.b64, 'base64'), { stream: true });
      t.written += data.length;
      t.kept = (t.kept + data).slice(-KEPT_OUTPUT_CHARS);
      if (t.owner) this.events.data(t.owner, id, data);
    });
    const offExit = ws.runner.on('pty.exit', (n) => {
      if (n.ptyId !== ptyId) return;
      const owner = this.terminals.get(id)?.owner;
      this.release(id);
      if (owner) this.events.exit(owner, id, n.code);
    });
    this.terminals.set(id, { ws, ptyId, userId, owner, written: 0, kept: '', expiry: null, off: () => (offData(), offExit()) });
    return id;
  }

  /**
   * Shows a terminal on `owner` from now on and returns the output after its first `since` characters (all that was kept
   * when more went by, with `truncated`).
   */
  attach(owner: Owner, userId: string, id: string, since: number): { data: string; truncated: boolean } {
    const t = this.terminals.get(id);
    if (!t || t.userId !== userId) throw new Error('This terminal is closed.');
    if (t.expiry) clearTimeout(t.expiry);
    t.expiry = null;
    t.owner = owner;
    const missed = Math.max(0, t.written - since);
    return { data: missed ? t.kept.slice(-missed) : '', truncated: missed > t.kept.length };
  }

  async write(owner: Owner, id: string, data: string): Promise<void> {
    const t = this.get(owner, id);
    await t.ws.runner.call('pty.write', { ptyId: t.ptyId, data });
  }

  async resize(owner: Owner, id: string, cols: number, rows: number): Promise<void> {
    const t = this.get(owner, id);
    await t.ws.runner.call('pty.resize', { ptyId: t.ptyId, cols, rows });
  }

  async close(owner: Owner, id: string): Promise<void> {
    const t = this.get(owner, id);
    await this.shut(id, t);
  }

  /** The connection went away: its terminals wait a while to be attached again, then close. */
  detachAll(owner: Owner): void {
    for (const [id, t] of this.terminals) {
      if (t.owner !== owner) continue;
      t.owner = null;
      t.expiry = setTimeout(() => void this.shut(id, t), this.ttlMs);
      t.expiry.unref?.();
    }
  }

  /** Closes every terminal (the backend is stopping). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.terminals].map(([id, t]) => this.shut(id, t)));
  }

  private get(owner: Owner, id: string): Terminal<Owner> {
    const t = this.terminals.get(id);
    if (!t || t.owner !== owner) throw new Error('This terminal is closed.');
    return t;
  }

  private async shut(id: string, t: Terminal<Owner>): Promise<void> {
    this.release(id);
    await t.ws.runner.call('pty.close', { ptyId: t.ptyId }).catch(() => undefined);
  }

  private release(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    if (t.expiry) clearTimeout(t.expiry);
    t.off();
    this.terminals.delete(id);
  }
}
