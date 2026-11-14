import { memo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, FileText, History, Pencil, Repeat, RotateCcw } from 'lucide-react';
import { messageText, unescapeTags, type ArtifactSummary, type ImageProgress, type Message, type ModelInfo, type Notice, type Part, type RunPhase, type SessionStatus } from '@atelier/protocol';
import { Badge, Button, Icon, IconButton, Menu, MenuContent, MenuGroup, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, ThinkingDots, cn, toast } from '../../components/ui/index.ts';
import { ITEM_GAPS, LINE, ROW_GAPS } from './rows.ts';
import { blobUrl } from '../../lib/platform.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { queuedLabel, resetFromSnapshot, turnStart, type LiveSessionState } from '../../lib/live-session.ts';
import { useModels } from '../../lib/queries.ts';
import { useLowestIndicatorOnly } from '../../lib/lowest-indicator.ts';
import { sessionNoun } from '../../lib/sessions.ts';
import { formatTokenCount } from '../code/live-context.ts';
import { CommandText } from './command-text.tsx';
import { QuoteBlock } from './quote.tsx';
import { Markdown } from './markdown.tsx';
import { MessageError, ProviderStopped, ThinkingBlock, ToolActivity } from './parts.tsx';
import { PhaseText, usePhaseText } from './run-phase.tsx';
import { ArtifactCard } from './artifact-card.tsx';
import { InlineVisual } from './inline-visual.tsx';
import { GeneratedImages } from './generated-images.tsx';
import { AreaPreview } from '../images/area-preview.tsx';
import { ChangeAreaProvider } from '../images/change-area.tsx';
import { SessionImagesProvider } from '../images/session-images.tsx';
import { GeneratedVideos } from './generated-videos.tsx';
import { GeneratedAudio } from './generated-audio.tsx';
import { ZoomableImage } from './images.tsx';
import { CopyButton } from './copy-button.tsx';
import { ReadAloudButton } from './read-aloud.tsx';
import { modelSubtitle, useModelGroups } from './models.ts';
import { MessageTime } from './message-time.tsx';
import { AgentNotice, MessageNotice, MovedNotice, StreamingInputs } from '../code/tool-cards.tsx';
import { AuthorLabel, Outbox, type OutboxActions } from './outbox.tsx';
import type { Reaction } from '../coop/coop-reactions.tsx';
import { reportError, turnOwner, useCoopView, type CoopView } from '../coop/coop.ts';
import { SecondOpinion, answerWithName } from '../coop/coop-models.tsx';
import { ReactButton, ReactionPills } from '../coop/coop-reactions.tsx';
import { groupTurns, isStreaming, stepView, toolResults, turnItems, type ActivityStepView, type PartRef } from './turns.ts';

/** How a run of tool calls (and the thinking between them) is shown: Chat summarizes it, Code shows a card per call. */
export type ActivityView = ComponentType<{ steps: ActivityStepView[]; live?: boolean; turnSince?: number }>;

/**
 * The conversation column. Layout per design/components.md › Transcript. `footer` ends the column (Code puts the
 * question the run waits on there). Code passes `rewind`: the person's messages it can go back to, and what opens Rewind;
 * and `status`, its live running line, in place of the thinking dots and the compacting note.
 */
