/**
 * Atelier's own windows, as opposed to the other windows the app holds: the screen overlay, the hidden ChatGPT Chat
 * browser and the identity sign-in window. Those must never be what opening Atelier shows, and a hidden one must never
 * keep Atelier running after its last real window closed.
 */
interface Tracked {
  isDestroyed(): boolean;
}

export class AppWindows<W extends Tracked> {
  private windows = new Set<W>();
  private last: W | null = null;

  add(win: W): void {
    this.windows.add(win);
  }

  remove(win: W): void {
    this.windows.delete(win);
    if (this.last === win) this.last = null;
  }

  /** A window got focus. Another kind of window isn't remembered, so it can't become the one that's shown. */
  focused(win: W): void {
    if (this.windows.has(win)) this.last = win;
  }

  /** The open ones, the one used last first. */
  list(): W[] {
    const open = [...this.windows].filter((w) => !w.isDestroyed());
    return this.last && open.includes(this.last) ? [this.last, ...open.filter((w) => w !== this.last)] : open;
  }
}
