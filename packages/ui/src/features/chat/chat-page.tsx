import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionMode } from '@atelier/protocol';
import { useUnifiedChat } from '../../lib/unified-chat.ts';
import { keys, useWorkspaces } from '../../lib/queries.ts';
import { FolderBadge } from '../code/workspace-picker.tsx';
import { CHAT_MODES, chatMode, PermissionModePicker, useEffectiveMode } from '../code/permission-mode.tsx';
import { OutputFiles } from '../work/file-cards.tsx';
import { FilePreview } from '../work/file-preview.tsx';
import { latestRun, openAction, outputFiles, saveFile, type OutputFile } from '../work/output-files.ts';
import { TaskPanel } from '../work/work-page.tsx';
import { useNavigate, useParams } from '@tanstack/react-router';
import { isCoopMirror } from '@atelier/protocol';
import { Spinner, cn, toast } from '../../components/ui/index.ts';
import { draftKeys } from '../../lib/drafts.ts';
import { useLiveSession } from '../../lib/live-session.ts';
import { useMarkSeen } from '../../lib/mark-seen.ts';
import { useModels, useProviderType } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useUi } from '../../lib/ui-store.ts';
import { ArtifactPanel } from '../artifacts/artifact-panel.tsx';
import { InteractionCard } from '../code/interaction-card.tsx';
import { SelectionReply } from './selection-reply.tsx';
import { LiveStatus } from '../code/live-status.tsx';
import { UsageLimitWarning } from './usage-limit-warning.tsx';
import { Composer, FileDropZone, type ComposerHandle } from './composer.tsx';
import { ComposerImages, useImageReference } from './generated-images.tsx';
import { CoworkOffer } from './cowork-offer.tsx';
import { useSessionSend } from './outbox.tsx';
import { ModelPicker } from './model-picker.tsx';
import { PlanLimitWarning } from './plan-usage.tsx';
import { ContextButton } from '../code/context-popover.tsx';
import { ScrollToBottom, SessionHeader, clearCommand, modelCommand, useFollowScroll } from './session-view.tsx';
import { Transcript } from './transcript.tsx';
import { useSessionConnectors } from './connector-switches.ts';
import { useSessionImageModel } from './image-model.ts';
import { useSessionResearch } from './research.ts';
import { useAttachments } from './use-attachments.ts';
import { SideChatPanel, btwCommand, useSideChatPanel, useSideChats } from './side-chat.tsx';
import { TemporaryBar } from './temporary.tsx';
import { CoopContext, useCoop } from '../coop/coop.ts';
import { CoopBanner, CoopTyping, coopCommands, coopContextNote, coopReadOnly, useGuestModel } from '../coop/coop-notices.tsx';
import { CoopModelChip, useAnswerModels } from '../coop/coop-models.tsx';

