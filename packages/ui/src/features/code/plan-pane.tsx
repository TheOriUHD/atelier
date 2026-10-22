/**
 * The Plan pane (design/components.md › Code panes, opened from More): the plan the session presented last (ExitPlanMode),
 * whether it was approved, and the task list it is working through.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { APP, PLAN_MODE_OFF, messageText, type Message, type Todo } from '@atelier/protocol';
import { Copy, MessageSquareText, X } from 'lucide-react';
import { Button, Icon, IconButton, MenuItem, TextArea } from '../../components/ui/index.ts';
import { planComments, usePlanComments } from './plan-comments.ts';
import { asRecord, str } from './tool-cards.tsx';
import { Markdown } from '../chat/markdown.tsx';
import { toolResults } from '../chat/turns.ts';
import { PaneMessage } from './file-tree.tsx';
import { PaneFrame, type PaneFrameState } from './pane-dock.tsx';
import { TodoList } from './todo-widget.tsx';

/** The newest plan in the conversation and where it stands, or null before the first. */
export function latestPlan(messages: readonly Message[]): { plan: string; status: 'waiting' | 'approved' | 'declined' } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const call = message.parts.findLast((p) => p.type === 'tool_call' && p.name === 'ExitPlanMode');
    if (call?.type !== 'tool_call') continue;
    const result = toolResults(messages.slice(i)).get(call.id);
    // Called outside plan mode: no plan was up for approval.
    if (result && messageText(result.content) === PLAN_MODE_OFF) continue;
    return { plan: str(asRecord(call.input).plan), status: !result ? 'waiting' : result.isError ? 'declined' : 'approved' };
  }
  return null;
}

const STATUS = { waiting: 'Waiting for your approval', approved: 'Approved', declined: 'Not approved' } as const;

/**
 * The plan's text, where a passage can be selected to comment on it (while the plan waits for an answer). A selection
 * offers Comment next to it; the comment is kept with the passage and goes to the model with "Revise…".
 */
function Annotatable({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{ quote: string; left: number; top: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  // The passage stays offered while its comment is typed; a collapsed selection (a click elsewhere) withdraws it.
  useEffect(() => {
    const onChange = () => {
      const s = window.getSelection();
      if ((!s || s.isCollapsed) && draft === null) setSelected(null);
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [draft]);

  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const read = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !box.contains(s.anchorNode) || !box.contains(s.focusNode)) return;
      const quote = s.toString().replace(/\s+/g, ' ').trim();
      if (!quote) return;
      const at = s.getRangeAt(0).getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      setDraft(null);
      setSelected({ quote, left: Math.max(0, Math.min(at.left - frame.left, frame.width - 280)), top: at.bottom - frame.top + 6 });
    };
    box.addEventListener('mouseup', read);
    box.addEventListener('keyup', read);
    return () => {
      box.removeEventListener('mouseup', read);
      box.removeEventListener('keyup', read);
    };
  }, []);

  const add = () => {
    if (selected && draft?.trim()) planComments.add(sessionId, selected.quote, draft.trim());
    setSelected(null);
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div ref={root} className="relative">
      {children}
      {selected && (
        <div className="absolute z-10" style={{ left: selected.left, top: selected.top }}>
          {draft === null ? (
            <Button size="sm" variant="secondary" leadingIcon={MessageSquareText} onMouseDown={(e) => e.preventDefault()} onClick={() => setDraft('')}>
              Comment
            </Button>
          ) : (
            <form
              className="flex w-[280px] flex-col gap-2 rounded-xl bg-raised p-2 shadow-popover inset-ring inset-ring-line"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <TextArea
                autoFocus
                rows={3}
                aria-label="Your comment"
                placeholder="What should change here?"
                value={draft}
                maxLength={600}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setDraft(null);
                    setSelected(null);
                  }
                }}
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => (setDraft(null), setSelected(null))}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>
                  Add comment
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanPane({
  frame,
  sessionId,
  messages,
  todos,
  running,
}: {
  frame: PaneFrameState;
  sessionId: string;
  messages: Message[];
  todos: Todo[];
  running: boolean;
}) {
  const latest = latestPlan(messages);
  const comments = usePlanComments(sessionId);
  const waiting = latest?.status === 'waiting';
  // Comments belong to a plan that is waiting: once it is answered they are gone.
  useEffect(() => {
    if (!waiting) planComments.clear(sessionId);
  }, [waiting, sessionId]);
  return (
    <PaneFrame
      frame={frame}
      title="Plan"
      menu={
        latest && (
          <MenuItem icon={Copy} onClick={() => void navigator.clipboard.writeText(latest.plan)}>
            Copy plan
          </MenuItem>
        )
      }
    >
      {!latest && !todos.length ? (
        <div className="flex flex-1 items-center justify-center">
          <PaneMessage>No plan yet. In plan mode the assistant presents its plan here before it changes anything, and its task list follows.</PaneMessage>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 py-3">
          {latest && (
            // The plan is a document to read and mark up, in the interface font like the rest of the pane.
            <section aria-label="Current plan" className="flex flex-col gap-2 [--at-font-chat:var(--at-font-ui)]">
              {waiting ? (
                <p className="flex items-center gap-2 text-footnote text-fg-muted">
                  <Icon icon={MessageSquareText} />
                  Select any text to leave a comment for {APP.name}
                </p>
              ) : (
                <p className="text-footnote text-fg-muted">{STATUS[latest.status]}</p>
              )}
              {waiting ? (
                <Annotatable sessionId={sessionId}>
                  <Markdown text={latest.plan} streaming={false} />
                </Annotatable>
              ) : (
                <Markdown text={latest.plan} streaming={false} />
              )}
            </section>
          )}
          {waiting && comments.length > 0 && (
            <section aria-label="Your comments" className="flex flex-col gap-2">
              <h3 className="text-body-strong text-fg">Your comments</h3>
              <ul className="flex flex-col gap-2">
                {comments.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 rounded-lg px-3 py-2 inset-ring inset-ring-line">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-footnote text-fg-muted">“{c.quote}”</p>
                      <p className="mt-1 text-body text-fg break-words">{c.text}</p>
                    </div>
                    <IconButton icon={X} label="Remove comment" size="xs" onClick={() => planComments.remove(sessionId, c.id)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {todos.length > 0 && (
            <section aria-labelledby="plan-tasks" className="flex flex-col gap-1">
              <h3 id="plan-tasks" className="text-body-strong text-fg">
                Tasks
              </h3>
              <TodoList todos={todos} running={running} />
            </section>
          )}
        </div>
      )}
    </PaneFrame>
  );
}
