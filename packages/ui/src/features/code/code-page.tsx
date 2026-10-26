/**
 * A Code session (design/components.md › CodeView): the header with the folder and the pane toggles, the transcript
 * with a card per tool call and the question the run waits on at its end, the composer with the permission mode, and
 * the dock of panes beside them (Terminal, Diff, Browser, Files, Background tasks, Plan, Artifact, Side chat).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, Rows3 } from 'lucide-react';
import type { GitStatus, PermissionMode, TranscriptView, WorkspaceSummary } from '@atelier/protocol';
import { Icon, IconButton, Menu, MenuContent, MenuGroup, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, Spinner, cn, toast } from '../../components/ui/index.ts';
import { draftKeys } from '../../lib/drafts.ts';
import { useLiveSession } from '../../lib/live-session.ts';
import { useMarkSeen } from '../../lib/mark-seen.ts';
import { useNarrow } from '../../lib/narrow.ts';
import { useCodeSplit } from '../../app/split-nav.ts';
import { SplitPanes } from '../../lib/split-cell.tsx';
import { NEW_CELL, openIn } from '../../lib/split-view.ts';
import { FolderHome } from './code-home.tsx';
import { surface } from '../../lib/platform.ts';
import { keys, useGitStatus, useModels, usePrefs, useProviderType, useWorkspaces } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Composer, FileDropZone, type ComposerHandle } from '../chat/composer.tsx';
import { ModelPicker } from '../chat/model-picker.tsx';
import { PlanLimitWarning } from '../chat/plan-usage.tsx';
import { ScrollToBottom, SessionHeader, clearCommand, compactCommand, loopCommand, modelCommand, useFollowScroll } from '../chat/session-view.tsx';
import { SelectionReply } from '../chat/selection-reply.tsx';
import { TRANSCRIPT_VIEWS, TranscriptDetail } from '../chat/parts.tsx';
import { Transcript } from '../chat/transcript.tsx';
import { useSessionConnectors } from '../chat/connector-switches.ts';
import { useSessionSend } from '../chat/outbox.tsx';
import { useAttachments } from '../chat/use-attachments.ts';
import { ArtifactPaneContext } from '../chat/artifact-card.tsx';
import { ArtifactPane, INITIAL_ARTIFACT_PANE, shownArtifact, useShownArtifacts, type ArtifactPaneState } from './artifact-pane.tsx';
import { BrowserPages, BrowserPane } from './browser-pane.tsx';
import { DiffPane } from './diff-review.tsx';
import { FilesPane, type OpenFiles } from './file-tree.tsx';
import { InteractionCard } from './interaction-card.tsx';
import { NeedsInput } from './needs-input.tsx';
import { useKeepAwake } from './keep-awake.tsx';
import { PaneButtons } from './pane-buttons.tsx';
import { DockSplitter, PaneDock, dockWidth, useDockRoom, type PaneFrameState } from './pane-dock.tsx';
import { PANES, fitColumns, isOpen, layoutReducer, loadLayout, openPanes, saveLayout, shownAction, type PaneId } from './pane-layout.ts';
import { displayPath } from './paths.ts';
import { PermissionModePicker, nextMode, switchesMode, useEffectiveMode } from './permission-mode.tsx';
import { PlanPane } from './plan-pane.tsx';
import { SideChatPane } from './side-chat-pane.tsx';
import { btwCommand, useSideChats } from '../chat/side-chat.tsx';
import { RewindDialog, checkpointsKey, rewindCommand, rewindPoints, useCheckpoints } from './rewind.tsx';
import { RunningTasksChip, TasksPane, runningTasks } from './tasks-pane.tsx';
import { TerminalCommands, TerminalFolders, TerminalPane } from './terminal-pane.tsx';
import { RunInTerminal } from '../chat/run-in-terminal.ts';
import { TodoWidget } from './todo-widget.tsx';
import { FolderBadge } from './workspace-picker.tsx';
import { CodeActivity, OpenWorkspaceFile, SessionTasks, WorkspaceRoot } from './tool-cards.tsx';
import { canServePages, pageUrl } from './workspace-pages.ts';
import { ContextButton } from './context-popover.tsx';
import { formatTokenCount } from './live-context.ts';
import { LiveStatus } from './live-status.tsx';

/** A web browser can't frame arbitrary sites: the Browser pane is the desktop app's. */
const AVAILABLE: readonly PaneId[] = surface === 'desktop' ? PANES : PANES.filter((p) => p !== 'browser');
/** Panes with their own toggle in the header; the others open from More. */
const TOGGLED = new Set<PaneId>(['terminal', 'diff', 'browser', 'files']);