export function Transcript({
  sessionId,
  live,
  activity = ToolActivity,
  footer,
  rewind,
  status,
  outbox,
}: {
  sessionId: string;
  live: LiveSessionState;
  activity?: ActivityView;
  footer?: ReactNode;
  rewind?: { messageIds: ReadonlySet<string>; onRewind(messageId: string): void };
  status?: ReactNode;
  /** What the waiting messages' buttons do (messages sent while the agent works). */
  outbox?: OutboxActions;
}) {
  const coop = useCoopView();
  const { data: models } = useModels();
  const turns = groupTurns(live.messages);
  const running = live.session?.status === 'running';
  const busy = running || live.session?.status === 'waiting';
  const last = turns.at(-1);
  // The running line counts the whole turn, from the person's message (or a retry's start) to the reply, not from the step it is in.
  const turnSince = busy ? turnStart(live) : undefined;
  // The person's message being edited; a reply's notice can open it too.
  const [editing, setEditing] = useState<string | null>(null);
  // Two running indicators on screen at once look cheap: only the lowest one is drawn.
  const column = useRef<HTMLDivElement>(null);
  useLowestIndicatorOnly(column);
  // Co-op: whom the running turn is for, and what the viewer may do with the conversation's history.
  const turnFor = coop.shared && busy ? turnOwner(live.messages, coop.hostId) : null;
  const may = coopMay(coop);

  return (
    <ChangeAreaProvider sessionId={sessionId}>
    <SessionImagesProvider messages={live.messages}>
    <div ref={column} className={cn('mx-auto flex w-full max-w-[calc(var(--at-transcript-max)+48px)] flex-col px-6 pt-9 pb-10 max-md:px-4', ROW_GAPS)}>
      {turns.map((turn, i) =>
        turn.kind === 'user' ? (
          <UserMessage
            key={turn.message.id}
            sessionId={sessionId}
            message={turn.message}
            siblings={may.branch ? live.siblings[turn.message.id] : undefined}
            disabled={busy}
            editing={editing === turn.message.id}
            onEditing={setEditing}
            onRewind={may.rewind && rewind?.messageIds.has(turn.message.id) ? rewind.onRewind : undefined}
            {...userMessageCoop(coop, turn.message, may)}
            reactions={coop.shared ? live.reactions?.[turn.message.id] : undefined}
            askedFor={coop.shared && turn.message.answerWith ? answerWithName(turn.message.answerWith, models, coop.state?.hostModels) : undefined}
          />
        ) : turn.kind === 'assistant' ? (
          <AssistantTurn
            key={turn.messages[0]!.id}
            asked={mayEditAsked(coop, may, turns[i - 1]) ? editable(turns[i - 1]) : undefined}
            onEditing={setEditing}
            sessionId={sessionId}
            messages={turn.messages}
            status={live.session?.status}
            streamingMessageId={live.streamingMessageId}
            artifacts={live.artifacts}
            // Only the last turn can still be streaming tool input or output; earlier turns keep stable props.
            toolInputs={turn === last ? live.toolInputs : NONE}
            toolOutput={turn === last ? live.toolOutput : NONE}
            toolProgress={turn === last ? live.toolProgress : undefined}
            siblings={may.branch ? live.siblings[turn.messages[0]!.id] : undefined}
            activity={activity}
            forName={assistantFor(coop, turn.messages, turns[i - 1])}
            retryable={may.retry}
            retryWith={may.retryWith}
            secondOpinion={coop.shared && may.retry}
            reactions={coop.shared ? live.reactions?.[replyId(turn.messages)] : undefined}
            last={turn === last}
            // The dots of an empty reply wait for the run to say more; when the line below says what it waits for, they would be a second one.
            placeholder={!status && live.queued === null && !live.compacting}
            phase={turn === last ? live.phase : null}
            turnSince={turn === last ? turnSince : undefined}
          />
        ) : (
          <CompactionDivider key={turn.message.id} message={turn.message} noun={sessionNoun(live.session ?? { mode: 'chat' })} />
        ),
      )}
      {status ??
        (live.queued !== null ? (
          <div {...LINE} className="flex items-center gap-2 text-body text-fg-muted">
            <ThinkingDots />
            {queuedLabel(live.queued)}
          </div>
        ) : live.compacting ? (
          <div {...LINE} className="flex items-center gap-2 text-body text-fg-muted">
            <ThinkingDots />
            Compacting conversation…
          </div>
        ) : (
          running && last?.kind !== 'assistant' && <Waiting label="Waiting for the reply" phase={live.phase} />
        ))}
      {outbox && <Outbox items={live.outbox} actions={outbox} turnFor={turnFor} />}
      {footer}
      {live.session?.status === 'interrupted' && last && (
        <div className="flex items-center gap-3 text-body text-fg-muted">
          Atelier restarted and cut off this reply.
          <Button size="sm" leadingIcon={RotateCcw} onClick={() => void carryOn(sessionId)}>
            Continue
          </Button>
        </div>
      )}
    </div>
    </SessionImagesProvider>
    </ChangeAreaProvider>
  );
}

