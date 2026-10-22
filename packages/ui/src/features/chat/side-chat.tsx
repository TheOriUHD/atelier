/**
 * Side chats (`/btw`, design/components.md › SideChat): questions asked beside a session without interrupting it,
 * each in a tab of their own with its transcript and message box. The backend keeps them as hidden child sessions
 * that read the session's conversation and only read, so they come back after a reload. Code shows them in a pane
 * of its dock; Chat and Cowork in a panel on the right (`SideChatPanel`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Maximize2, MessageCircleQuestion, Minimize2, Plus, X } from 'lucide-react';
import type { SessionSummary } from '@atelier/protocol';
import { Icon, IconButton, Spinner, cn, toast } from '../../components/ui/index.ts';
import { useLiveSession } from '../../lib/live-session.ts';
import { useModels } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { PageKeysOff } from '../../lib/split-cell.tsx';
import { InteractionCard } from '../code/interaction-card.tsx';
import { LiveStatus } from '../code/live-status.tsx';
import { Composer, type ComposerHandle } from './composer.tsx';
import type { SlashCommand } from './composer-menu.tsx';
import { useSessionSend } from './outbox.tsx';
import { ScrollToBottom, useFollowScroll } from './session-view.tsx';
import { Transcript, type ActivityView } from './transcript.tsx';
import { useAttachments } from './use-attachments.ts';

export const SIDE_CHAT_TITLE = 'Side chat';

/** `/btw [question]`: opens a side chat with the question, or an empty one. */
export function btwCommand(ask: (question: string) => void): SlashCommand {
  return { name: 'btw', description: 'Ask a side question without interrupting', argumentHint: '[question]', icon: MessageCircleQuestion, run: ask };
}

const listKey = (sessionId: string) => ['sideChats', sessionId] as const;

/** A session's side chats and the one shown, with starting and closing them. */
export function useSideChats(sessionId: string) {
  const qc = useQueryClient();
  const { data: chats = [] } = useQuery({ queryKey: listKey(sessionId), queryFn: () => rpc().call('sideChats.list', { sessionId }) });
  const [picked, setPicked] = useState<string | null>(null);
  const [starting, setStarting] = useState(0);
  const shown = chats.find((c) => c.id === picked) ?? chats.at(-1) ?? null;
  const fail = (e: unknown) => toast.error(describeError(e).message);
  const put = (chat: SessionSummary) => qc.setQueryData<SessionSummary[]>(listKey(sessionId), (list = []) => (list.some((c) => c.id === chat.id) ? list.map((c) => (c.id === chat.id ? chat : c)) : [...list, chat]));
  return {
    chats,
    shown,
    /** A start in progress: the pane shows it is coming. */
    starting: starting > 0,
    show: setPicked,
    start(question?: string) {
      setStarting((n) => n + 1);
      void rpc()
        .call('sideChats.start', { sessionId, ...(question?.trim() ? { question: question.trim() } : {}) })
        .then(async (chat) => {
          // A list read still on its way would land after this and leave the new one out.
          await qc.cancelQueries({ queryKey: listKey(sessionId) });
          put(chat);
          setPicked(chat.id);
        })
        .catch(fail)
        .finally(() => setStarting((n) => n - 1));
    },
    close(id: string) {
      qc.setQueryData<SessionSummary[]>(listKey(sessionId), (list = []) => list.filter((c) => c.id !== id));
      void rpc().call('sessions.delete', { id }).catch(fail);
    },
    /** A side chat's title written after its first answer (an empty one's). */
    retitle(id: string, title: string) {
      const chat = chats.find((c) => c.id === id);
      if (chat && chat.title !== title) put({ ...chat, title });
    },
  };
}

export type SideChats = ReturnType<typeof useSideChats>;

/** The tabs (each closes with ×) and + for another side chat. */
export function SideChatTabs({ chats, onClose }: { chats: SideChats; onClose(id: string): void }) {
  return (
    <div role="group" aria-label="Side chats" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
      {chats.chats.map((chat) => {
        const title = chat.title || SIDE_CHAT_TITLE;
        const current = chats.shown?.id === chat.id;
        return (
          <div
            key={chat.id}
            title={title}
            className={cn(
              'flex h-7 max-w-48 shrink-0 items-center rounded-md pr-0.5 text-control-sm text-fg-secondary hover:bg-fill-ghost-hover',
              current && 'bg-fill-ghost-selected text-fg hover:bg-fill-ghost-selected',
            )}
          >
            <button type="button" aria-current={current || undefined} onClick={() => chats.show(chat.id)} className="flex h-full min-w-0 items-center rounded-md pl-2 outline-none focus-ring">
              <span className="truncate">{title}</span>
            </button>
            <IconButton icon={X} label={`Close ${title}`} size="xs" className="size-5 text-fg-muted" onClick={() => onClose(chat.id)} />
          </div>
        );
      })}
      <IconButton icon={Plus} label="New side chat" size="xs" className="shrink-0 text-fg-secondary" onClick={() => chats.start()} />
    </div>
  );
}

/** The shown side chat, or a box that starts one with its first question. */
export function SideChatBody({ chats, activity }: { chats: SideChats; activity?: ActivityView }) {
  if (chats.shown) return <SideChatView key={chats.shown.id} chatId={chats.shown.id} activity={activity} onTitle={(title) => chats.retitle(chats.shown!.id, title)} />;
  if (chats.starting)
    return (
      <div className="flex flex-1 items-center justify-center text-fg-muted">
        <Spinner label="Starting the side chat" />
      </div>
    );
  return <SideChatStart onAsk={(question) => chats.start(question)} />;
}

