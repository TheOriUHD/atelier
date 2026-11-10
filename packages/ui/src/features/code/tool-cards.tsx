/**
 * The Code transcript shows every tool call on its own: reads and searches as one-line summaries,
 * edits as inline diffs, commands with their live output and exit status, sub-agents with their own transcript.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AudioLines, Bot, Compass, Film, FolderInput, ListChecks, Maximize2, MessageSquare } from 'lucide-react';
import { PLAN_MODE_OFF, type BackgroundTask, type Notice, type Todo, type ToolResultPart } from '@atelier/protocol';
import { Badge, DiffStat, Icon, IconButton, ThinkingDots, cn } from '../../components/ui/index.ts';
import { queuedLabel, useLiveSession, type LiveSessionState } from '../../lib/live-session.ts';
import { blobUrl } from '../../lib/platform.ts';
import { useWorkspaces } from '../../lib/queries.ts';
import { Markdown, OpenFilePath } from '../chat/markdown.tsx';
import { Chevron, MessageError, ProviderStopped, Summary, ThinkingBlock, ThinkingText, TranscriptDetail, detailClass, elapsed, useNow } from '../chat/parts.tsx';
import { LINE } from '../chat/rows.ts';
import { isStreaming, stepView, toolResults, turnItems, type ActivityStepView } from '../chat/turns.ts';
import { ChangeView } from './change-view.tsx';
import { DiffCard, editRows, placedEditRows, writeRows } from './inline-diff.tsx';
import { displayPath, languageOf } from './paths.ts';
import { workspaceLabel } from './workspaces.ts';
import { TodoList } from './todo-widget.tsx';
import { OWN_CARD, activityLabel, failedCount } from './activity-summary.ts';
import { SESSION_ROUTE } from '../../app/navigation.ts';
import { SearchResults } from './search-results.tsx';
import { WithViewedImages } from '../chat/images.tsx';
import { CommandCode } from './command-code.tsx';
import { navigatorNotes } from '../coop/coop.ts';
import { MEMORY_TOOLS, MemoryStep } from '../chat/memory-steps.tsx';
import { activitySummary, asRecord, backgroundId, backgroundSummary, bashResult, changedLines, count, messageReceipt, resultText, shownCall, str, summarize, taskOutcome } from '@atelier/client/tools.ts';
export { activitySummary, actionWords, asRecord, backgroundId, backgroundSummary, bashResult, computerActions, folderName, folderRead, messageReceipt, str, summarize, taskOutcome } from '@atelier/client/tools.ts';

export type ToolStep = Extract<ActivityStepView, { kind: 'tool' }>;

/** The workspace root, so cards can show paths relative to it. */
export const WorkspaceRoot = createContext<string | null>(null);

/** Opens a workspace file in the Files pane (the Code page provides it); file names in summaries then open it. */
export { OpenFilePath as OpenWorkspaceFile } from '../chat/markdown.tsx';

/** Whether Edit/Write diffs and command output start open: Code shows them, Work keeps each call to one line. */
export const ToolCardsOpen = createContext(true);

/** The session whose calls the cards show: an Edit's whole-file view reads the file through it. */
export const TranscriptSession = createContext<string | null>(null);

/**
 * The session's background commands, sub-agents and loops, and showing one in the Background tasks pane (Code; Cowork
 * has no pane to open them in, so no `open`).
 */
export const SessionTasks = createContext<{ tasks: BackgroundTask[]; open?(taskId?: string): void } | null>(null);

/** Whether a card starts open: always in the verbose transcript view, else when `byDefault`. */
function useStartsOpen(byDefault: boolean): boolean {
  return useContext(TranscriptDetail) === 'verbose' || byDefault;
}

/** A Bash call that started its command in the background. */
const isBackground = (step: ActivityStepView): step is ToolStep => step.kind === 'tool' && step.call.name === 'Bash' && asRecord(step.call.input).run_in_background === true;

/**
 * A run of tool calls (and the thinking between them), one card each. Commands started in the background one after
 * another share one card, where the Background tasks pane can tell how they are doing.
 */
export function CodeActivity({ steps, live = false, turnSince }: { steps: ActivityStepView[]; live?: boolean; turnSince?: number }) {
  const detail = useContext(TranscriptDetail);
  if (detail === 'verbose') return <ActivityList steps={steps} />;
  return <CompactActivity steps={steps} live={live} thinking={detail === 'thinking'} turnSince={turnSince} />;
}

/**
 * Normal and Thinking views: the run of calls as one line, a summary once it's done ("Read 4 files, ran 9 commands")
 * or what it's doing while it runs, opening to the full list. Plans and sub-agents keep their own cards; the Thinking
 * view also keeps the thinking.
 */
