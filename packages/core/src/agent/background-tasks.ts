/**
 * What Code and Cowork sessions keep going beside their turns (the Background tasks pane): commands Bash started with
 * `run_in_background`, sub-agents (in the foreground or the background) and loops (`/loop`, agent/loops.ts). Kept in
 * memory per top-level session (a sub-agent's commands count toward its parent's). Every kind of task brings how it
 * stops (and, if it prints, how its output is read); the registry keeps the list, tells the session when it changes and
 * drops finished tasks when asked. Running commands are checked every couple of seconds so the list shows when they end.
 */
import type { BackgroundTask, LoopSchedule } from '@atelier/protocol';
import type { Workspace } from '../workspaces/workspace.ts';

/** Finished tasks kept per session, besides the running ones. */
const KEEP_FINISHED = 20;
const POLL_MS = 2000;

export type TaskOutput = { output: string; offset: number; truncated: boolean; running: boolean; exitCode: number | null };

interface Entry {
  task: BackgroundTask;
  stop(): Promise<void>;
  /** Tasks that print: their output from character `since` on. */
  output?(since: number): Promise<TaskOutput>;
  /** Commands: checked while they run, to notice when they end. */
  check?(): Promise<Partial<BackgroundTask> | null>;
}

export interface BackgroundTasksDeps {
  /** A session's list changed; `tasks` is all of it. */
  changed(sessionId: string, tasks: BackgroundTask[]): void;
  /** Stops a sub-agent's run. */
  stopAgent(childSessionId: string): Promise<void>;
  now?(): number;
  pollMs?: number;
}

export class BackgroundTasks {
  private sessions = new Map<string, Map<string, Entry>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(private readonly deps: BackgroundTasksDeps) {}

