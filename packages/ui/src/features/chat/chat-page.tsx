import { useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Spinner, cn, toast } from '../../components/ui/index.ts';
import { draftKeys } from '../../lib/drafts.ts';
import { useLiveSession } from '../../lib/live-session.ts';
import { useMarkSeen } from '../../lib/mark-seen.ts';
import { useModels } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useUi } from '../../lib/ui-store.ts';
import { ArtifactPanel } from '../artifacts/artifact-panel.tsx';
import { InteractionCard } from '../code/interaction-card.tsx';
import { SelectionReply } from './selection-reply.tsx';
import { LiveStatus } from '../code/live-status.tsx';
import { Composer, FileDropZone, type ComposerHandle } from './composer.tsx';
import { CoworkOffer } from './cowork-offer.tsx';
import { useSessionSend } from './outbox.tsx';
import { ModelPicker } from './model-picker.tsx';
import { ContextMeter, ScrollToBottom, SessionHeader, clearCommand, modelCommand, useFollowScroll } from './session-view.tsx';
import { Transcript } from './transcript.tsx';
import { useSessionConnectors } from './connector-switches.ts';
import { useSessionResearch } from './research.ts';
import { useAttachments } from './use-attachments.ts';
import { SideChatPanel, btwCommand, useSideChatPanel, useSideChats } from './side-chat.tsx';
import { TemporaryBar } from './temporary.tsx';

export function ChatPage() {
  const { sessionId } = useParams({ from: '/chat/$sessionId' });
  const live = useLiveSession(sessionId);
  useMarkSeen(sessionId, live.session?.status);
  const navigate = useNavigate();
  const { data: models } = useModels();
  const [pickingModel, setPickingModel] = useState(false);
  const attachments = useAttachments(live.session?.temporary ? undefined : draftKeys.session(sessionId));
  const { ref: scroller, atBottom, followSmooth, onScroll } = useFollowScroll(live.messages);
  const session = live.session;
  const connectors = useSessionConnectors(session);
  const research = useSessionResearch(session);
  const model = models?.find((m) => m.ref === session?.model);
  // A connector's permission prompt or question keeps the run going.
  const streaming = session?.status === 'running' || session?.status === 'waiting';
  const artifact = useUi((s) => (s.artifact?.sessionId === sessionId ? s.artifact : null));
  const sideChats = useSideChats(sessionId);
  const sidePanel = useSideChatPanel(sessionId);
  const temporary = !!session?.temporary;

  const fail = (e: unknown) => toast.error(describeError(e).message);
  const update = (patch: { model?: string }) => void rpc().call('sessions.update', { id: sessionId, ...patch }).catch(fail);

  const composer = useRef<ComposerHandle>(null);
  const sending = useSessionSend({ sessionId, busy: streaming, outbox: live.outbox, attachments, composer, follow: followSmooth });

  if (live.status === 'error')
    return (
      <div className="flex flex-1 items-center justify-center text-body text-fg-muted" role="alert">
        {live.error}
      </div>
    );

  return (
    <div className="relative flex min-h-0 flex-1">
      {/* The chat column keeps the space left of the artifact panel, with 8px gaps around the panel. */}
      {/* Narrow screens: the panel covers the column instead. */}
      <div className={cn('flex min-w-0 flex-1 flex-col', artifact && 'mr-[calc(62%+16px)] max-md:invisible max-md:mr-0')}>
        <FileDropZone onFiles={(files) => void attachments.add(files)}>
          {/* Leaving is all it takes: the page's subscription ends with `sessions.leave`, which deletes it. */}
          {temporary ? <TemporaryBar onLeave={() => void navigate({ to: '/' })} /> : <SessionHeader session={session} />}
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
                <Transcript
                  sessionId={sessionId}
                  live={live}
                  status={<LiveStatus sessionId={sessionId} withActivity />}
                  outbox={sending.actions}
                  footer={temporary ? undefined : <CoworkOffer sessionId={sessionId} messages={live.messages} running={streaming || live.outbox.length > 0} />}
                />
              )}
            </div>
            {!atBottom && <ScrollToBottom onClick={followSmooth} working={live.session?.status === 'running'} />}
            <SelectionReply container={scroller} onReply={(text) => {
                attachments.addQuote(text);
                composer.current?.focus();
              }} />
          </div>
          <div className="pr-6 pb-2 pl-8 max-md:px-4">
            <Composer
              ref={composer}
              variant="reply"
              draftKey={temporary ? undefined : draftKeys.session(sessionId)}
              temporary={temporary}
              connectors={connectors}
              research={research}
              autoFocus
              attachments={attachments}
              model={model}
              streaming={streaming}
              commands={[
                clearCommand(() =>
                  void (temporary ? navigate({ to: '/', search: { temporary: true } }) : session?.projectId ? navigate({ to: '/projects/$projectId', params: { projectId: session.projectId } }) : navigate({ to: '/' })),
                ),
                modelCommand(() => setPickingModel(true)),
                btwCommand((question) => {
                  useUi.getState().closeArtifact();
                  sidePanel.setOpen(true);
                  sideChats.start(question);
                }),
              ]}
              dock={live.pending && <InteractionCard key={live.pending.id} sessionId={sessionId} pending={live.pending} docked />}
              onSubmit={sending.send}
              onStop={sending.stop}
              footerCenter={temporary ? 'Deleted when you leave · AI can make mistakes.' : 'AI can make mistakes.'}
              footerEnd={
                <>
                  {live.context && <ContextMeter used={live.context.used} limit={live.context.limit} />}
                  <ModelPicker
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
                  />
                </>
              }
            />
          </div>
        </FileDropZone>
      </div>
      {artifact && <ArtifactPanel state={artifact} summary={live.artifacts[artifact.artifactId]} />}
      {sidePanel.open && !artifact && <SideChatPanel chats={sideChats} panel={sidePanel} />}
    </div>
  );
}
