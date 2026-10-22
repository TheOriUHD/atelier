/**
 * The Background tasks pane (design/components.md › Code panes, opened from More or the transcript's "N running tasks"):
 * what this session runs beside its turns. "Running" lists a card per task — its title, its kind and how long it has
 * run, for a sub-agent its model, tokens, tool uses and what it is doing, for a loop how often it sends and when next —
 * each with a stop button; finished ones fold under "Finished N", which the trash button clears. A task opens in the
 * same pane: a sub-agent's transcript, a command's live output, a loop's prompt and schedule. Everything follows the
 * session's run events and the sub-agents' own sessions.
 *
 * Kinds are described once (`KINDS`): a new kind of task brings its label, what opening it shows and, if it has them,
 * the details its card adds.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { Activity, ChevronLeft, Trash2 } from 'lucide-react';
import { formatInterval, LOOP_MAX_AGE_MS, LOOP_MAX_RUNS, type BackgroundTask } from '@atelier/protocol';
import { Button, Icon, IconButton, Tooltip, cn } from '../../components/ui/index.ts';
import { useLiveSession, type LiveSessionState } from '../../lib/live-session.ts';
import { useModels } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Chevron, useNow } from '../chat/parts.tsx';
import { PaneMessage } from './file-tree.tsx';
import { formatTokenCount, liveContext, liveStatus } from './live-context.ts';
import { PaneFrame, PaneTitle, type PaneFrameState } from './pane-dock.tsx';
import { GroupedActivity, SubagentTranscript, taskOutcome } from './tool-cards.tsx';

/** How often a shown command's output is read while it runs (only while it is open). */
const OUTPUT_POLL_MS = 1000;
/** Output kept on screen per command. */
const OUTPUT_TAIL_CHARS = 100_000;

export const runningTasks = (tasks: readonly BackgroundTask[]) => tasks.filter((t) => t.status === 'running').length;

/** Below the last turn while background commands or sub-agents run: opens Background tasks. */
export function RunningTasksChip({ count, onOpen }: { count: number; onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-7 items-center gap-1.5 self-start rounded-full px-2.5 text-footnote text-interactive-text inset-ring inset-ring-line outline-none focus-ring hover:bg-fill-ghost-hover"
    >
      <Icon icon={Activity} className="size-3.5" />
      {count} running {count === 1 ? 'task' : 'tasks'}
    </button>
  );
}

/** "12s", "40m 36s", "20h 46m 11s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m ${s % 60}s`;
  return m ? `${m}m ${s % 60}s` : `${s % 60}s`;
}

interface Kind {
  /** What the card calls it ("Bash", "Agent", "Loop"). */
  label: string;
  /** The link that opens it in the pane. */
  open: string;
  /** What opening it shows. */
  View: ComponentType<{ sessionId: string; task: BackgroundTask }>;
  /** More about a running task, under its kind and time (`keepDetails`: also once it ended). */
  Details?: ComponentType<{ task: BackgroundTask }>;
  keepDetails?: boolean;
}

const KINDS: Record<BackgroundTask['kind'], Kind> = {
  command: { label: 'Bash', open: 'View output', View: CommandView },
  agent: { label: 'Agent', open: 'View transcript', View: AgentView, Details: AgentDetails },
  loop: { label: 'Loop', open: 'View loop', View: LoopView, Details: LoopDetails, keepDetails: true },
};

