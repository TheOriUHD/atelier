/**
 * A Work task (design/components.md › WorkView): the transcript with each tool call on one line, the question the
 * run waits on at its end, and beside it (under it when the window is narrow) the task's progress, what runs in the
 * background (sub-agents, loops) and the files it produced. A finished task ends with its files as cards; a file opens
 * in a preview panel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BackgroundTask, Todo, WorkspaceSummary } from '@atelier/protocol';
import { Spinner, cn, toast } from '../../components/ui/index.ts';
import { draftKeys } from '../../lib/drafts.ts';
import { useLiveSession } from '../../lib/live-session.ts';
import { useMarkSeen } from '../../lib/mark-seen.ts';
import { keys, useModels, useProviderType, useWorkspaces } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Composer, FileDropZone, type ComposerHandle } from '../chat/composer.tsx';
import { ModelPicker } from '../chat/model-picker.tsx';
import { PlanLimitWarning, PlanUsageButton } from '../chat/plan-usage.tsx';
import { ContextMeter, ScrollToBottom, SessionHeader, clearCommand, loopCommand, modelCommand, useFollowScroll } from '../chat/session-view.tsx';
import { Transcript } from '../chat/transcript.tsx';
import type { ActivityStepView } from '../chat/turns.ts';
import { useSessionConnectors } from '../chat/connector-switches.ts';
import { useSessionSend } from '../chat/outbox.tsx';
import { useAttachments } from '../chat/use-attachments.ts';
import { InteractionCard } from '../code/interaction-card.tsx';
import { SelectionReply } from '../chat/selection-reply.tsx';
import { LiveStatus } from '../code/live-status.tsx';
import { TaskCard } from '../code/tasks-pane.tsx';
import { CodeActivity, SessionTasks, ToolCardsOpen, WorkspaceRoot } from '../code/tool-cards.tsx';
import { FolderBadge } from '../code/workspace-picker.tsx';
import { FileCard, OutputFiles } from './file-cards.tsx';
import { FilePreview } from './file-preview.tsx';
import { latestRun, openAction, outputFiles, saveFile, type OutputFile } from './output-files.ts';
import { TaskProgressList } from './task-progress.tsx';
import { SideChatPanel, btwCommand, useSideChatPanel, useSideChats } from '../chat/side-chat.tsx';

/** Code's tool cards, every one closed to its summary line. */
function WorkActivity({ steps, live }: { steps: ActivityStepView[]; live?: boolean }) {
  return (
    <ToolCardsOpen.Provider value={false}>
      <CodeActivity steps={steps} live={live} />
    </ToolCardsOpen.Provider>
  );
}