const NONE: Record<string, string> = {};

/** The message of an assistant turn that reactions go on: its last reply. */
const replyId = (messages: readonly Message[]) => (messages.findLast((m) => m.role === 'assistant') ?? messages[0]!).id;

/**
 * What a co-op participant may do with the conversation (packages/core/src/coop/rules.ts): everyone who can chat
 * retries and edits their own messages, as themselves; switching branches, rewinding and retrying with another model
 * (which changes the session's model) are the host's. A viewer only reads.
 */
function coopMay(coop: CoopView) {
  const host = !coop.shared || coop.isHost;
  const chat = host || (coop.role !== 'viewer' && !coop.ended);
  return { branch: host, rewind: host, retryWith: host, retry: chat, edit: chat };
}

/** A user message's author in a shared session, and whether the viewer may edit it (their own; the host any). */
function userMessageCoop(coop: CoopView, message: Message, may: ReturnType<typeof coopMay>): { authorName?: string; authorAvatar?: string | null; editable: boolean; retryable: boolean } {
  if (!coop.shared) return { editable: true, retryable: true };
  const who = coop.person(message.author);
  // Separate strings, not an object: the message is memoized on its props.
  return { authorName: who.me ? 'You' : who.name, authorAvatar: who.avatar, editable: may.edit && (coop.isHost || who.me), retryable: may.retry };
}

/** Whether the viewer may edit the message a reply answers (a refusal offers it): their own, or the host any. */
function mayEditAsked(coop: CoopView, may: ReturnType<typeof coopMay>, before: ReturnType<typeof groupTurns>[number] | undefined): boolean {
  if (!may.edit) return false;
  return !coop.shared || coop.isHost || (before?.kind === 'user' && coop.person(before.message.author).me);
}

/** "for Ben": whom an assistant turn answered, in a shared session, when it isn't the viewer. */
function assistantFor(coop: CoopView, messages: readonly Message[], before: ReturnType<typeof groupTurns>[number] | undefined): string | undefined {
  if (!coop.shared) return undefined;
  const own = messages.find((m) => m.role === 'assistant' && m.author)?.author;
  const asked = before?.kind === 'user' && !before.message.parts.every((p) => p.type === 'context') ? (before.message.author ?? coop.hostId) : undefined;
  const id = own ?? asked;
  if (!id) return undefined;
  const who = coop.person(id);
  return who.me ? undefined : who.name;
}


/** Thinking dots until the reply starts; with a local model, what its server is doing meanwhile. */
function Waiting({ label, phase }: { label: string; phase: RunPhase | null }) {
  const text = usePhaseText(phase);
  if (!text) return <ThinkingDots label={label} className="ml-0.5" />;
  return (
    <div {...LINE} className="flex items-center gap-2 text-body text-fg-muted">
      <ThinkingDots className="ml-0.5" />
      <PhaseText text={text} />
    </div>
  );
}

/** The person's message a reply answers, when it can be edited (not one of Atelier's hidden notes). */
const editable = (turn: ReturnType<typeof groupTurns>[number] | undefined) =>
  turn?.kind === 'user' && !turn.message.parts.every((p) => p.type === 'context') ? turn.message.id : undefined;

function carryOn(sessionId: string) {
  return rpc()
    .call('chat.continue', { sessionId })
    .catch((e: unknown) => reportError(sessionId, e));
}

function retry(sessionId: string, messageId: string) {
  return rpc()
    .call('chat.retry', { sessionId, messageId })
    .catch((e: unknown) => reportError(sessionId, e));
}