function SideChatStart({ onAsk }: { onAsk(question: string): void }) {
  const attachments = useAttachments();
  const { data: models } = useModels();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon icon={MessageCircleQuestion} size="lg" className="text-fg-muted" />
        <p className="text-body text-fg">Ask a side question</p>
        <p className="max-w-64 text-footnote text-fg-muted">It reads this session and its folder and answers here, without interrupting it.</p>
      </div>
      <SideComposer>
        <Composer variant="reply" compact autoFocus attachments={attachments} model={models?.[0]} streaming={false} placeholder="Ask a side question" onSubmit={onAsk} />
      </SideComposer>
    </div>
  );
}

function SideComposer({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-3">
      <PageKeysOff>{children}</PageKeysOff>
    </div>
  );
}

/** One side chat: its transcript with the live status line, what it waits on, and its own message box. */
function SideChatView({ chatId, activity, onTitle }: { chatId: string; activity?: ActivityView | undefined; onTitle(title: string): void }) {
  const live = useLiveSession(chatId);
  const { data: models } = useModels();
  const attachments = useAttachments();
  const composer = useRef<ComposerHandle>(null);
  const { ref: scroller, atBottom, followSmooth, onScroll } = useFollowScroll(live);
  const session = live.session;
  const busy = session?.status === 'running' || session?.status === 'waiting';
  const model = models?.find((m) => m.ref === session?.model);
  const sending = useSessionSend({ sessionId: chatId, busy, outbox: live.outbox, attachments, composer, follow: followSmooth });
  const title = session?.title;
  useEffect(() => {
    if (title) onTitle(title);
  }, [title, onTitle]);

  if (live.status === 'error')
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-body text-fg-muted" role="alert">
        {live.error}
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} className="h-full overflow-x-hidden overflow-y-auto" onScroll={onScroll}>
          {live.status === 'loading' ? (
            <div className="flex h-full items-center justify-center text-fg-muted">
              <Spinner label="Loading side chat" />
            </div>
          ) : live.messages.length === 0 ? (
            <p className="px-6 pt-9 text-center text-body text-fg-muted">Ask anything about this session. It reads, and changes nothing.</p>
          ) : (
            <Transcript sessionId={chatId} live={live} {...(activity ? { activity } : {})} status={<LiveStatus sessionId={chatId} />} outbox={sending.actions} />
          )}
        </div>
        {!atBottom && <ScrollToBottom onClick={followSmooth} working={session?.status === 'running'} />}
      </div>
      <SideComposer>
        <Composer
          ref={composer}
          variant="reply"
          compact
          autoFocus
          attachments={attachments}
          model={model ?? models?.[0]}
          streaming={busy}
          placeholder="Ask a follow-up"
          dock={live.pending && <InteractionCard key={live.pending.id} sessionId={chatId} pending={live.pending} docked />}
          onSubmit={sending.send}
          onStop={sending.stop}
        />
      </SideComposer>
    </div>
  );
}

const OPEN_PREFIX = 'atelier.sideChat.';

/** Chat and Cowork: whether the side chat panel is open, as this device left it for the session. */
export function useSideChatPanel(sessionId: string) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_PREFIX + sessionId) === '1';
    } catch {
      return false;
    }
  });
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    try {
      if (open) localStorage.setItem(OPEN_PREFIX + sessionId, '1');
      else localStorage.removeItem(OPEN_PREFIX + sessionId);
    } catch {
      // Storage unavailable: the panel stays as long as the page.
    }
  }, [sessionId, open]);
  return { open, setOpen, fullscreen: open && fullscreen, setFullscreen };
}

export type SideChatPanelState = ReturnType<typeof useSideChatPanel>;

/** Chat and Cowork's side chats: a panel on the right of the conversation, or over all of it in fullscreen. */
export function SideChatPanel({ chats, panel }: { chats: SideChats; panel: SideChatPanelState }) {
  const close = () => {
    panel.setOpen(false);
    panel.setFullscreen(false);
  };
  return (
    <section
      aria-label={SIDE_CHAT_TITLE}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-bg',
        panel.fullscreen ? 'absolute inset-0 z-20' : 'w-[min(480px,45%)] shrink-0 border-l border-line-subtle max-md:absolute max-md:inset-0 max-md:z-20 max-md:w-auto max-md:border-0',
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-2">
        <SideChatTabs
          chats={chats}
          onClose={(id) => {
            chats.close(id);
            if (chats.chats.length <= 1) close();
          }}
        />
        <IconButton
          icon={panel.fullscreen ? Minimize2 : Maximize2}
          label={panel.fullscreen ? `Exit fullscreen: ${SIDE_CHAT_TITLE}` : `Fullscreen ${SIDE_CHAT_TITLE}`}
          size="xs"
          className="text-fg-secondary max-md:hidden"
          onClick={() => panel.setFullscreen(!panel.fullscreen)}
        />
        <IconButton icon={X} label={`Close ${SIDE_CHAT_TITLE}`} size="xs" className="text-fg-secondary" onClick={close} />
      </header>
      <SideChatBody chats={chats} />
    </section>
  );
}