function CompactActivity({ steps, live, thinking, turnSince }: { steps: ActivityStepView[]; live: boolean; thinking: boolean; turnSince?: number }) {
  const root = useContext(WorkspaceRoot);
  const [open, setOpen] = useState(false);
  const now = useNow(live);
  // Commands started in the background stay on their card too: they're tasks with a life of their own.
  const kept = steps.filter((s) => (s.kind === 'tool' ? OWN_CARD.has(s.call.name) || isBackground(s) : thinking));
  const folded = steps.filter((s) => !kept.includes(s));
  // The whole turn, from the person's message, not the step the run is in.
  const since = turnSince ?? steps.find((s) => s.kind === 'tool')?.since;
  return (
    <div className="flex flex-col gap-2.5">
      {folded.length > 0 && (
        <WithViewedImages steps={folded}>
          {live ? (
            <div role="status" aria-live="off" className="flex">
              <Summary open={open} onToggle={() => setOpen((o) => !o)}>
                <ThinkingDots />
                <span className="truncate">{activityLabel(folded, root)}</span>
                {since !== undefined && <span className="shrink-0 text-fg-muted tabular-nums">{elapsed(now, since)}</span>}
              </Summary>
            </div>
          ) : (
            <FinishedLine steps={folded} root={root} open={open} onToggle={() => setOpen((o) => !o)} />
          )}
        </WithViewedImages>
      )}
      {open && folded.length > 0 && <ActivityRows steps={folded} />}
      {kept.length > 0 && <ActivityList steps={kept} />}
    </div>
  );
}

/** "Read app.ts, ran 9 commands (1 failed)" with the lines its edits added and removed. */
function FinishedLine({ steps, root, open, onToggle }: { steps: ActivityStepView[]; root: string | null; open: boolean; onToggle(): void }) {
  const tools = steps.filter((s) => s.kind === 'tool');
  const failed = failedCount(tools);
  const changed = tools.map((s) => changedLines(s.call)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
  return (
    <Summary open={open} onToggle={onToggle}>
      <span className="truncate">
        {tools.length ? activitySummary(tools.map(shownCall), root) : 'Thought it over'}
        {failed > 0 && ` (${failed} failed)`}
      </span>
      {(changed.added > 0 || changed.removed > 0) && <DiffStat added={changed.added} removed={changed.removed} />}
    </Summary>
  );
}

/**
 * An opened compact line: one bordered group with a row per step. A row is titled by what the
 * step did (a command by its description) and opens to its command and output, its diff or its result.
 */
function ActivityRows({ steps }: { steps: ActivityStepView[] }) {
  return (
    <div role="group" aria-label="Steps" className="overflow-hidden rounded-xl inset-ring inset-ring-line">
      {steps.map((step) => (
        <ActivityRow key={step.key} step={step} />
      ))}
    </div>
  );
}

function ActivityRow({ step }: { step: ActivityStepView }) {
  const root = useContext(WorkspaceRoot);
  const [open, setOpen] = useState(false);
  const running = step.kind === 'tool' ? step.running : step.active;
  const now = useNow(running);
  let title = 'Thinking';
  let status: ReactNode = null;
  let body: ReactNode;
  if (step.kind === 'tool') {
    const input = asRecord(step.call.input);
    const text = step.result ? resultText(step.result) : null;
    const summary = summarize(shownCall(step), text, root);
    const failed = !!step.result?.isError;
    switch (step.call.name) {
      case 'Bash': {
        const command = str(input.command);
        const done = step.result ? bashResult(resultText(step.result)) : null;
        title = str(input.description) || command;
        const exit = done?.note ?? (done?.exitCode != null && done.exitCode !== 0 ? `Exit code ${done.exitCode}` : null);
        if (exit) status = <span className="shrink-0 text-danger-text">{exit}</span>;
        body = <CommandBlock command={command} output={done ? done.output : (step.output ?? '')} live={!done} split />;
        break;
      }
      case 'Edit':
      case 'Write': {
        const created = step.result && !failed && !text?.startsWith('Updated') && step.call.name === 'Write';
        title = `${failed || !step.result ? step.call.name : step.call.name === 'Edit' ? 'Edited' : created ? 'Created' : 'Updated'} ${summary.target}`;
        if (text && navigatorNotes(text).notes.length) status = <span className="shrink-0 text-warning-text">Navigator note</span>;
        body = <FileChangeBody step={step} />;
        break;
      }
      case 'TodoWrite':
        title = 'Updated the task list';
        body = <TodoList todos={(input.todos ?? []) as Todo[]} running={false} />;
        break;
      case 'SendMessage':
        title = summary.verb;
        if (summary.meta) status = <span className="min-w-0 truncate text-fg-muted">{summary.meta}</span>;
        body = <MessageSent step={step} />;
        break;
      case 'WebSearch':
        title = `${summary.verb}${summary.target ? ` ${summary.target}` : ''}`;
        if (summary.meta) status = <span className="shrink-0 text-fg-muted">{summary.meta}</span>;
        body = text != null ? <SearchResults text={text} failed={failed} /> : null;
        break;
      case 'SaveImage':
      case 'SaveVideo':
      case 'SaveAudio':
        title = `${summary.verb} ${summary.target}`;
        if (step.result?.saved) status = <SavedThumbnail image={step.result.saved} />;
        body = <pre className={cn(detailClass, failed ? 'text-danger-text' : 'text-fg')}>{text ?? JSON.stringify(step.call.input, null, 2)}</pre>;
        break;
      default:
        title = `${summary.verb}${summary.target ? ` ${summary.target}` : ''}`;
        if (summary.meta) status = <span className="shrink-0 text-fg-muted">{summary.meta}</span>;
        body = <pre className={cn(detailClass, failed ? 'text-danger-text' : 'text-fg')}>{text ?? JSON.stringify(step.call.input, null, 2)}</pre>;
    }
    if (failed && !status) status = <span className="shrink-0 text-danger-text">Failed</span>;
  } else {
    body = <ThinkingText text={step.text} />;
  }
  return (
    <div className="border-t border-line first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-body text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg"
      >
        {running && <ThinkingDots />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {running && step.kind === 'tool' && <span className="shrink-0 text-fg-muted tabular-nums">{elapsed(now, step.since)}</span>}
        {status}
        <Chevron open={open} />
      </button>
      {open && body && <div className="px-3 pt-1 pb-3">{body}</div>}
    </div>
  );
}

/** The image a SaveImage call wrote, small enough to sit on its row. */
function SavedThumbnail({ image }: { image: NonNullable<ToolResultPart['saved']> }) {
  // A clip or a sound has no picture of its own to put on a row; the film or wave mark says what was saved.
  if (image.mime.startsWith('video/')) return <span aria-hidden="true" className="flex h-6 w-8 shrink-0 items-center justify-center rounded-[6px] border border-line bg-fill-ghost-hover text-fg-muted"><Film className="size-3.5" /></span>;
  if (image.mime.startsWith('audio/')) return <span aria-hidden="true" className="flex h-6 w-8 shrink-0 items-center justify-center rounded-[6px] border border-line bg-fill-ghost-hover text-fg-muted"><AudioLines className="size-3.5" /></span>;
  return <img src={blobUrl(image.blob)} alt="" loading="lazy" className="h-6 w-8 shrink-0 rounded-[6px] border border-line bg-fill-ghost-hover object-cover" />;
}

/** One card per call (Verbose, and an opened compact line). */
export function ActivityList({ steps }: { steps: ActivityStepView[] }) {
  const tasks = useContext(SessionTasks);
  const items: (ActivityStepView | ToolStep[])[] = [];
  for (const step of steps) {
    const last = items.at(-1);
    if (tasks?.open && isBackground(step)) {
      if (Array.isArray(last)) last.push(step);
      else items.push([step]);
    } else items.push(step);
  }
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((item) =>
        Array.isArray(item) ? (
          <BackgroundCommandsCard key={item[0]!.key} steps={item} />
        ) : item.kind === 'thinking' ? (
          <ThinkingBlock key={item.key} text={item.text} active={item.active} />
        ) : (
          <ToolCard key={item.key} step={item} />
        ),
      )}
    </div>
  );
}