export function ChatPage() {
  const { sessionId } = useParams({ from: '/chat/$sessionId' });
  const live = useLiveSession(sessionId);
  useMarkSeen(sessionId, live.session?.status);
  const navigate = useNavigate();
  const { data: models } = useModels();
  const [pickingModel, setPickingModel] = useState(false);
  const attachments = useAttachments(live.session?.temporary ? undefined : draftKeys.session(sessionId), isCoopMirror(sessionId) ? sessionId : undefined);
  const { ref: scroller, atBottom, followSmooth, onScroll } = useFollowScroll(live);
  const session = live.session;
  const connectors = useSessionConnectors(session);
  const research = useSessionResearch(session);
  const imageModel = useSessionImageModel(session);
  const model = models?.find((m) => m.ref === session?.model);
  const providerType = useProviderType(model?.providerId);
  // A connector's permission prompt or question keeps the run going.
  const streaming = session?.status === 'running' || session?.status === 'waiting';
  const artifact = useUi((s) => (s.artifact?.sessionId === sessionId ? s.artifact : null));
  const sideChats = useSideChats(sessionId);
  const sidePanel = useSideChatPanel(sessionId);
  const temporary = !!session?.temporary;
  const coop = useCoop(live);
  const guest = coop.shared && !coop.isHost;
  const guestModel = useGuestModel(coop);
  const answerModels = useAnswerModels(coop).flatMap((g) => g.models);
  // Chat and Cowork in one: a chat that works as a task shows its progress and its files, once there are some.
  const unified = useUnifiedChat() && !temporary;
  const qc = useQueryClient();
  const { data: workspaces } = useWorkspaces();
  const workspace = unified ? workspaces?.find((w) => w.id === session?.workspaceId) : undefined;
  const root = workspace?.root ?? null;
  const files = useMemo(() => (root ? outputFiles(live.messages, root) : []), [live.messages, root]);
  const latestFiles = useMemo(() => (root && !streaming ? outputFiles(latestRun(live.messages), root) : []), [live.messages, root, streaming]);
  const [preview, setPreview] = useState<OutputFile | null>(null);
  const [pickedMode, setPickedMode] = useState<PermissionMode | null>(null);
  const mode = useEffectiveMode(pickedMode ?? session?.permissionMode ?? null);
  const working = live.todos.length > 0 || live.tasks.some((t) => t.status === 'running') || files.length > 0;
  // Tools change files: previews and the folder's list follow each round of results.
  const toolRounds = live.messages.filter((m) => m.role === 'tool').length;
  useEffect(() => {
    if (workspace) void qc.invalidateQueries({ queryKey: keys.workspace(workspace.id) });
  }, [qc, workspace, toolRounds, streaming]);
  const openFile = (file: OutputFile) => {
    if (!workspace) return;
    if (openAction(file, workspace) === 'preview') {
      useUi.getState().closeArtifact();
      setPreview(file);
    } else void saveFile(workspace, file);
  };
  const setMode = (next: PermissionMode) => {
    setPickedMode(next);
    void rpc()
      .call('sessions.update', { id: sessionId, permissionMode: next })
      .catch((e: unknown) => toast.error(describeError(e).message))
      .finally(() => setPickedMode((m) => (m === next ? null : m)));
  };
  const panel = (className: string) =>
    unified && workspace && working && <TaskPanel className={className} sessionId={sessionId} messages={live.messages} todos={live.todos} tasks={live.tasks} running={streaming} files={files} workspace={workspace} onOpen={openFile} quietProgress />;

  const fail = (e: unknown) => toast.error(describeError(e).message);
  const update = (patch: { model?: string }) => void rpc().call('sessions.update', { id: sessionId, ...patch }).catch(fail);

  const composer = useRef<ComposerHandle>(null);
  const sending = useSessionSend({ sessionId, busy: streaming, outbox: live.outbox, attachments, composer, follow: followSmooth, coop });
  const imageReference = useImageReference(attachments, composer);

  if (live.status === 'error')
    return (
      <div className="flex flex-1 items-center justify-center text-body text-fg-muted" role="alert">
        {live.error}
      </div>
    );

  return (
    <CoopContext.Provider value={coop}>
    <div className="relative flex min-h-0 flex-1">
      {/* The chat column keeps the space left of the artifact panel, with 8px gaps around the panel. */}
      {/* Narrow screens: the panel covers the column instead. */}
      <div className={cn('flex min-w-0 flex-1 flex-col', artifact && !preview && 'mr-[calc(62%+16px)] max-md:invisible max-md:mr-0', preview && 'mr-[calc(50%+16px)] max-md:invisible max-md:mr-0')}>
        <FileDropZone onFiles={(files) => void attachments.add(files)}>
          {/* Leaving is all it takes: the page's subscription ends with `sessions.leave`, which deletes it. */}
          {temporary ? (
            <TemporaryBar onLeave={() => void navigate({ to: '/' })} />
          ) : (
            // A folder the person gave it shows; its own sandbox doesn't (it isn't one of theirs).
            <SessionHeader session={session}>{workspace && !workspace.scratch && <FolderBadge workspace={workspace} {...(session ? { session } : {})} />}</SessionHeader>
          )}
          {/* The conversation and its composer, and beside them (wide windows) a task's progress and files. */}
          <div className="@container flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <div
              ref={scroller}
              // The chat content sits 8px right of the header (centers at +4px); the composer below matches.
              className="h-full overflow-x-hidden overflow-y-auto pl-2 max-md:pl-0"
              onScroll={onScroll}
            >
              {live.status === 'loading' ? (
                <div className="flex h-full items-center justify-center text-fg-muted">
                  <Spinner label="Loading conversation" />
                </div>
              ) : (
                <ComposerImages.Provider value={imageReference}>
                  <Transcript
                    sessionId={sessionId}
                    live={live}
                    status={<LiveStatus sessionId={sessionId} withActivity />}
                    outbox={sending.actions}
                    footer={
                      unified
                        ? !live.pending && workspace && latestFiles.length > 0 && <OutputFiles files={latestFiles} workspace={workspace} onOpen={openFile} />
                        : temporary || guest
                          ? undefined
                          : <CoworkOffer sessionId={sessionId} messages={live.messages} running={streaming || live.outbox.length > 0} />
                    }
                  />
                </ComposerImages.Provider>
              )}
              {/* Narrow windows: the progress goes under the conversation instead of beside it. */}
              {!preview && panel('mx-auto max-w-[calc(var(--at-transcript-max)+48px)] px-6 pb-10 @4xl:hidden max-md:px-4')}
            </div>
            {!atBottom && <ScrollToBottom onClick={followSmooth} working={live.session?.status === 'running'} />}
            <SelectionReply container={scroller} onReply={(text) => {
                attachments.addQuote(text);
                composer.current?.focus();
              }} />
          </div>
          <div className="pr-6 pb-2 pl-8 max-md:px-4">
            <PlanLimitWarning provider={providerType} providerId={model?.providerId} busy={streaming} />
            <UsageLimitWarning warning={live.limitWarning} />
            <CoopBanner coop={coop} live={live} />
            <Composer
              ref={composer}
              variant="reply"
              draftKey={temporary ? undefined : draftKeys.session(sessionId)}
              temporary={temporary}
              connectors={guest ? undefined : connectors}
              research={guest ? undefined : research}
              imageModel={guest ? undefined : imageModel}
              autoFocus
              attachments={attachments}
              model={guest ? guestModel : model}
              anyModel={guest}
              readOnly={coopReadOnly(coop)}
              answerModels={answerModels}
              onTyping={coop.shared ? coop.typing : undefined}
              above={coop.shared ? <CoopTyping live={live} coop={coop} /> : undefined}
              streaming={streaming}
              commands={coopCommands(coop, [
                clearCommand(() =>
                  void (temporary ? navigate({ to: '/', search: { temporary: true } }) : session?.projectId ? navigate({ to: '/projects/$projectId', params: { projectId: session.projectId } }) : navigate({ to: '/' })),
                ),
                modelCommand(() => setPickingModel(true)),
                btwCommand((question) => {
                  useUi.getState().closeArtifact();
                  sidePanel.setOpen(true);
                  sideChats.start(question);
                }),
              ])}
              dock={live.pending && <InteractionCard key={live.pending.id} sessionId={sessionId} pending={live.pending} docked />}
              onSubmit={sending.send}
              onStop={sending.stop}
              footerCenter={temporary ? 'Deleted when you leave · AI can make mistakes.' : 'AI can make mistakes.'}
              footerStart={unified && !guest ? <PermissionModePicker value={chatMode(mode)} onChange={setMode} modes={CHAT_MODES} hint={false} /> : undefined}
              footerEnd={
                <>
                  <ContextButton sessionId={sessionId} busy={streaming} provider={providerType} providerId={model?.providerId} simple note={coopContextNote(coop, guestModel, live.context?.used)} />
                  {guest ? <CoopModelChip coop={coop} open={pickingModel} onOpenChange={setPickingModel} /> : <ModelPicker
                    open={pickingModel}
                    onOpenChange={setPickingModel}
                    model={model}
                    mode="chat"
                    effort={session?.effort ?? null}
                    onModelChange={(ref) => update({ model: ref })}
                    onEffortChange={(effort) => rpc().call('sessions.update', { id: sessionId, effort })}
                    inSession
                    sessionId={sessionId}
                    thinking={session?.thinking}
                  />}
                </>
              }
            />
          </div>
          </div>
          {!preview && live.status === 'ready' && panel('hidden w-[280px] shrink-0 overflow-y-auto border-l border-line-subtle px-4 pt-4 pb-6 @4xl:flex')}
          </div>
        </FileDropZone>
      </div>
      {artifact && !preview && <ArtifactPanel state={artifact} summary={live.artifacts[artifact.artifactId]} />}
      {preview && workspace && <FilePreview key={preview.path} workspace={workspace} file={preview} onClose={() => setPreview(null)} />}
      {sidePanel.open && !artifact && !preview && <SideChatPanel chats={sideChats} panel={sidePanel} />}
    </div>
    </CoopContext.Provider>
  );
}