export function TasksPane({
  frame,
  sessionId,
  tasks,
  shown,
  onShow,
}: {
  frame: PaneFrameState;
  sessionId: string;
  tasks: BackgroundTask[];
  /** The task open in the pane; null for the list. */
  shown: string | null;
  onShow(taskId: string | null): void;
}) {
  const task = tasks.find((t) => t.id === shown);
  const finished = tasks.filter((t) => t.status !== 'running');
  if (task) {
    const { View } = KINDS[task.kind];
    return (
      <PaneFrame
        frame={frame}
        title="Background tasks"
        start={
          <>
            <IconButton
              icon={ChevronLeft}
              label="Back to background tasks"
              size="xs"
              className="text-fg-secondary"
              onClick={() => onShow(null)}
            />
            <PaneTitle>{task.title}</PaneTitle>
          </>
        }
        actions={<></>}
      >
        <View sessionId={sessionId} task={task} />
      </PaneFrame>
    );
  }
  return (
    <PaneFrame
      frame={frame}
      title="Background tasks"
      actions={
        <IconButton
          icon={Trash2}
          label="Clear finished tasks"
          size="xs"
          disabled={!finished.length}
          className="text-fg-secondary"
          onClick={() =>
            void rpc()
              .call('tasks.clear', { sessionId })
              .catch(() => {})
          }
        />
      }
    >
      <TaskList sessionId={sessionId} tasks={tasks} onShow={onShow} />
    </PaneFrame>
  );
}