/** Commands started in the background in a row: how many finished and how many run, each one a click from its output. */
function BackgroundCommandsCard({ steps }: { steps: ToolStep[] }) {
  const session = useContext(SessionTasks)!;
  const [open, setOpen] = useState(useStartsOpen(false));
  const rows = steps.map((step) => {
    const id = backgroundId(step.result);
    return { step, id, task: id ? session.tasks.find((t) => t.id === id) : undefined };
  });
  // Not started yet (the call is still out) counts as running.
  const running = rows.filter((r) => !r.task || r.task.status === 'running').length;
  return (
    <div className="flex flex-col">
      <Summary open={open} onToggle={() => setOpen((o) => !o)}>
        <span className="truncate">{backgroundSummary(rows.length - running, running)}</span>
      </Summary>
      {open && (
        <ul className="mt-2 overflow-hidden rounded-xl inset-ring inset-ring-line">
          {rows.map(({ step, id, task }) => {
            const input = asRecord(step.call.input);
            return (
              <li key={step.key} className="flex h-9 items-center gap-2 border-t border-line px-3 text-body first:border-t-0">
                <span className="min-w-0 flex-1 truncate text-fg">{str(input.description) || str(input.command)}</span>
                <span className={cn('shrink-0 text-footnote', task?.status === 'failed' ? 'text-danger-text' : 'text-fg-muted')}>
                  {task ? taskOutcome(task) : step.result?.isError ? 'Failed' : 'Starting'}
                </span>
                {id && task && (
                  <button type="button" onClick={() => session.open?.(id)} className="shrink-0 rounded-xs text-footnote text-interactive-text outline-none focus-ring hover:underline">
                    View output
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A run of tool calls as one summary line (what it did, +/− lines changed) that opens to a card per call. */
export function GroupedActivity({ steps }: { steps: ActivityStepView[] }) {
  const root = useContext(WorkspaceRoot);
  const [open, setOpen] = useState(useStartsOpen(false));
  const tools = steps.filter((s) => s.kind === 'tool');
  const changed = tools.map((s) => changedLines(s.call)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
  return (
    <div className="flex flex-col">
      <WithViewedImages steps={steps}>
        <Summary open={open} onToggle={() => setOpen((o) => !o)}>
          {steps.some((s) => (s.kind === 'tool' ? s.running : s.active)) && <ThinkingDots />}
          <span className="truncate">{tools.length ? activitySummary(tools.map(shownCall), root) : 'Thought process'}</span>
          {(changed.added > 0 || changed.removed > 0) && <DiffStat added={changed.added} removed={changed.removed} />}
        </Summary>
      </WithViewedImages>
      {open && (
        <div className="mt-2 border-l-2 border-line pl-4">
          <ActivityList steps={steps} />
        </div>
      )}
    </div>
  );
}

function ToolCard({ step }: { step: ToolStep }) {
  if (MEMORY_TOOLS.has(step.call.name)) return <MemoryStep steps={[step]} />;
  switch (step.call.name) {
    case 'Edit':
    case 'Write':
      return <FileChangeCard step={step} />;
    case 'Bash':
      return <BashCard step={step} />;
    case 'Agent':
      return <SubagentCard step={step} />;
    case 'ExitPlanMode':
      return <PlanCard step={step} />;
    case 'TodoWrite':
      return <OneLineCard step={step} detail={<TodoList todos={(asRecord(step.call.input).todos ?? []) as Todo[]} running={false} className="mt-1" />} />;
    case 'SendMessage':
      return <OneLineCard step={step} detail={<MessageSent step={step} className="mt-2" />} />;
    case 'WebSearch':
      return <OneLineCard step={step} detail={step.result ? <SearchResults text={resultText(step.result)} failed={!!step.result.isError} className="mt-2" /> : undefined} />;
    default:
      return <OneLineCard step={step} />;
  }
}

/**
 * A summary line whose file name opens the file in the Files pane. The row still opens the card: the toggle covers it
 * and the file name sits above it, so neither button is inside the other. Without a pane to open files in (or for a
 * file outside the workspace), a plain summary.
 */
function FileSummary({ open, onToggle, running, verb, path, children }: { open: boolean; onToggle(): void; running: boolean; verb: string; path: string; children?: ReactNode }) {
  const root = useContext(WorkspaceRoot);
  const openFile = useContext(OpenFilePath);
  const shown = displayPath(path, root);
  if (!openFile || !path || (shown === path && path.startsWith('/'))) {
    return (
      <Summary open={open} onToggle={onToggle}>
        {running && <ThinkingDots />}
        <span className="truncate">
          {verb} <span className="text-fg">{shown}</span>
        </span>
        {children}
      </Summary>
    );
  }
  return (
    <div className="relative flex max-w-full items-center gap-1.5 self-start text-body leading-[21px] text-fg-secondary hover:text-fg">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex shrink-0 items-center gap-1.5 rounded-sm outline-none after:absolute after:inset-0 focus-ring">
        {running && <ThinkingDots />}
        {verb}
      </button>
      <button
        type="button"
        title="Open in Files"
        onClick={() => openFile(path)}
        className="relative min-w-0 truncate rounded-xs text-fg underline-offset-2 outline-none focus-ring hover:underline"
      >
        {shown}
      </button>
      {children}
      <Chevron open={open} />
    </div>
  );
}

/** Read, Glob, Grep and the rest: one line that opens to the result (or `detail`). */
function OneLineCard({ step, detail }: { step: ToolStep; detail?: ReactNode }) {
  const root = useContext(WorkspaceRoot);
  const [open, setOpen] = useState(useStartsOpen(false));
  const text = step.result ? resultText(step.result) : null;
  const { verb, target, meta } = summarize(shownCall(step), text, root);
  const after = (
    <>
      {meta && <span className="shrink-0 text-fg-muted">{meta}</span>}
      {step.result?.isError && <span className="shrink-0 text-danger-text">Failed</span>}
    </>
  );
  return (
    <div className="flex flex-col">
      <WithViewedImages steps={[step]}>
        {step.call.name === 'Read' || step.call.name === 'SaveImage' || step.call.name === 'SaveVideo' || step.call.name === 'SaveAudio' ? (
          <FileSummary open={open} onToggle={() => setOpen((o) => !o)} running={step.running} verb={verb} path={str(asRecord(step.call.input).file_path)}>
            {after}
          </FileSummary>
        ) : (
          <Summary open={open} onToggle={() => setOpen((o) => !o)}>
            {step.running && <ThinkingDots />}
            <span className="truncate">
              {verb}
              {target && <span className="text-fg"> {target}</span>}
            </span>
            {after}
          </Summary>
        )}
      </WithViewedImages>
      {open &&
        (detail ?? (
          <pre className={cn(detailClass, 'mt-2', step.result?.isError ? 'text-danger-text' : 'text-fg')}>
            {text ?? JSON.stringify(step.call.input, null, 2)}
          </pre>
        ))}
    </div>
  );
}

/** Edit and Write: the change as an inline diff, open by default in Code. */
function FileChangeCard({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(useStartsOpen(useContext(ToolCardsOpen)));
  const input = asRecord(step.call.input);
  const path = str(input.file_path);
  const edit = step.call.name === 'Edit';
  const rows = edit ? editRows(str(input.old_string), str(input.new_string)) : writeRows(str(input.content));
  const text = resultText(step.result);
  const failed = !!step.result?.isError;
  const verb = !step.result || failed ? step.call.name : edit ? 'Edited' : text.startsWith('Updated') ? 'Updated' : 'Created';
  return (
    <div className="flex flex-col">
      <FileSummary open={open} onToggle={() => setOpen((o) => !o)} running={step.running} verb={verb} path={path}>
        <DiffStat added={rows.filter((r) => r.kind === 'add').length} removed={rows.filter((r) => r.kind === 'remove').length} />
        {failed && <span className="shrink-0 text-danger-text">Failed</span>}
        {!failed && navigatorNotes(text).notes.length > 0 && <span className="shrink-0 text-warning-text">Navigator note</span>}
      </FileSummary>
      {open && (
        <div className="mt-2">
          <FileChangeBody step={step} />
        </div>
      )}
    </div>
  );
}

/**
 * An Edit's or Write's change as a diff, with the failure above it when it failed. A made Edit carries where it landed:
 * the file's line numbers and the lines around it. Show the whole file opens it over the app, an Edit's read as it is now.
 */
function FileChangeBody({ step }: { step: ToolStep }) {
  const root = useContext(WorkspaceRoot);
  const sessionId = useContext(TranscriptSession);
  const [whole, setWhole] = useState(false);
  const input = asRecord(step.call.input);
  const path = str(input.file_path);
  const edit = step.call.name === 'Edit';
  const failed = !!step.result?.isError;
  const place = edit && !failed ? step.result?.edit : undefined;
  const rows = edit ? placedEditRows(str(input.old_string), str(input.new_string), place) : writeRows(str(input.content));
  // A Write's card holds the whole file already; an Edit's file is read through its session.
  const viewable = !!step.result && !failed && (!edit || !!sessionId);
  const verb = edit ? 'Edited' : resultText(step.result).startsWith('Updated') ? 'Updated' : 'Created';
  return (
    <div className="flex flex-col gap-2">
      {failed && <pre className={cn(detailClass, 'text-danger-text')}>{resultText(step.result)}</pre>}
      {rows.length > 0 && (
        <DiffCard
          rows={rows}
          language={languageOf(path)}
          lineNumbers={!edit || !!place}
          limit={edit ? 40 : 12}
          action={viewable && <IconButton icon={Maximize2} label="Show the whole file" size="sm" onClick={() => setWhole(true)} />}
        />
      )}
      {place && place.matches > 1 && (
        <p className="text-footnote text-fg-muted">
          This changed {place.matches} places. The first is shown, at line {place.line}.
        </p>
      )}
      {!failed && <NavigatorNotes text={resultText(step.result)} />}
      {whole && (
        <ChangeView
          {...(edit && sessionId ? { source: { sessionId, callId: step.call.id } } : {})}
          title={`${verb} ${displayPath(path, root)}`}
          reason={str(input.reason)}
          language={languageOf(path)}
          change={rows}
          onClose={() => setWhole(false)}
        />
      )}
    </div>
  );
}

/** Co-op: what a navigator's model noted about an edit (it joins the edit's result), as a small note under the change. */
export function NavigatorNotes({ text }: { text: string }) {
  const { notes } = navigatorNotes(text);
  if (!notes.length) return null;
  return (
    <>
      {notes.map((n, i) => (
        <aside key={i} aria-label={`Navigator · ${n.name}`} className="flex flex-col gap-0.5 rounded-lg bg-warning-subtle px-3 py-2">
          <span className="flex items-center gap-1.5 text-footnote font-medium text-warning-text">
            <Icon icon={Compass} className="size-3.5" />
            Navigator · {n.name}
          </span>
          <p className="text-footnote whitespace-pre-wrap text-fg-secondary">{n.text}</p>
        </aside>
      ))}
    </>
  );
}

/** Bash: what it does, the command, its output while it runs and after, and how it exited. */
function BashCard({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(useStartsOpen(useContext(ToolCardsOpen)));
  const now = useNow(step.running);
  const input = asRecord(step.call.input);
  const command = str(input.command);
  const done = step.result ? bashResult(resultText(step.result)) : null;
  const output = done ? done.output : (step.output ?? '');
  const status = done?.note ?? (done?.exitCode != null ? `Exit code ${done.exitCode}` : null);
  return (
    <div className="flex flex-col">
      <Summary open={open} onToggle={() => setOpen((o) => !o)}>
        {step.running && <ThinkingDots />}
        <span className="truncate">{str(input.description) || command}</span>
        {step.running && <span className="shrink-0 text-fg-muted tabular-nums">{elapsed(now, step.since)}</span>}
        {status && <span className={cn('shrink-0', done?.exitCode === 0 ? 'text-fg-muted' : 'text-danger-text')}>{status}</span>}
      </Summary>
      {/* Streaming output would be read out chunk by chunk; the end is said once instead. */}
      <span role="status" className="sr-only">
        {done ? `Command finished${status ? `. ${status}` : ''}` : ''}
      </span>
      {open && (
        <div className="mt-2">
          <CommandBlock command={command} output={output} live={!done} />
        </div>
      )}
    </div>
  );
}

/**
 * The command with its output under it: in one code card, or (`split`, as in an opened group of steps) the command in
 * its card and the output below it on the page.
 */
function CommandBlock({ command, output, live, split }: { command: string; output: string; live: boolean; split?: boolean }) {
  const line = (
    <pre className="px-3 py-2 break-words whitespace-pre-wrap text-fg">
      <span className="text-fg-muted select-none">$ </span>
      <CommandCode command={command} />
    </pre>
  );
  if (split)
    return (
      <div aria-label="Command" role="group" className="flex flex-col gap-2 font-mono text-code">
        <div className="overflow-hidden rounded-lg bg-code-background inset-ring inset-ring-line">{line}</div>
        {output && <CommandOutput text={output} live={live} bare />}
      </div>
    );
  return (
    <div aria-label="Command" role="group" className="overflow-hidden rounded-xl bg-code-background font-mono text-code inset-ring inset-ring-line">
      {line}
      {output && <CommandOutput text={output} live={live} />}
    </div>
  );
}

function CommandOutput({ text, live, bare }: { text: string; live: boolean; bare?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  // Keep the newest output in view while the command runs.
  useLayoutEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, live]);
  return (
    <pre ref={ref} aria-label="Output" className={cn('max-h-64 overflow-auto break-words whitespace-pre-wrap text-fg-secondary', bare ? 'px-1' : 'border-t border-line px-3 py-2')}>
      {text}
    </pre>
  );
}

/** ExitPlanMode in the transcript: the plan, collapsed, and whether it was approved (the card at the end asks). */
function PlanCard({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(useStartsOpen(false));
  const status = step.result
    ? resultText(step.result) === PLAN_MODE_OFF
      ? 'Not in plan mode'
      : step.result.isError
        ? 'Not approved'
        : 'Approved'
    : step.running
      ? 'Waiting for approval'
      : null;
  return (
    <div className="flex flex-col">
      <Summary open={open} onToggle={() => setOpen((o) => !o)}>
        <Icon icon={ListChecks} className="text-fg-muted" />
        <span className="text-fg">Plan</span>
        {status && <span className="text-fg-muted">{status}</span>}
      </Summary>
      {open && (
        <div className="mt-2 rounded-xl px-4 py-3 inset-ring inset-ring-line">
          <Markdown text={str(asRecord(step.call.input).plan)} streaming={false} />
        </div>
      )}
    </div>
  );
}

/**
 * A sub-agent (Agent tool): its task, what it is doing now, and its own transcript when opened. One the model started
 * in the background says so; its call came back at once, so its status follows its own run, and in Code it opens in
 * Background tasks too.
 */
function SubagentCard({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(useStartsOpen(false));
  const tasks = useContext(SessionTasks);
  const input = asRecord(step.call.input);
  const childId = step.call.childSessionId;
  const background = input.run_in_background === true && !!childId && !step.result?.isError;
  const task = background ? tasks?.tasks.find((t) => t.sessionId === childId) : undefined;
  const description = str(input.description) || 'Sub-agent';
  return (
    <div className="flex flex-col rounded-xl inset-ring inset-ring-line">
      {/* The title gives way first: what the sub-agent does keeps room even in a narrow transcript. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 min-w-0 items-center gap-2 rounded-xl px-3 text-left text-body text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover"
      >
        <Icon icon={Bot} className="text-fg-muted" />
        <span className="max-w-[50%] min-w-0 truncate text-fg">{description}</span>
        {background && <Badge>Background</Badge>}
        <span className="flex min-w-0 shrink-0 grow basis-24 items-center gap-1.5">
          {childId ? <SubagentStatus sessionId={childId} step={step} task={background ? (task ?? null) : undefined} /> : step.running && <ThinkingDots />}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
          <p className="line-clamp-3 text-footnote whitespace-pre-wrap text-fg-muted">{str(input.prompt)}</p>
          {task && tasks?.open && (
            <button
              type="button"
              aria-label={`View transcript: ${description}`}
              onClick={() => tasks.open!(task.id)}
              className="self-start rounded-xs text-footnote text-interactive-text outline-none focus-ring hover:underline"
            >
              View transcript
            </button>
          )}
          {childId && <SubagentTranscript sessionId={childId} />}
        </div>
      )}
    </div>
  );
}

/** The Agent tool's answer for a sub-agent that was stopped. */
const stopped = (result: ToolResultPart) => resultText(result).startsWith('The sub-agent was stopped');

/** How a sub-agent the Agent call waited for ended, from that call's result. */
function callOutcome(result: ToolResultPart | undefined): 'done' | 'failed' | 'stopped' | null {
  if (!result) return null;
  return result.isError ? (stopped(result) ? 'stopped' : 'failed') : 'done';
}

/** How a background sub-agent's own run ended, read from its session where no task list says (it never started: not ended). */
function childOutcome(live: LiveSessionState): 'done' | 'failed' | 'stopped' | null {
  const last = live.messages.findLast((m) => m.role === 'assistant');
  if (!last || live.session?.status === 'running' || live.session?.status === 'waiting') return null;
  return last.error ? 'failed' : last.stopReason === 'aborted' ? 'stopped' : 'done';
}

/**
 * What a sub-agent is doing, or how it ended: from the Agent call's result, or, for one in the background (`task`: its
 * entry in Background tasks, null where there is none), from its task and its own run.
 */
function SubagentStatus({ sessionId, step, task }: { sessionId: string; step: ToolStep; task?: BackgroundTask | null }) {
  const root = useContext(WorkspaceRoot);
  const live = useLiveSession(sessionId);
  const calls = live.messages.flatMap((m) => (m.role === 'assistant' ? m.parts.filter((p) => p.type === 'tool_call') : []));
  const ended = task === undefined ? callOutcome(step.result) : task ? (task.status === 'running' ? null : task.status) : childOutcome(live);
  if (ended)
    return ended === 'done' ? (
      <span className="truncate text-fg-muted">Done · {count(calls.length, 'tool use')}</span>
    ) : (
      <span className={cn('truncate', ended === 'stopped' ? 'text-fg-muted' : 'text-danger-text')}>{ended === 'stopped' ? 'Stopped' : 'Failed'}</span>
    );
  if (task === undefined && !step.running) return null;
  const last = calls.at(-1);
  const activity = last ? summarize(last, null, root) : null;
  // Waiting for its turn: the model's server is busy with other sub-agents or requests.
  const label = live.phase === 'retrying' ? `Connection interrupted. Retry ${live.retryAttempt ?? 1} of 10` : live.queued !== null ? queuedLabel(live.queued) : live.compacting ? 'Compacting conversation…' : live.phase === 'loading' ? 'Loading model…' : live.phase === 'reading' ? 'Reading context…' : activity ? `${activity.verb} ${activity.target}` : 'Working…';
  return (
    <>
      <ThinkingDots />
      <span className="truncate text-fg-muted">{label}</span>
    </>
  );
}

/**
 * Where a background sub-agent's end reached its parent's model, in the parent's transcript: "Background agent finished ·
 * Survey the repo", with its transcript a click away in Code.
 */
export function AgentNotice({ notice }: { notice: Extract<Notice, { kind: 'agent' }> }) {
  const tasks = useContext(SessionTasks);
  const task = tasks?.tasks.find((t) => t.id === notice.taskId);
  const ended = { done: 'finished', failed: 'failed', stopped: 'stopped' }[notice.status];
  return (
    <div {...LINE} className="flex min-h-6 items-center gap-1.5 text-footnote text-fg-muted">
      <Icon icon={Bot} className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        Background agent {ended} · <span className="text-fg-secondary">{notice.title}</span>
      </span>
      {task && tasks?.open && (
        <button
          type="button"
          aria-label={`View transcript: ${notice.title}`}
          onClick={() => tasks.open!(task.id)}
          className="shrink-0 rounded-xs text-interactive-text outline-none focus-ring hover:underline"
        >
          View transcript
        </button>
      )}
    </div>
  );
}

/** The person moved the session to another folder (`sessions.move`): one line where it happened, the paths in its tooltip. */
export function MovedNotice({ notice }: { notice: Extract<Notice, { kind: 'moved' }> }) {
  const { data: workspaces = [] } = useWorkspaces();
  const name = ({ workspaceId, root }: { workspaceId: string; root: string }) => {
    const folder = workspaces.find((w) => w.id === workspaceId);
    return folder ? workspaceLabel(folder) : (root.split(/[\\/]/).filter(Boolean).at(-1) ?? root);
  };
  return (
    <div {...LINE} title={`${notice.from.root} → ${notice.to.root}`} className="flex min-h-6 items-center gap-1.5 text-footnote text-fg-muted">
      <Icon icon={FolderInput} className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        Moved from {name(notice.from)} to <span className="text-fg-secondary">{name(notice.to)}</span>
      </span>
    </div>
  );
}

/** A sent message: where it went (title and id) and what it said, then what the result reported. */
function MessageSent({ step, className }: { step: ToolStep; className?: string }) {
  const input = asRecord(step.call.input);
  const text = step.result ? resultText(step.result) : null;
  const sent = text != null ? messageReceipt(text) : null;
  const failed = !!step.result?.isError;
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-xl p-3 inset-ring inset-ring-line', className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-footnote text-fg-muted">
        <span>To</span>
        {sent && <span className="text-fg-secondary">{sent.title}</span>}
        <span className="font-mono break-all">{sent?.id ?? str(input.to)}</span>
      </div>
      <p data-selectable className="text-body break-words whitespace-pre-wrap text-fg">
        {str(input.message)}
      </p>
      {text != null && <p className={cn('text-footnote', failed ? 'text-danger-text' : 'text-fg-muted')}>{sent ? sent.status : text}</p>}
    </div>
  );
}

const MESSAGE_FROM = { session: 'another session', parent: 'its parent session', 'sub-agent': 'a sub-agent' } as const;

/**
 * Where a message from another agent reached this session's model: "Received a message from another session", opening
 * to where it came from (title and id, a link to that session or the sub-agent's transcript) and the message.
 */
export function MessageNotice({ notice }: { notice: Extract<Notice, { kind: 'message' }> }) {
  const [open, setOpen] = useState(useStartsOpen(false));
  const tasks = useContext(SessionTasks);
  const { from } = notice;
  const task = from.taskId ? tasks?.tasks.find((t) => t.id === from.taskId) : undefined;
  const title = from.title || 'Untitled';
  return (
    <div {...LINE} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-6 max-w-full items-center gap-1.5 self-start rounded-xs text-footnote text-fg-muted outline-none focus-ring hover:text-fg-secondary"
      >
        <Icon icon={MessageSquare} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">Received a message from {MESSAGE_FROM[from.relation]}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="mt-1 ml-5 flex flex-col gap-1.5 rounded-xl p-3 inset-ring inset-ring-line">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-footnote text-fg-muted">
            <span>From</span>
            <span className="text-fg-secondary">{title}</span>
            <span className="font-mono break-all">{from.taskId ?? from.sessionId}</span>
            {from.relation === 'sub-agent' ? (
              task &&
              tasks?.open && (
                <button type="button" onClick={() => tasks.open!(task.id)} className="rounded-xs text-interactive-text outline-none focus-ring hover:underline">
                  View transcript
                </button>
              )
            ) : (
              <a href={`#${SESSION_ROUTE[from.mode].replace('$sessionId', from.sessionId)}`} className="rounded-xs text-interactive-text outline-none focus-ring hover:underline">
                Open session
              </a>
            )}
          </div>
          <p data-selectable className="text-body break-words whitespace-pre-wrap text-fg">
            {notice.text}
          </p>
        </div>
      )}
    </div>
  );
}

/** A sub-agent's turn as it goes: its text, and its tool calls as `activity` shows them (a card each by default). */
export function SubagentTranscript({ sessionId, activity: Activity = CodeActivity }: { sessionId: string; activity?: ComponentType<{ steps: ActivityStepView[] }> }) {
  const live = useLiveSession(sessionId);
  const results = toolResults(live.messages);
  const run = {
    busy: live.session?.status === 'running' || live.session?.status === 'waiting',
    streamingMessageId: live.streamingMessageId,
    toolOutput: live.toolOutput,
  };
  // Its calls are in its own session.
  return (
    <TranscriptSession.Provider value={sessionId}>
      {turnItems(live.messages).map((item) => {
    switch (item.kind) {
      case 'text':
        return <Markdown key={item.ref.key} text={item.ref.part.text} streaming={isStreaming(item.ref, live.streamingMessageId)} />;
      case 'thinking':
        return <ThinkingBlock key={item.ref.key} text={item.ref.part.text} active={isStreaming(item.ref, live.streamingMessageId)} />;
      case 'activity':
        return <Activity key={item.key} steps={item.steps.map((ref) => stepView(ref, results, run))} />;
      case 'error':
        return <MessageError key={`${item.message.id}:error`} error={item.message.error!} />;
      case 'refusal':
        return <ProviderStopped key={`${item.message.id}:refusal`} />;
      default:
        return null;
    }
      })}
    </TranscriptSession.Provider>
  );
}