/** The same question answered again by another model, as a new version of the reply; the conversation goes on with it. */
async function retryWith(sessionId: string, messageId: string, model: string) {
  try {
    await rpc().call('sessions.update', { id: sessionId, model });
    await rpc().call('chat.retry', { sessionId, messageId });
  } catch (e) {
    toast.error(describeError(e).message);
  }
}

function switchBranch(sessionId: string, messageId: string) {
  return rpc()
    .call('chat.switchBranch', { sessionId, messageId })
    .then((snapshot) => resetFromSnapshot(sessionId, snapshot))
    .catch((e: unknown) => toast.error(describeError(e).message));
}

const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  siblings,
  disabled,
  editing,
  onEditing,
  onRewind,
  authorName,
  authorAvatar = null,
  editable: canEdit = true,
  retryable: canRetry = true,
  reactions,
  askedFor,
}: {
  sessionId: string;
  message: Message;
  siblings: string[] | undefined;
  disabled: boolean;
  editing: boolean;
  /** Opens (with this message's id) or closes (null) the edit box. */
  onEditing(messageId: string | null): void;
  /** Set when the message's turn changed files (Code). */
  onRewind: ((messageId: string) => void) | undefined;
  /** Co-op: who wrote it, named above the bubble. */
  authorName?: string | undefined;
  authorAvatar?: string | null | undefined;
  /** Co-op: the viewer may edit it (their own message; the host any), and retry its reply. */
  editable?: boolean;
  retryable?: boolean;
  /** Co-op: the emoji on it, and the model it named to answer it (`@`). */
  reactions?: readonly Reaction[] | undefined;
  askedFor?: string | undefined;
}) {
  const text = messageText(message.parts);
  const files = message.parts.filter((p) => p.type === 'image' || p.type === 'document');
  const images = files.flatMap((p) => (p.type === 'image' ? [{ src: blobUrl(p.blob), alt: 'Attachment' }] : []));
  const notice = noticeOf(message);
  // Passages of earlier messages this one replies to.
  const quotes = message.parts.filter((p) => p.type === 'context' && p.notice?.kind === 'quote');
  // An image they brushed over, to have the marked part changed.
  const areas = message.parts.flatMap((p) => (p.type === 'context' && p.notice?.kind === 'area' ? [p] : []));

  // Only hidden context: a background sub-agent's end as one row, or a muted note, e.g. a Stop hook's feedback that
  // kept the run going, instead of a bubble.
  if (message.parts.every((p) => p.type === 'context')) {
    if (notice?.kind === 'agent') return <AgentNotice notice={notice} />;
    if (notice?.kind === 'message') return <MessageNotice notice={notice} />;
    if (notice?.kind === 'moved') return <MovedNotice notice={notice} />;
    // A command the person ran (`/compact`): what they sent, as their own message.
    if (notice?.kind === 'command')
      return (
        <div className="flex justify-end">
          <div data-selectable className="max-w-[85%] rounded-2xl bg-user-message px-4 py-3 text-user-text break-words whitespace-pre-wrap text-fg">
            <CommandText text={notice.command} />
          </div>
        </div>
      );
    const said = message.parts.map((p) => (p.type === 'context' ? p.text : '')).join('\n');
    if (!said.trim()) return null;
    return <p {...LINE} className="text-footnote whitespace-pre-wrap text-fg-muted">{said}</p>;
  }

  return (
    <div className="group/msg flex flex-col items-end gap-1" data-last={editing ? undefined : 'actions'}>
      {authorName && <AuthorLabel name={authorName} avatar={authorAvatar} {...(askedFor ? { detail: `asked for ${askedFor}` } : {})} />}
      {notice?.kind === 'loop' && (
        <Badge aria-label={`Sent by a loop, run ${notice.run}`} className="gap-1">
          <Icon icon={Repeat} className="size-3" />
          Loop
        </Badge>
      )}
      {quotes.map((p, i) => (p.type === 'context' && p.notice?.kind === 'quote' ? <QuoteBlock key={i} text={p.notice.text} /> : null))}
      {areas.map((p, i) => (p.notice?.kind === 'area' ? <AreaPreview key={i} image={p.notice.image} mask={p.notice.mask} /> : null))}
      {files.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {files.map((p, i) =>
            p.type === 'image' ? (
              <ZoomableImage
                key={i}
                group={images}
                index={files.slice(0, i).filter((f) => f.type === 'image').length}
                className="max-h-40 max-w-60 rounded-2xl object-cover inset-ring inset-ring-line"
              />
            ) : (
              <FilePreview key={i} part={p} />
            ),
          )}
        </div>
      )}
      {editing ? (
        <EditBox
          initial={text}
          onCancel={() => onEditing(null)}
          onSave={async (next) => {
            const parts: Part[] = [...quotes, ...areas, ...files, { type: 'text', text: next }];
            await rpc().call('chat.edit', { sessionId, messageId: message.id, parts });
            onEditing(null);
          }}
        />
      ) : (
        text && (
          <div data-selectable className="max-w-[85%] rounded-2xl bg-user-message px-4 py-3 text-user-text break-words whitespace-pre-wrap text-fg">
            <CommandText text={text} />
          </div>
        )
      )}
      {!editing && <ReactionPills sessionId={sessionId} messageId={message.id} reactions={reactions} align="end" />}
      {!editing && (
        <Actions>
          <ReactButton sessionId={sessionId} messageId={message.id} reactions={reactions} />
          <MessageTime at={message.createdAt} className="mr-1" />
          <BranchSwitcher sessionId={sessionId} messageId={message.id} siblings={siblings} disabled={disabled} />
          {onRewind && <IconButton icon={History} label="Rewind to here" size="xs" disabled={disabled} onClick={() => onRewind(message.id)} />}
          {canRetry && <IconButton icon={RotateCcw} label="Retry" size="xs" disabled={disabled} onClick={() => void retry(sessionId, message.id)} />}
          {canEdit && <IconButton icon={Pencil} label="Edit" size="xs" disabled={disabled} onClick={() => onEditing(message.id)} />}
          <CopyButton text={text} />
        </Actions>
      )}
    </div>
  );
});