export function WorkPage() {
  const { sessionId } = useParams({ from: '/work/$sessionId' });
  const live = useLiveSession(sessionId);
  useMarkSeen(sessionId, live.session?.status);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: models } = useModels();
  const { data: workspaces } = useWorkspaces();
  const attachments = useAttachments(draftKeys.session(sessionId));
  const { ref: scroller, atBottom, followSmooth, onScroll } = useFollowScroll(live);
  const [pickingModel, setPickingModel] = useState(false);
  const [preview, setPreview] = useState<OutputFile | null>(null);
  const session = live.session;
  const connectors = useSessionConnectors(session);
  const workspace = workspaces?.find((w) => w.id === session?.workspaceId);
  const model = models?.find((m) => m.ref === session?.model);
  const providerType = useProviderType(model?.providerId);
  const busy = session?.status === 'running' || session?.status === 'waiting';
  const root = workspace?.root ?? null;
  const files = useMemo(() => (root ? outputFiles(live.messages, root) : []), [live.messages, root]);
  const latestFiles = useMemo(() => (root && !busy ? outputFiles(latestRun(live.messages), root) : []), [live.messages, root, busy]);
  // Cowork has no Background tasks pane: the cards in the transcript read the tasks, nothing opens them.
  const sessionTasks = useMemo(() => ({ tasks: live.tasks }), [live.tasks]);
  const sideChats = useSideChats(sessionId);
  const sidePanel = useSideChatPanel(sessionId);

  // Tools change files: after each round of results, previews show the new contents.
  const toolRounds = live.messages.filter((m) => m.role === 'tool').length;
  useEffect(() => {
    if (workspace) void qc.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
  }, [qc, workspace, toolRounds]);

  const fail = (e: unknown) => toast.error(describeError(e).message);
  const update = (patch: { model?: string }) =>
    void rpc().call('sessions.update', { id: sessionId, ...patch }).catch(fail);
  const open = (file: OutputFile) => {
    if (!workspace) return;
    if (openAction(file, workspace) === 'preview') setPreview(file);
    else void saveFile(workspace, file);
  };

  const composer = useRef<ComposerHandle>(null);
  const sending = useSessionSend({ sessionId, busy, outbox: live.outbox, attachments, composer, follow: followSmooth });

  if (live.status === 'error')
    return (
      <div className="flex flex-1 items-center justify-center text-body text-fg-muted" role="alert">
        {live.error}
      </div>
    );

  const panel = (className: string) =>
    workspace && (
      <TaskPanel
        className={className}
        sessionId={sessionId}
        todos={live.todos}
        tasks={live.tasks}
        running={busy}
        files={files}
        workspace={workspace}
        onOpen={open}
      />
    );

  return (
    <WorkspaceRoot.Provider value={root}>
      <SessionTasks.Provider value={sessionTasks}>
      <div className="@container relative flex min-h-0 flex-1">
        {/* Narrow screens: the preview covers the column instead. */}
        <div className={cn('flex min-w-0 flex-1 flex-col', preview && 'mr-[calc(50%+16px)] max-md:invisible max-md:mr-0')}>
          <FileDropZone onFiles={(files) => void attachments.add(files)}>
            <SessionHeader session={session}>{workspace && <FolderBadge workspace={workspace} />}</SessionHeader>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="relative min-h-0 flex-1">
                  <div ref={scroller} className="h-full overflow-x-hidden overflow-y-auto pl-2 max-md:pl-0" onScroll={onScroll}>
                    {live.status === 'loading' ? (
                      <div className="flex h-full items-center justify-center text-fg-muted">
                        <Spinner label="Loading task" />
                      </div>
                    ) : (
                      <>
                        <Transcript
                          sessionId={sessionId}
                          live={live}
                          activity={WorkActivity}
                          status={<LiveStatus sessionId={sessionId} withActivity />}
                          outbox={sending.actions}
                          footer={!live.pending && workspace && latestFiles.length > 0 && <OutputFiles files={latestFiles} workspace={workspace} onOpen={open} />}
                        />
                        {/* Narrow windows: the progress goes under the transcript instead of beside it. */}
                        {!preview && panel('mx-auto max-w-[calc(var(--at-transcript-max)+48px)] px-6 pb-10 @4xl:hidden max-md:px-4')}
                      </>
                    )}
                  </div>
                  {!atBottom && <ScrollToBottom onClick={followSmooth} working={live.session?.status === 'running'} />}
                  <SelectionReply container={scroller} onReply={(text) => {
                attachments.addQuote(text);
                composer.current?.focus();
              }} />
                </div>
                <div className="pr-6 pb-5 pl-8 max-md:px-4">
                  <PlanLimitWarning provider={providerType} busy={busy} />
                  <Composer
                    ref={composer}
                    variant="reply"
                    draftKey={draftKeys.session(sessionId)}
                    connectors={connectors}
                    autoFocus
                    attachments={attachments}
                    model={model}
                    streaming={busy}
                    workspaceId={workspace?.available ? workspace.id : null}
                    commands={[
                      loopCommand(sessionId, () => listLoops(live.tasks)),
                      clearCommand(() => void navigate({ to: '/work', search: workspace ? { workspace: workspace.id } : {} })),
                      modelCommand(() => setPickingModel(true)),
                      btwCommand((question) => {
                        setPreview(null);
                        sidePanel.setOpen(true);
                        sideChats.start(question);
                      }),
                    ]}
                    dock={live.pending && <InteractionCard key={live.pending.id} sessionId={sessionId} pending={live.pending} docked />}
                    onSubmit={sending.send}
                    onStop={sending.stop}
                    footerEnd={
                      <>
                        <PlanUsageButton provider={providerType} />
                        {live.context && <ContextMeter used={live.context.used} limit={live.context.limit} />}
                        <ModelPicker
                          open={pickingModel}
                          onOpenChange={setPickingModel}
                          model={model}
                          mode="work"
                          effort={session?.effort ?? null}
                          onModelChange={(ref) => update({ model: ref })}
                          onEffortChange={(effort) => rpc().call('sessions.update', { id: sessionId, effort })}
                          inSession
                          sessionId={sessionId}
                          thinking={session?.thinking}
                        />
                      </>
                    }
                  />
                </div>
              </div>
              {!preview && live.status === 'ready' && panel('hidden w-[280px] shrink-0 overflow-y-auto border-l border-line-subtle px-4 pt-4 pb-6 @4xl:flex')}
            </div>
          </FileDropZone>
        </div>
        {preview && workspace && <FilePreview key={preview.path} workspace={workspace} file={preview} onClose={() => setPreview(null)} />}
        {sidePanel.open && !preview && <SideChatPanel chats={sideChats} panel={sidePanel} />}
      </div>
      </SessionTasks.Provider>
    </WorkspaceRoot.Provider>
  );
}

/** `/loop` alone: the loops are listed under Background beside the task, so the toast only says how many run. */
function listLoops(tasks: BackgroundTask[]) {
  const loops = tasks.filter((t) => t.kind === 'loop' && t.status === 'running').length;
  if (!loops) toast('No loops are running in this task.', { description: 'Start one with /loop 5m and what to send.' });
  else toast(loops === 1 ? 'One loop is running.' : `${loops} loops are running.`, { description: 'They are listed under Background, with Stop.' });
}

/** Beside the transcript: the steps, what runs in the background, then every file the task created or changed. */
function TaskPanel({
  className,
  sessionId,
  todos,
  tasks,
  running,
  files,
  workspace,
  onOpen,
}: {
  className: string;
  sessionId: string;
  todos: Todo[];
  tasks: BackgroundTask[];
  running: boolean;
  files: OutputFile[];
  workspace: WorkspaceSummary;
  onOpen(file: OutputFile): void;
}) {
  const background = tasks.filter((t) => t.status === 'running');
  return (
    <aside aria-label="Task progress" className={cn('flex flex-col gap-6', className)}>
      <TaskProgressList todos={todos} running={running} />
      {background.length > 0 && (
        <section aria-label="Background" className="flex flex-col gap-1.5">
          <h2 className="flex h-5 items-center text-footnote text-fg-muted">Background</h2>
          <ul className="flex flex-col gap-2">
            {background.map((task) => (
              <TaskCard key={task.id} sessionId={sessionId} task={task} />
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Output files" className="flex flex-col gap-1.5">
        <h2 className="flex h-5 items-center text-footnote text-fg-muted">Output files</h2>
        {files.length > 0 ? (
          <div className="-mx-1.5 flex flex-col">
            {files.map((file) => (
              <FileCard key={file.path} file={file} workspace={workspace} compact onOpen={onOpen} />
            ))}
          </div>
        ) : (
          <p className="text-body text-fg-muted">Files the task creates or changes show here.</p>
        )}
      </section>
    </aside>
  );
}