export function CodePage() {
  const { sessionId } = useParams({ from: '/code/$sessionId' });
  const narrow = useNarrow();
  const { cells, active, isSplit, show, close, activate } = useCodeSplit();
  // A narrow window shows the cell you work in, alone.
  const shown = isSplit && narrow ? active! : isSplit ? null : sessionId;
  // A new session's place with nothing beside it is just the Code home.
  if (shown === NEW_CELL) return isSplit ? <NewSessionCell /> : <Navigate to="/code" replace />;
  // Each session starts with its own panes, terminals and picks.
  if (shown) return <CodeSession key={shown} sessionId={shown} />;
  // Sessions side by side, each its own page in its own cell; the active one is the one picked sessions replace.
  return (
    <SplitPanes
      cells={cells.map((id) => ({ id, node: id === NEW_CELL ? <NewSessionCell /> : <CodeSession key={id} sessionId={id} /> }))}
      active={active!}
      onActivate={activate}
      onClose={close}
      onOpenSession={(from, id) => show(openIn(cells, from, id))}
    />
  );
}

/** A new session set up in a split view cell: without the stats card, the first message makes it the cell's session. */
function NewSessionCell() {
  return (
    <>
      <SessionHeader session={null}>
        <span className="px-2 text-body text-fg-secondary">New session</span>
      </SessionHeader>
      <FolderHome mode="code" />
    </>
  );
}