/** What a message stands for besides its text: a loop's send, or a background sub-agent's end. */
function noticeOf(message: Message): Notice | undefined {
  for (const p of message.parts) if (p.type === 'context' && p.notice && p.notice.kind !== 'quote' && p.notice.kind !== 'area') return p.notice;
  return undefined;
}

function EditBox({ initial, onCancel, onSave }: { initial: string; onCancel(): void; onSave(text: string): Promise<void> }) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await onSave(text.trim());
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="w-full max-w-[85%] rounded-2xl bg-user-message p-3">
      <textarea
        autoFocus
        value={text}
        aria-label="Edit message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') onCancel();
        }}
        className="field-sizing-content max-h-96 min-h-12 w-full resize-none bg-transparent px-1 text-user-text text-fg outline-none"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabled={!text.trim()} onClick={() => void save()}>
          Send
        </Button>
      </div>
    </div>
  );
}

interface AssistantTurnProps {
  sessionId: string;
  messages: Message[];
  /** The person's message this turn answers, when they can edit it. */
  asked: string | undefined;
  onEditing(messageId: string): void;
  status: SessionStatus | undefined;
  streamingMessageId: string | null;
  artifacts: Record<string, ArtifactSummary>;
  toolInputs: Record<string, string>;
  toolOutput: Record<string, string>;
  toolProgress: Record<string, ImageProgress> | undefined;
  siblings: string[] | undefined;
  activity: ActivityView;
  last: boolean;
  /** Thinking dots while the reply hasn't started (unless a status line shows the run). */
  placeholder: boolean;
  /** What a local model's server is doing before the reply starts. */
  phase: RunPhase | null;
  /** The running turn's start (the person's message), on the last turn only. */
  turnSince: number | undefined;
  /** Co-op: whom this turn answered, when it isn't the viewer ("for Ben"). */
  forName?: string | undefined;
  /** Co-op: the viewer may retry it (as themselves), and retry it with another model (the host). */
  retryable?: boolean;
  retryWith?: boolean;
  /** Co-op: offers a second opinion from another model the viewer may use, and the emoji on the reply. */
  secondOpinion?: boolean;
  reactions?: readonly Reaction[] | undefined;
}

