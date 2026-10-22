/**
 * "Keep computer awake" for Code sessions (their More menu): while any session someone switched it on for is running,
 * the app holds a power-save blocker that keeps the system from sleeping (the display may still turn off). Each window
 * says which of its sessions need it; a window that closes, the switch going off, the run ending or the app quitting
 * lets go.
 */
import type { PowerSaveBlocker } from 'electron';

export class KeepAwake {
  /** By window (its webContents id): the sessions it keeps awake. */
  private sessions = new Map<number, ReadonlySet<string>>();
  private blocker: number | null = null;

  constructor(private readonly power: Pick<PowerSaveBlocker, 'start' | 'stop'>) {}

  /** The running sessions with the switch on in one window; empty lets go of them. */
  set(window: number, sessionIds: readonly string[]): void {
    if (sessionIds.length) this.sessions.set(window, new Set(sessionIds));
    else this.sessions.delete(window);
    this.update();
  }

  /** The window closed or reloaded. */
  release(window: number): void {
    this.sessions.delete(window);
    this.update();
  }

  /** The app is quitting. */
  stop(): void {
    this.sessions.clear();
    this.update();
  }

  get awake(): boolean {
    return this.blocker !== null;
  }

  private update(): void {
    const wanted = this.sessions.size > 0;
    if (wanted && this.blocker === null) this.blocker = this.power.start('prevent-app-suspension');
    else if (!wanted && this.blocker !== null) {
      this.power.stop(this.blocker);
      this.blocker = null;
    }
  }
}