  list(sessionId: string): BackgroundTask[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].map((e) => e.task);
  }

  /** How many of a session's tasks are still running. */
  running(sessionId: string): number {
    return this.list(sessionId).filter((t) => t.status === 'running').length;
  }

  /** A command Bash started in the background (`execId` is the runner's, which BashOutput and KillShell use too). */
  addCommand(sessionId: string, ws: Workspace, command: { execId: string; command: string; description?: string }): void {
    const { execId } = command;
    // How far the status checks have read: each check only fetches what is new.
    let offset = 0;
    this.add(sessionId, {
      task: this.task(execId, 'command', command.description || command.command, { command: command.command }),
      stop: async () => {
        await ws.runner.call('shell.kill', { execId }).catch(() => undefined);
        this.finish(sessionId, execId, 'stopped');
      },
      output: async (since) => {
        const r = await ws.runner.call('shell.read', { execId, sinceOffset: since });
        return { output: r.output, offset: r.offset, truncated: r.truncated, running: r.running, exitCode: r.exitCode };
      },
      check: async () => {
        const r = await ws.runner.call('shell.read', { execId, sinceOffset: offset }).catch(() => null);
        if (!r) return { status: 'stopped' };
        offset = r.offset;
        return r.running ? null : { status: r.exitCode === 0 ? 'done' : 'failed', exitCode: r.exitCode };
      },
    });
    this.poll();
  }

  /** A sub-agent started (`background`: its parent's turn goes on without waiting); returns the task's id for `endAgent`. */
  addAgent(sessionId: string, agent: { childSessionId: string; description: string; background?: boolean }): string {
    const id = `agent:${agent.childSessionId}`;
    const task = this.task(id, 'agent', agent.description, { sessionId: agent.childSessionId, background: agent.background ?? false });
    this.add(sessionId, { task, stop: () => this.deps.stopAgent(agent.childSessionId) });
    return id;
  }

  /** A loop started (agent/loops.ts keeps its schedule and stops it). */
  addLoop(sessionId: string, loop: { id: string; prompt: string; schedule: LoopSchedule; stop(): Promise<void> }): void {
    this.add(sessionId, { task: this.task(loop.id, 'loop', loop.prompt, { loop: loop.schedule }), stop: loop.stop });
  }

  /** A running loop sent its prompt, or came due while its session was busy. */
  loopChanged(sessionId: string, id: string, schedule: LoopSchedule): void {
    const entry = this.sessions.get(sessionId)?.get(id);
    if (!entry || entry.task.status !== 'running') return;
    entry.task = { ...entry.task, loop: schedule };
    this.deps.changed(sessionId, this.list(sessionId));
  }

  /** A loop ended: stopped, or done at its limits. */
  endLoop(sessionId: string, id: string, status: 'done' | 'stopped', schedule: LoopSchedule): void {
    this.finish(sessionId, id, status, { loop: schedule });
  }

  endAgent(sessionId: string, id: string, status: Exclude<BackgroundTask['status'], 'running'>): void {
    this.finish(sessionId, id, status);
  }

  /** The model stopped one of its commands with KillShell. */
  commandKilled(sessionId: string, execId: string): void {
    this.finish(sessionId, execId, 'stopped');
  }

  /** A task's output from character `since` on. */
  async output(sessionId: string, id: string, since: number): Promise<TaskOutput> {
    const entry = this.sessions.get(sessionId)?.get(id);
    if (!entry?.output) throw new Error('There is no such background command.');
    const r = await entry.output(since);
    return { ...r, running: r.running && entry.task.status === 'running' };
  }

  async stop(sessionId: string, id: string): Promise<void> {
    const entry = this.sessions.get(sessionId)?.get(id);
    if (!entry) throw new Error('There is no such background task.');
    if (entry.task.status === 'running') await entry.stop();
  }

  /** Drops a session's finished tasks (the pane's trash button). */
  clearFinished(sessionId: string): void {
    const entries = this.sessions.get(sessionId);
    if (!entries) return;
    const before = entries.size;
    for (const [id, e] of entries) if (e.task.status !== 'running') entries.delete(id);
    if (entries.size !== before) this.deps.changed(sessionId, this.list(sessionId));
  }

  /** The session is gone: forget its tasks (its commands end with its shell). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private task(id: string, kind: BackgroundTask['kind'], title: string, rest: Partial<BackgroundTask>): BackgroundTask {
    return { id, kind, title, command: null, sessionId: null, background: false, loop: null, startedAt: this.now(), endedAt: null, status: 'running', exitCode: null, ...rest };
  }

  private add(sessionId: string, entry: Entry): void {
    const entries = this.sessions.get(sessionId) ?? new Map<string, Entry>();
    entries.set(entry.task.id, entry);
    const finished = [...entries.values()].filter((e) => e.task.status !== 'running');
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) entries.delete(old.task.id);
    this.sessions.set(sessionId, entries);
    this.deps.changed(sessionId, this.list(sessionId));
  }

  /** A running task ended; one that already ended stays as it did. */
  private finish(sessionId: string, id: string, status: Exclude<BackgroundTask['status'], 'running'>, patch: Partial<BackgroundTask> = {}): void {
    const entry = this.sessions.get(sessionId)?.get(id);
    if (!entry || entry.task.status !== 'running') return;
    entry.task = { ...entry.task, ...patch, status, endedAt: this.now() };
    this.deps.changed(sessionId, this.list(sessionId));
  }

  /** Checks running commands while there are any. */
  private poll(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.deps.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  /** One round of status checks (every couple of seconds while commands run). */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const running = [...this.sessions].flatMap(([sessionId, entries]) => [...entries.values()].filter((e) => e.check && e.task.status === 'running').map((e) => ({ sessionId, e })));
      if (!running.length) return this.dispose();
      await Promise.all(
        running.map(async ({ sessionId, e }) => {
          const ended = await e.check!();
          if (ended) this.finish(sessionId, e.task.id, ended.status as Exclude<BackgroundTask['status'], 'running'>, ended);
        }),
      );
    } finally {
      this.checking = false;
    }
  }
}