/** Re-renders only when one of its own messages (or the live state it reads) changes, not on every delta of the session. */
const sameTurn = (a: AssistantTurnProps, b: AssistantTurnProps) =>
  a.messages.length === b.messages.length &&
  a.messages.every((m, i) => m === b.messages[i]) &&
  (Object.keys(a) as (keyof AssistantTurnProps)[]).every((k) => k === 'messages' || a[k] === b[k]);

const AssistantTurn = memo(function AssistantTurn({
  sessionId,
  messages,
  asked,
  onEditing,
  status,
  streamingMessageId,
  artifacts,
  toolInputs,
  toolOutput,
  toolProgress,
  siblings,
  activity: Activity,
  last,
  placeholder,
  phase,
  turnSince,
  forName,
  retryable = true,
  retryWith = true,
  secondOpinion = false,
  reactions,
}: AssistantTurnProps) {
  const { data: models } = useModels();
  const results = toolResults(messages);
  const first = messages[0]!;
  const final = messages.findLast((m) => m.role === 'assistant') ?? first;
  // Waiting for the person (a permission prompt) is still part of the run, which is always the last turn.
  const sessionRunning = status === 'running' || status === 'waiting';
  const running = sessionRunning && last;
  // The model reads Atelier's tags in quoted material escaped (docs/PROMPTS.md §1.7); people see and copy the original.
  const text = unescapeTags(messages.map((m) => messageText(m.parts)).filter(Boolean).join('\n\n'));
  const model = models?.find((m) => m.ref === final.model);
  const items = turnItems(messages);
  const streaming = (ref: PartRef<unknown>) => isStreaming(ref, streamingMessageId);
  const run = { busy: running, streamingMessageId, toolOutput, toolProgress };
  // A reply that has shown nothing yet, while the status line below speaks for it: no empty row (the column's gap
  // around it would push the status line far from the message).
  if (running && items.length === 0 && !placeholder) return null;

  const itemKey = (item: (typeof items)[number]) =>
    item.kind === 'activity' ? item.key : item.kind === 'error' || item.kind === 'refusal' ? `${item.message.id}:${item.kind}` : item.ref.key;
  const itemView = (item: (typeof items)[number]) => {
      switch (item.kind) {
        case 'text':
          return <Markdown key={item.ref.key} text={item.ref.part.text} streaming={streaming(item.ref)} />;
        case 'thinking':
          return <ThinkingBlock key={item.ref.key} text={item.ref.part.text} active={streaming(item.ref)} />;
        case 'activity':
          // The run's newest calls are still going while the turn runs and nothing came after them.
          return <Activity key={item.key} steps={item.steps.map((ref) => stepView(ref, results, run))} live={running && item === items.at(-1)} turnSince={running ? turnSince : undefined} />;
        case 'visual':
          return <InlineVisual key={item.ref.key} call={item.ref.part} result={results.get(item.ref.part.id)} partialInput={toolInputs[item.ref.key]} running={running} />;
        case 'image': {
          const step = stepView(item.ref, results, run);
          return step.kind === 'tool' ? <GeneratedImages key={item.ref.key} step={step} waiting={status === 'waiting'} /> : null;
        }
        case 'video': {
          const step = stepView(item.ref, results, run);
          return step.kind === 'tool' ? <GeneratedVideos key={item.ref.key} step={step} waiting={status === 'waiting'} /> : null;
        }
        case 'audio': {
          const step = stepView(item.ref, results, run);
          return step.kind === 'tool' ? <GeneratedAudio key={item.ref.key} step={step} waiting={status === 'waiting'} /> : null;
        }
        case 'artifact': {
          const result = results.get(item.ref.part.id);
          return (
            <ArtifactCard
              key={item.ref.key}
              sessionId={sessionId}
              call={item.ref.part}
              artifacts={artifacts}
              status={result?.isError ? 'failed' : running && !result ? 'writing' : 'done'}
              partialInput={toolInputs[item.ref.key]}
            />
          );
        }
        case 'error':
          return (
            <MessageError
              key={`${item.message.id}:error`}
              error={item.message.error!}
              onRetry={!retryable || item.message.error!.retryable === false ? undefined : () => void retry(sessionId, first.id)}
            />
          );
        case 'refusal':
          return (
            <ProviderStopped
              key={`${item.message.id}:refusal`}
              onEdit={asked && !running ? () => onEditing(asked) : undefined}
              onRetry={running || !retryable ? undefined : () => void retry(sessionId, first.id)}
            />
          );
      }
  };
  // Where the turn begins and ends, for the column's spacing: a turn of calls and thinking is one muted line; a reply
  // that can be copied or retried is followed by the row of its actions, which only exists then.
  const isLine = (item: (typeof items)[number]) => item.kind === 'activity' || item.kind === 'thinking';
  const replied = items.some((item) => item.kind === 'text' || item.kind === 'artifact' || item.kind === 'visual' || item.kind === 'image' || item.kind === 'video' || item.kind === 'audio');
  const showActions = !running && replied;
  const rowFirst = items[0] && isLine(items[0]) ? 'line' : undefined;
  const rowLast = showActions ? 'actions' : items.at(-1) && isLine(items.at(-1)!) ? 'line' : undefined;

  return (
    <div className="group/msg flex flex-col" data-first={rowFirst} data-last={rowLast}>
      {forName && <span className="mb-1 text-caption text-fg-muted">for {forName}</span>}
      <div className={cn('flex flex-col', ITEM_GAPS)}>
        {/* Steps whose input is still coming in (a plan being written) read what has arrived. */}
        <StreamingInputs.Provider value={toolInputs}>
        {items.map((item) => (
          // `empty:hidden`: a thinking block with nothing to show renders nothing, and must not leave its gap.
          <div key={itemKey(item)} {...(isLine(item) ? { 'data-line': '' } : {})} className="empty:hidden">
            {itemView(item)}
          </div>
        ))}
        </StreamingInputs.Provider>
        {placeholder && running && items.length === 0 && <Waiting label="Thinking" phase={phase} />}
      </div>
      {!running && <ReactionPills sessionId={sessionId} messageId={final.id} reactions={reactions} />}
      {showActions && (
        <Actions align="start">
          <CopyButton text={text} />
          <ReactButton sessionId={sessionId} messageId={final.id} reactions={reactions} />
          {secondOpinion && <SecondOpinion sessionId={sessionId} messageId={first.id} />}
          <ReadAloudButton id={final.id} text={text} />
          {retryable && <IconButton icon={RotateCcw} label="Retry" size="xs" onClick={() => void retry(sessionId, first.id)} />}
          <BranchSwitcher sessionId={sessionId} messageId={first.id} siblings={siblings} disabled={false} />
          <MessageTime at={final.createdAt} className="ml-1" />
          {retryWith ? <RetryWith sessionId={sessionId} messageId={first.id} model={model} /> : model && <span className="ml-1 text-caption text-fg-muted">{model.displayName}</span>}
          {model && final.usage?.tokensPerSecond ? <span className="text-caption text-fg-muted">· {final.usage.tokensPerSecond.toFixed(1)} tok/s</span> : null}
        </Actions>
      )}
    </div>
  );
}, sameTurn);