function CodeSession({ sessionId }: { sessionId: string }) {
  const live = useLiveSession(sessionId);
  useMarkSeen(sessionId, live.session?.status);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const composer = useRef<ComposerHandle>(null);
  const { data: models } = useModels();
  const { data: workspaces } = useWorkspaces();
  const attachments = useAttachments(draftKeys.session(sessionId));
  const { ref: scroller, atBottom, followSmooth, onScroll } = useFollowScroll(live);
  // This session's own pick; until then, the person's default (Settings › Code).
  const { prefs } = usePrefs();
  const [pickedView, setView] = useState<TranscriptView | null>(null);
  const view = pickedView ?? prefs?.code.transcriptView ?? 'normal';
  const [pickingModel, setPickingModel] = useState(false);
  // Rewind's dialog, with the message it opened on ("Rewind to here"), or the newest (/rewind).
  const [rewind, setRewind] = useState<{ open: boolean; messageId: string | null }>({ open: false, messageId: null });
  const { data: checkpoints } = useCheckpoints(sessionId);
  const points = useMemo(() => rewindPoints(live.messages, checkpoints ?? []), [live.messages, checkpoints]);
  const rewindable = useMemo(() => new Set(points.map((p) => p.message.id)), [points]);
  const rewindTo = useCallback((messageId: string) => setRewind({ open: true, messageId }), []);
  const session = live.session;
  const connectors = useSessionConnectors(session);
  const workspace = workspaces?.find((w) => w.id === session?.workspaceId);
  const workspaceId = workspace?.available ? workspace.id : null;
  const { data: git } = useGitStatus(workspaceId);
  const model = models?.find((m) => m.ref === session?.model);
  const providerType = useProviderType(model?.providerId);
  const busy = session?.status === 'running' || session?.status === 'waiting';
  // The mode just picked, until the backend confirms it (so quick Shift+Tabs keep cycling).
  const [pickedMode, setPickedMode] = useState<PermissionMode | null>(null);
  const mode = useEffectiveMode(pickedMode ?? session?.permissionMode ?? null);
  const keepAwake = useKeepAwake();

  // The panes: as this device left them for this session, tiled into what the window has room for.
  const body = useRef<HTMLDivElement>(null);
  const dockEl = useRef<HTMLDivElement>(null);
  const [stored, dispatch] = useReducer(layoutReducer, sessionId, (id) => loadLayout(id, AVAILABLE));
  useEffect(() => saveLayout(sessionId, stored), [sessionId, stored]);
  const room = useDockRoom(body);
  // Too narrow for a dock beside the transcript: panes open as a sheet over it, one at a time.
  const sheet = useNarrow() || room === 0;
  const layout = useMemo(() => fitColumns(stored, sheet ? 1 : room), [stored, sheet, room]);
  const open = useMemo(() => new Set(openPanes(stored)), [stored]);
  const [files, setFiles] = useState<OpenFiles>({ paths: [], active: null });
  // The task open in Background tasks (null: the list).
  const [shownTask, setShownTask] = useState<string | null>(null);
  const buttons = useRef(new Map<PaneId | 'more', HTMLButtonElement>());
  const buttonRef = (key: PaneId | 'more') => (el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(key, el);
    else buttons.current.delete(key);
  };
  const openPane = useCallback((pane: PaneId) => dispatch({ type: 'open', pane, maxColumns: Math.max(1, room) }), [room]);
  /** Closes a pane; when its own close button had focus, focus goes to its toggle (or More), else the composer. */
  const closePane = (pane: PaneId) => {
    dispatch({ type: 'close', pane });
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const toggle = buttons.current.get(TOGGLED.has(pane) ? pane : 'more');
      if (toggle) toggle.focus();
      else composer.current?.focus();
    });
  };
  const togglePane = (pane: PaneId) => {
    // An open pane hidden behind another (maximized, or not the sheet's) comes to the front instead of closing.
    const shown = isOpen(stored, pane) && (sheet ? layout.active === pane : !layout.maximized || layout.maximized === pane);
    if (shown) dispatch({ type: 'close', pane });
    else openPane(pane);
  };
  // A code block's Run button: the command waits in a queue the Terminal pane's shell takes from, opening the pane.
  const terminalCommands = useMemo(() => new TerminalCommands(), []);
  const runInTerminal = useCallback(
    (command: string) => {
      terminalCommands.push(command);
      openPane('terminal');
    },
    [terminalCommands, openPane],
  );
  // Files › Open in terminal: the folder waits for the Terminal pane, which starts a shell there.
  const terminalFolders = useMemo(() => new TerminalFolders(), []);
  const openTerminal = (dir: string) => {
    terminalFolders.push(dir);
    openPane('terminal');
  };
  // Files › Attach as context: an `@` mention, as the composer's own file mentions; the model reads it with its tools.
  const attachToMessage = (path: string, kind: 'file' | 'dir') => composer.current?.mention(kind === 'dir' ? `${path}/` : path);
  const sessionTasks = useMemo(
    () => ({
      tasks: live.tasks,
      open: (taskId?: string) => {
        setShownTask(taskId ?? null);
        openPane('tasks');
      },
    }),
    [live.tasks, openPane],
  );
  const running = runningTasks(live.tasks);
  const sideChats = useSideChats(sessionId);
  // A plan waiting for approval is read in the Plan pane: it opens once for each plan, and stays closed if closed.
  const planPending = live.pending?.kind === 'permission' && (live.pending.payload as { toolName?: string }).toolName === 'ExitPlanMode' ? live.pending.id : null;
  const planOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (planPending && planOpenedFor.current !== planPending) {
      planOpenedFor.current = planPending;
      openPane('plan');
    }
  }, [planPending, openPane]);
  // The Artifact pane opens (or comes forward) whenever the session shows an artifact.
  const [artifactPane, setArtifactPane] = useState<ArtifactPaneState>(INITIAL_ARTIFACT_PANE);
  const showArtifact = useCallback(
    (artifactId: string) => {
      setArtifactPane((s) => ({ ...s, artifactId, version: null }));
      openPane('artifact');
    },
    [openPane],
  );
  useShownArtifacts(live.artifacts, live.status === 'ready', (artifact) => showArtifact(artifact.id));
  const artifactVisible = isOpen(stored, 'artifact') && (sheet ? layout.active === 'artifact' : !layout.maximized || layout.maximized === 'artifact');
  const artifactShown = artifactVisible ? (shownArtifact(live.artifacts, artifactPane.artifactId)?.id ?? null) : null;
  const artifactCards = {
    shown: artifactShown,
    toggle: (artifactId: string) => (artifactShown === artifactId ? closePane('artifact') : showArtifact(artifactId)),
  };
  // Files › Open in Browser pane: the file's address waits for the pane, which opens it.
  const browserPages = useMemo(() => new BrowserPages(), []);
  const openInBrowser =
    workspaceId && AVAILABLE.includes('browser') && canServePages()
      ? (path: string) =>
          void pageUrl(workspaceId, path)
            .then((url) => {
              browserPages.push(url);
              openPane('browser');
            })
            .catch((e: unknown) => toast.error(describeError(e).message))
      : undefined;
  const openFile = useCallback(
    (path: string) => {
      const relative = displayPath(path, workspace?.root ?? null);
      setFiles((f) => ({ paths: f.paths.includes(relative) ? f.paths : [...f.paths, relative], active: relative }));
      openPane('files');
    },
    [workspace?.root, openPane],
  );

  // Tools change files: after each round of results, when a background command or sub-agent ends and when a reply ends,
  // refresh what the header, the panes and Rewind show.
  const toolRounds = live.messages.filter((m) => m.role === 'tool').length;
  const tasksEnded = live.tasks.filter((t) => t.endedAt !== null).length;
  const replying = session?.status === 'running';
  useEffect(() => {
    if (workspaceId) void qc.invalidateQueries({ queryKey: keys.workspace(workspaceId) });
    void qc.invalidateQueries({ queryKey: checkpointsKey(sessionId) });
  }, [qc, workspaceId, sessionId, toolRounds, tasksEnded, replying]);

  const fail = (e: unknown) => toast.error(describeError(e).message);
  const update = (patch: { model?: string }) =>
    void rpc().call('sessions.update', { id: sessionId, ...patch }).catch(fail);
  const setMode = (permissionMode: PermissionMode) => {
    setPickedMode(permissionMode);
    void rpc()
      .call('sessions.update', { id: sessionId, permissionMode })
      .catch(fail)
      .finally(() => setPickedMode((m) => (m === permissionMode ? null : m)));
  };

  const sending = useSessionSend({ sessionId, busy, outbox: live.outbox, attachments, composer, follow: followSmooth });

  const renderPane = (frame: PaneFrameState) => {
    switch (frame.pane) {
      case 'terminal':
        return <TerminalPane frame={frame} workspace={workspace} commands={terminalCommands} folders={terminalFolders} />;
      case 'diff':
        return <DiffPane frame={frame} workspace={workspace} sessionId={sessionId} />;
      case 'browser':
        return <BrowserPane frame={frame} pages={browserPages} />;
      case 'files':
        return (
          <FilesPane
            frame={frame}
            workspace={workspace}
            files={files}
            onFiles={setFiles}
            onOpenInBrowser={openInBrowser}
            onAttach={attachToMessage}
            onOpenTerminal={openTerminal}
          />
        );
      case 'tasks':
        return <TasksPane frame={frame} sessionId={sessionId} tasks={live.tasks} shown={shownTask} onShow={setShownTask} />;
      case 'plan':
        return <PlanPane frame={frame} sessionId={sessionId} messages={live.messages} todos={live.todos} running={busy} />;
      case 'artifact':
        return <ArtifactPane frame={frame} artifacts={live.artifacts} state={artifactPane} onState={(patch) => setArtifactPane((s) => ({ ...s, ...patch }))} />;
      case 'side':
        return <SideChatPane frame={frame} chats={sideChats} />;
    }
  };

  if (live.status === 'error')
    return (
      <div className="flex flex-1 items-center justify-center text-body text-fg-muted" role="alert">
        {live.error}
      </div>
    );

  const docked = layout.columns.length > 0;
  // A pane in fullscreen takes the whole session (the transcript stays mounted, out of sight), never more than that.
  const fullscreen = docked && !sheet && layout.maximized !== null;
  return (
    <WorkspaceRoot.Provider value={workspace?.root ?? null}>
      <OpenWorkspaceFile.Provider value={workspaceId ? openFile : null}>
        <SessionTasks.Provider value={sessionTasks}>
          <ArtifactPaneContext.Provider value={artifactCards}>
            <RunInTerminal.Provider value={workspace?.available ? runInTerminal : null}>
            <div className="flex min-h-0 flex-1 flex-col">
              <SessionHeader session={session}>
                {workspace && <WorkspaceInfo workspace={workspace} git={git} onShowChanges={() => openPane('diff')} />}
                <Menu>
                  <MenuTrigger render={<IconButton icon={Rows3} label={`Transcript view: ${TRANSCRIPT_VIEWS.find((v) => v.value === view)!.label}`} size="sm" className="app-no-drag ml-auto text-fg-secondary" />} />
                  <MenuContent className="w-56">
                    <MenuGroup>
                      <MenuLabel>Transcript view</MenuLabel>
                      <MenuRadioGroup value={view} onValueChange={(v: TranscriptView) => setView(v)}>
                        {TRANSCRIPT_VIEWS.map((v) => (
                          <MenuRadioItem key={v.value} value={v.value} closeOnClick>
                            {v.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuContent>
                </Menu>
                <PaneButtons
                  open={open}
                  available={AVAILABLE}
                  onToggle={togglePane}
                  onOpen={(pane) => (pane === 'tasks' ? sessionTasks.open() : openPane(pane))}
                  runningTasks={running}
                  keepAwake={surface === 'desktop' ? { on: keepAwake.sessions.includes(sessionId), set: (on) => keepAwake.set(sessionId, on) } : null}
                  buttonRef={buttonRef}
                />
              </SessionHeader>
              <div ref={body} className="relative flex min-h-0 flex-1">
                <div id={`code-transcript-${sessionId}`} inert={fullscreen} className={cn('flex flex-col', fullscreen ? 'w-0 flex-none overflow-hidden' : 'min-w-0 flex-1')}>
                  <FileDropZone onFiles={(dropped) => void attachments.add(dropped)}>
                    <div className="relative min-h-0 flex-1">
                      <div ref={scroller} className="h-full overflow-x-hidden overflow-y-auto pl-2 max-md:pl-0" onScroll={onScroll}>
                        {live.status === 'loading' ? (
                          <div className="flex h-full items-center justify-center text-fg-muted">
                            <Spinner label="Loading session" />
                          </div>
                        ) : (
                          // Cards decide whether they start open when they mount, so a new view mounts the transcript afresh.
                          <TranscriptDetail.Provider key={view} value={view}>
                            <Transcript
                              sessionId={sessionId}
                              live={live}
                              activity={CodeActivity}
                              rewind={{ messageIds: rewindable, onRewind: rewindTo }}
                              status={<LiveStatus sessionId={sessionId} />}
                              outbox={sending.actions}
                              footer={
                                (live.pending || running > 0) && (
                                  <>
                                    {live.pending && <NeedsInput />}
                                    {running > 0 && <RunningTasksChip count={running} onOpen={() => sessionTasks.open()} />}
                                  </>
                                )
                              }
                            />
                          </TranscriptDetail.Provider>
                        )}
                      </div>
                      {!atBottom && <ScrollToBottom onClick={followSmooth} working={live.session?.status === 'running'} />}
                      <SelectionReply container={scroller} onReply={(text) => {
                attachments.addQuote(text);
                composer.current?.focus();
              }} />
                    </div>
                    <div className="pr-6 pb-5 pl-8 max-md:px-4">
                      <TodoWidget todos={live.todos} running={busy} />
                      <PlanLimitWarning provider={providerType} busy={busy} />
                      <Composer
                        ref={composer}
                        variant="reply"
                        suggestion={live.suggestion}
                        draftKey={draftKeys.session(sessionId)}
                        compact
                        connectors={connectors}
                        autoFocus
                        attachments={attachments}
                        model={model}
                        streaming={busy}
                        placeholder="Type / for commands"
                        workspaceId={workspaceId}
                        commands={[
                          compactCommand(sessionId),
                          loopCommand(sessionId, () => sessionTasks.open()),
                          clearCommand(() => void navigate({ to: '/code', search: workspace ? { workspace: workspace.id } : {} })),
                          modelCommand(() => setPickingModel(true)),
                          rewindCommand(() => setRewind({ open: true, messageId: null })),
                          btwCommand((question) => {
                            openPane('side');
                            sideChats.start(question);
                          }),
                        ]}
                        dock={live.pending && <InteractionCard key={live.pending.id} sessionId={sessionId} pending={live.pending} docked onOpenPlan={() => openPane('plan')} />}
                        onSubmit={sending.send}
                        onStop={sending.stop}
                        onKeyDown={(e) => switchesMode(e) && setMode(nextMode(mode))}
                        footerStart={<PermissionModePicker value={mode} onChange={setMode} />}
                        footerCenter={smallWindow(live.context?.limit ?? model?.contextLength)}
                        footerEnd={
                          <>
                            <ModelPicker
                              open={pickingModel}
                              onOpenChange={setPickingModel}
                              model={model}
                              mode="code"
                              effort={session?.effort ?? null}
                              onModelChange={(ref) => update({ model: ref })}
                              onEffortChange={(effort) => rpc().call('sessions.update', { id: sessionId, effort })}
                              inSession
                              sessionId={sessionId}
                              thinking={session?.thinking}
                            />
                            <ContextButton sessionId={sessionId} busy={busy} provider={providerType} />
                          </>
                        }
                      />
                    </div>
                  </FileDropZone>
                </div>
                {docked && !sheet && !fullscreen && (
                  <DockSplitter
                    sessionId={sessionId}
                    layout={layout}
                    columns={layout.columns.length}
                    body={body}
                    onPreview={(dock) => {
                      if (dockEl.current) dockEl.current.style.width = dockWidth({ ...layout, dock });
                    }}
                    dispatch={dispatch}
                  />
                )}
                {docked && (
                  <div
                    ref={dockEl}
                    className={
                      // Too narrow for a dock: the pane takes the whole body of this session (its half, in a split view), edge to edge.
                      sheet
                        ? 'absolute inset-0 z-10'
                        : fullscreen
                          ? 'min-w-0 flex-1 pr-2 pb-2 pl-2'
                          : 'shrink-0 pr-2 pb-2'
                    }
                    style={sheet || fullscreen ? undefined : { width: dockWidth(layout) }}
                  >
                    <PaneDock layout={layout} sheet={sheet} dispatch={(action) => dispatch(shownAction(stored, layout, action))} onClose={closePane} renderPane={renderPane} />
                  </div>
                )}
              </div>
              <RewindDialog
                sessionId={sessionId}
                points={points}
                initial={rewind.messageId}
                root={workspace?.root ?? null}
                open={rewind.open}
                onOpenChange={(open) => setRewind((r) => ({ ...r, open }))}
                onConversationRewound={(text) => composer.current?.setText(text)}
              />
            </div>
            </RunInTerminal.Provider>
          </ArtifactPaneContext.Provider>
        </SessionTasks.Provider>
      </OpenWorkspaceFile.Provider>
    </WorkspaceRoot.Provider>
  );
}

/** design/components.md › WorkspaceHeader: the folder, whether its machine is online, the branch and what changed. */
function WorkspaceInfo({ workspace, git, onShowChanges }: { workspace: WorkspaceSummary; git: GitStatus | undefined; onShowChanges(): void }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-footnote text-fg-muted">
      <FolderBadge workspace={workspace} />
      {git?.branch && (
        <span className="flex min-w-0 items-center gap-1 font-mono text-code">
          <Icon icon={GitBranch} className="size-3.5" />
          <span className="truncate">{git.branch}</span>
        </span>
      )}
      {!!git?.files.length && (
        <button type="button" onClick={onShowChanges} className="app-no-drag shrink-0 rounded-xs outline-none focus-ring hover:text-fg">
          {git.files.length} changed
        </button>
      )}
    </div>
  );
}

/** Below this many tokens a Code session compacts again and again: say so under the message box. */
export const SMALL_WINDOW_TOKENS = 16_000;

/** The note for a context window too small for Code's long tasks, or nothing. */
export function smallWindow(tokens: number | undefined): string | undefined {
  if (!tokens || tokens >= SMALL_WINDOW_TOKENS) return undefined;
  return `This model's ${formatTokenCount(tokens)} window is small for Code: long tasks compact often. Raise it in Settings › Admin › Models.`;
}