/** "Running" with a card per running task, then the finished ones folded away. */
export function TaskList({
  sessionId,
  tasks,
  onShow,
}: {
  sessionId: string;
  tasks: BackgroundTask[];
  onShow(taskId: string): void;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const running = tasks.filter((t) => t.status === 'running');
  const finished = tasks.filter((t) => t.status !== 'running').reverse();
  if (!tasks.length)
    return (
      <div className="flex flex-1 items-center justify-center">
        <PaneMessage>Commands started in the background, sub-agents and loops show here while they work.</PaneMessage>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      {running.length > 0 && (
        <section aria-labelledby="tasks-running" className="flex flex-col gap-2">
          <h3 id="tasks-running" className="px-1 text-footnote text-fg-muted">
            Running
          </h3>
          <ul className="flex flex-col gap-2">
            {running.map((task) => (
              <TaskCard key={task.id} sessionId={sessionId} task={task} onShow={() => onShow(task.id)} />
            ))}
          </ul>
        </section>
      )}
      {finished.length > 0 && (
        <section aria-label="Finished" className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={showFinished}
            onClick={() => setShowFinished((s) => !s)}
            className="flex h-7 items-center gap-1 self-start rounded-sm px-1 text-footnote text-fg-muted outline-none focus-ring hover:text-fg"
          >
            Finished {finished.length}
            <Chevron open={showFinished} />
          </button>
          {showFinished && (
            <ul className="flex flex-col gap-2">
              {finished.map((task) => (
                <TaskCard key={task.id} sessionId={sessionId} task={task} onShow={() => onShow(task.id)} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * One task: what it is, its kind and time (and the kind's details while it runs), its link, and Stop while it runs.
 * Without `onShow` (Cowork, which has no pane to open it in) there is no link.
 */
export function TaskCard({
  sessionId,
  task,
  onShow,
}: {
  sessionId: string;
  task: BackgroundTask;
  onShow?: () => void;
}) {
  const kind = KINDS[task.kind];
  const running = task.status === 'running';
  const now = useNow(running);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    setStopping(true);
    setError(null);
    rpc()
      .call('tasks.stop', { sessionId, taskId: task.id })
      .catch((e: unknown) => setError(describeError(e).message))
      .finally(() => setStopping(false));
  };
  const time = formatDuration((task.endedAt ?? now) - task.startedAt);
  return (
    <li className="flex gap-3 rounded-xl bg-raised px-3 py-2.5 shadow-sm inset-ring inset-ring-line">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-body text-fg">{task.title}</p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-footnote text-fg-muted">
          <span>{kind.label}</span>
          {task.background && (
            <>
              <span aria-hidden>·</span>
              <span>Background</span>
            </>
          )}
          <span aria-hidden>·</span>
          {running ? (
            <span className="tabular-nums">{time}</span>
          ) : (
            <>
              <span className={cn(task.status === 'failed' && 'text-danger-text')}>{taskOutcome(task)}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{time}</span>
            </>
          )}
        </p>
        {(running || kind.keepDetails) && kind.Details && <kind.Details task={task} />}
        {onShow && (
          <button
            type="button"
            aria-label={`${kind.open}: ${task.title}`}
            onClick={onShow}
            className="self-start rounded-xs text-footnote text-interactive-text outline-none focus-ring hover:underline"
          >
            {kind.open}
          </button>
        )}
        {error && (
          <p role="alert" className="text-footnote text-danger-text">
            {error}
          </p>
        )}
      </div>
      {running && (
        <Tooltip content="Stop">
          <button
            type="button"
            aria-label={`Stop ${task.title}`}
            aria-busy={stopping || undefined}
            disabled={stopping}
            onClick={stop}
            className="flex size-6 shrink-0 items-center justify-center rounded-md inset-ring inset-ring-line-strong outline-none focus-ring hover:bg-fill-ghost-hover disabled:opacity-40"
          >
            <span className="size-2 rounded-[2px] bg-fg-secondary" />
          </button>
        </Tooltip>
      )}
    </li>
  );
}

/** What a sub-agent's run looks like now: its model, the tokens in its context, its tool uses and what it is doing. */
export function agentFacts(live: LiveSessionState): {
  model: string | null;
  tokens: number;
  toolUses: number;
  activity: string | null;
} {
  const toolUses = live.messages.reduce(
    (n, m) => (m.role === 'assistant' ? n + m.parts.filter((p) => p.type === 'tool_call').length : n),
    0,
  );
  const last = live.messages.findLast((m) => m.role === 'assistant' && m.usage)?.usage;
  const tokens =
    liveContext(live)?.used ?? (last ? last.input + (last.cacheRead ?? 0) + (last.cacheWrite ?? 0) + last.output : 0);
  const activity = live.session?.status === 'waiting' ? 'Waiting for your approval' : (liveStatus(live)?.verb ?? null);
  return { model: live.session?.model ?? null, tokens, toolUses, activity };
}

function AgentDetails({ task }: { task: BackgroundTask }) {
  const live = useLiveSession(task.sessionId!);
  const { data: models } = useModels();
  const facts = agentFacts(live);
  const model = models?.find((m) => m.ref === facts.model)?.displayName ?? facts.model;
  const parts = [
    model,
    facts.tokens ? `${formatTokenCount(facts.tokens)} tokens` : null,
    `${facts.toolUses} tool ${facts.toolUses === 1 ? 'use' : 'uses'}`,
    facts.activity,
  ];
  return <p className="text-footnote break-words text-fg-muted">{parts.filter(Boolean).join(' · ')}</p>;
}

/** A sub-agent's run in the pane: its model, the prompt it got and what it has done so far, live. */
function AgentView({ task }: { sessionId: string; task: BackgroundTask }) {
  const live = useLiveSession(task.sessionId!);
  const { data: models } = useModels();
  const model = live.session?.model
    ? (models?.find((m) => m.ref === live.session!.model)?.displayName ?? live.session.model)
    : null;
  const prompt =
    live.messages
      .find((m) => m.role === 'user')
      ?.parts.flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('\n') ?? '';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
      {model && (
        <p className="text-footnote text-fg-muted">
          Model <span className="text-fg-secondary">{model}</span>
        </p>
      )}
      {prompt && <ClampedText text={prompt} />}
      <section aria-label="Steps" className="flex flex-col gap-3">
        <SubagentTranscript sessionId={task.sessionId!} activity={GroupedActivity} />
      </section>
      {task.status !== 'running' && <p className="text-footnote text-fg-muted">{taskOutcome(task)}</p>}
    </div>
  );
}

/** "Every 5m · 3 runs · next in 4m 12s": a loop's schedule, live while it runs. */
export function loopSchedule(task: BackgroundTask, now: number): string {
  const loop = task.loop!;
  const next =
    task.status !== 'running'
      ? null
      : loop.waiting
        ? 'next once the session is idle'
        : loop.nextAt !== null
          ? `next in ${formatDuration(Math.ceil(Math.max(0, loop.nextAt - now) / 1000) * 1000)}`
          : null;
  return [`Every ${formatInterval(loop.intervalMs)}`, `${loop.runs} ${loop.runs === 1 ? 'run' : 'runs'}`, next]
    .filter(Boolean)
    .join(' · ');
}

function LoopDetails({ task }: { task: BackgroundTask }) {
  const now = useNow(task.status === 'running');
  return <p className="text-footnote break-words text-fg-muted">{loopSchedule(task, now)}</p>;
}

/** A loop in the pane: what it sends, how often and when next, when it ends on its own, and Stop. */
function LoopView({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const running = task.status === 'running';
  const now = useNow(running);
  const [error, setError] = useState<string | null>(null);
  const ends = new Date(task.startedAt + LOOP_MAX_AGE_MS).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
      <p className="text-footnote text-fg-muted">
        {running ? 'Sends this as your message:' : `${taskOutcome(task)}. It sent this as your message:`}
      </p>
      <ClampedText text={task.title} />
      <p className="text-footnote text-fg-secondary">{loopSchedule(task, now)}</p>
      {running && (
        <>
          <p className="text-footnote text-fg-muted">
            A run that comes due while the session is busy waits until it is idle. Stopping a response keeps the loop: its
            next run comes a full interval after the Stop. The loop ends after {LOOP_MAX_RUNS} runs or on {ends}, when you
            stop it or delete the session, and when Atelier’s backend restarts.
          </p>
          <Button
            size="sm"
            className="self-start"
            onClick={() =>
              void rpc()
                .call('tasks.stop', { sessionId, taskId: task.id })
                .catch((e: unknown) => setError(describeError(e).message))
            }
          >
            Stop loop
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-footnote text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

/** Long text clamped to ten lines, with Show more when it doesn't fit. */
function ClampedText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [all, setAll] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !all) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, all]);
  return (
    <div className="rounded-xl bg-fill-ghost-hover px-3 py-2.5">
      <p
        ref={ref}
        className={cn('text-footnote break-words whitespace-pre-wrap text-fg-secondary', !all && 'line-clamp-10')}
      >
        {text}
      </p>
      {(overflows || all) && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((a) => !a)}
          className="mt-1 rounded-xs text-footnote text-interactive-text outline-none focus-ring hover:underline"
        >
          {all ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** A command in the pane: what runs and its output, read again every second while it runs and this is open. */
function CommandView({ sessionId, task }: { sessionId: string; task: BackgroundTask }) {
  const [output, setOutput] = useState({ text: '', truncated: false, error: null as string | null });
  const pre = useRef<HTMLPreElement>(null);
  /** Where the next read starts: output already shown isn't read again. */
  const offset = useRef(0);
  const running = task.status === 'running';
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const r = await rpc().call('tasks.output', { sessionId, taskId: task.id, since: offset.current });
        if (stopped) return;
        offset.current = r.offset;
        setOutput((o) => ({
          text: (o.text + r.output).slice(-OUTPUT_TAIL_CHARS),
          truncated: o.truncated || r.truncated,
          error: null,
        }));
        if (r.running) timer = setTimeout(() => void read(), OUTPUT_POLL_MS);
      } catch (e) {
        if (!stopped) setOutput((o) => ({ ...o, error: describeError(e).message }));
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // A command that ends gets one last read.
  }, [sessionId, task.id, running]);
  // Keep the newest output in view.
  useLayoutEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output.text]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <p className="text-footnote text-fg-muted">{running ? 'Running' : taskOutcome(task)}</p>
      <div
        aria-label="Command"
        role="group"
        className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-code-background font-mono text-code inset-ring inset-ring-line"
      >
        <pre className="shrink-0 px-3 py-2 break-words whitespace-pre-wrap text-fg">
          <span className="text-fg-muted select-none">$ </span>
          {task.command}
        </pre>
        {output.error ? (
          <p className="border-t border-line px-3 py-2 font-sans text-footnote text-fg-muted">{output.error}</p>
        ) : (
          (output.text || output.truncated) && (
            <pre
              ref={pre}
              aria-label="Output"
              className="min-h-0 overflow-auto border-t border-line px-3 py-2 break-words whitespace-pre-wrap text-fg-secondary"
            >
              {output.truncated && <span className="text-fg-muted">[earlier output dropped]{'\n'}</span>}
              {output.text}
            </pre>
          )
        )}
      </div>
    </div>
  );
}