function Actions({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <div
      className={cn(
        'flex h-6 items-center gap-0.5 text-fg-muted opacity-0 transition-opacity delay-100 duration-(--at-duration-snap) ease-snap group-focus-within/msg:opacity-100 group-hover/msg:opacity-100',
        // Touch screens have no hover: narrow ones always show them.
        'max-md:opacity-100',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
    >
      {children}
    </div>
  );
}

/** The reply's model, which opens "Retry with": the visible models by provider. */
function RetryWith({ sessionId, messageId, model }: { sessionId: string; messageId: string; model: ModelInfo | undefined }) {
  const groups = useModelGroups();
  if (groups.length === 0) return model ? <span className="ml-1 text-caption text-fg-muted">{model.displayName}</span> : null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={model ? `${model.displayName}, retry with another model` : 'Retry with another model'}
        className="ml-0.5 flex h-6 items-center gap-0.5 rounded-sm px-1 text-caption text-fg-muted outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg-secondary data-popup-open:bg-fill-ghost-hover"
      >
        {model?.displayName ?? 'Retry with…'}
        <Icon icon={ChevronDown} className="size-3" />
      </MenuTrigger>
      <MenuContent align="start" className="w-[295px]">
        {groups.map((g, i) => (
          <MenuGroup key={g.providerId}>
            {i > 0 && <MenuSeparator />}
            <MenuLabel>{groups.length > 1 ? `Retry with · ${g.label}` : 'Retry with'}</MenuLabel>
            {g.models.map((m) => (
              <MenuItem key={m.ref} description={modelSubtitle(m)} disabled={m.available === false} shortcut={m.ref === model?.ref ? 'This reply' : undefined} onClick={() => void retryWith(sessionId, messageId, m.ref)}>
                {m.displayName}
              </MenuItem>
            ))}
          </MenuGroup>
        ))}
      </MenuContent>
    </Menu>
  );
}

function BranchSwitcher({ sessionId, messageId, siblings, disabled }: { sessionId: string; messageId: string; siblings: string[] | undefined; disabled: boolean }) {
  if (!siblings || siblings.length < 2) return null;
  const index = siblings.indexOf(messageId);
  return (
    <span className="flex items-center text-caption text-fg-muted tabular-nums">
      <IconButton icon={ChevronLeft} label="Previous version" size="xs" disabled={disabled || index <= 0} onClick={() => void switchBranch(sessionId, siblings[index - 1]!)} />
      {index + 1}/{siblings.length}
      <IconButton
        icon={ChevronRight}
        label="Next version"
        size="xs"
        disabled={disabled || index >= siblings.length - 1}
        onClick={() => void switchBranch(sessionId, siblings[index + 1]!)}
      />
    </span>
  );
}

function FilePreview({ part }: { part: Extract<Part, { type: 'document' }> }) {
  return (
    <a
      href={blobUrl(part.blob)}
      download={part.name}
      className="flex h-14 max-w-60 items-center gap-3 rounded-xl bg-bg px-3 inset-ring inset-ring-line outline-none focus-ring hover:bg-fill-ghost-hover"
    >
      <Icon icon={FileText} size="md" className="text-fg-muted" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body text-fg">{part.name}</span>
        <Badge className="self-start">{(/\.([a-z0-9]{1,5})$/i.exec(part.name)?.[1] ?? 'file').toUpperCase()}</Badge>
      </span>
    </a>
  );
}

/** "Compacted session · saved 666.2k tokens": a muted line in the conversation that opens the summary. */
function CompactionDivider({ message, noun }: { message: Message; noun: string }) {
  const [open, setOpen] = useState(false);
  const saved = message.parts.reduce((n, p) => (p.type === 'context' && p.notice?.kind === 'compaction' ? p.notice.saved : n), 0);
  return (
    // A muted line between rows, not a turn of its own.
    <div {...LINE} className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-fit items-center gap-1.5 rounded-sm text-left text-body text-fg-muted outline-none focus-ring hover:text-fg-secondary"
      >
        <span>
          Compacted {noun}
          {saved > 0 && ` · saved ${formatTokenCount(saved)} tokens`}
        </span>
        <Icon icon={ChevronRight} size="sm" className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <Markdown text={messageText(message.parts)} streaming={false} />}
    </div>
  );
}
