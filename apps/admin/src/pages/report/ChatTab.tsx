/**
 * An attached chat as a transcript: the person's messages in bubbles, the assistant's markdown (sanitized,
 * lib/markdown.ts), thinking folded away, tool calls as cards with their results, sub-agents nested, context notes
 * quiet, pictures and documents as placeholders, and a divider where the app left messages out.
 */
import {
  Bot,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FileText,
  Image as ImageIcon,
  Info,
  Scissors,
  Wrench,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Card, Facts, cx } from '../../components/ui';
import { dateTime, num } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import type { ReportChat } from '../../types';

type Message = ReportChat['messages'][number];
type Part = Message['parts'][number];
type ToolCall = Extract<Part, { type: 'tool_call' }>;
type ToolResult = Extract<Part, { type: 'tool_result' }>;
type Gap = ReportChat['coverage']['omitted'][number];

const Cut = ({ n }: { n?: number | undefined }) =>
  n ? (
    <span
      className="inline-flex items-center gap-1 text-caption text-fg-muted"
      title="Shortened by the app before sending"
    >
      <Scissors size={12} aria-hidden />
      {num(n)} characters left out
    </span>
  ) : null;

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // Sanitized: raw HTML is escaped, links are http(s)/mailto only, pictures aren't loaded.
  return <div className="md select-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Long text folded to a few lines until asked. */
function Folded({ text, lines = 14, className }: { text: string; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const count = text.split('\n').length;
  const long = count > lines || text.length > 1600;
  return (
    <div>
      <pre
        className={cx(
          'overflow-x-auto font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap select-text',
          !open && long && 'max-h-[252px] overflow-hidden',
          className,
        )}
      >
        {text}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-caption text-interactive-text hover:underline"
        >
          {open ? 'Show less' : `Show all ${num(count)} lines`}
        </button>
      )}
    </div>
  );
}

function pretty(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

function ToolCard({
  call,
  result,
  results,
}: {
  call: ToolCall;
  result: ToolResult | undefined;
  results: Map<string, ToolResult>;
}) {
  const [open, setOpen] = useState(Boolean(result?.isError));
  return (
    <div
      className={cx(
        'my-2 overflow-hidden rounded-lg bg-surface shadow-card-ring',
        result?.isError && 'shadow-[0_0_0_1px_var(--at-color-danger)]',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-fill-ghost-hover"
      >
        <ChevronRight
          size={14}
          className={cx('shrink-0 text-fg-muted transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        <Wrench size={13} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="font-mono text-caption font-medium">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg-muted">{call.input.slice(0, 160)}</span>
        {call.cut ? <Badge>shortened</Badge> : null}
        {result?.isError && <Badge tone="red">error</Badge>}
        {!result && <span className="text-caption text-fg-muted">no result</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-line-subtle px-3 py-2">
          <div>
            <div className="mb-1 text-caption text-fg-muted">Input</div>
            <Folded text={pretty(call.input)} />
            <Cut n={call.cut} />
          </div>
          {result && (
            <div>
              <div className="mb-1 text-caption text-fg-muted">
                Result
                {result.images ? `, with ${result.images} picture${result.images === 1 ? '' : 's'} (not sent)` : ''}
              </div>
              <Folded
                text={result.text || '(empty)'}
                className={result.isError ? 'text-danger-text' : 'text-fg-secondary'}
              />
              <Cut n={result.cut} />
            </div>
          )}
        </div>
      )}
      {call.child && (
        <div className="border-t border-line-subtle bg-bg-sunken px-3 py-2">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-caption">
            <Bot size={13} className="text-fg-muted" aria-hidden />
            <span className="font-medium">Sub-agent: {call.child.title}</span>
            <Badge>{call.child.mode}</Badge>
            <Badge tone={call.child.status === 'error' || call.child.status === 'failed' ? 'red' : 'neutral'}>
              {call.child.status}
            </Badge>
            <span className="text-fg-muted">
              {call.child.messages.length < call.child.messageCount
                ? `last ${call.child.messages.length} of ${num(call.child.messageCount)} messages`
                : `${num(call.child.messageCount)} messages`}
            </span>
          </div>
          <div className="border-l-2 border-line pl-3">
            <Messages messages={call.child.messages} gaps={gapsBetween(call.child.messages)} results={results} nested />
          </div>
        </div>
      )}
    </div>
  );
}

function Placeholder({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="my-1 inline-flex items-center gap-1.5 rounded-md bg-badge-bg px-2 py-1 text-caption text-fg-secondary">
      {icon}
      {children}
    </span>
  );
}

function PartView({
  part,
  speaker,
  results,
}: {
  part: Part;
  speaker: Message['role'];
  results: Map<string, ToolResult>;
}) {
  switch (part.type) {
    case 'text':
      return (
        <>
          {speaker === 'assistant' ? (
            <Markdown text={part.text} />
          ) : (
            <div className="break-words whitespace-pre-wrap select-text">{part.text}</div>
          )}
          <Cut n={part.cut} />
        </>
      );
    case 'thinking':
      return (
        <details className="my-1 rounded-lg text-footnote text-fg-muted">
          <summary className="inline-flex cursor-default items-center gap-1 select-none hover:text-fg-secondary">
            <ChevronRight size={13} aria-hidden />
            Thinking{part.redacted ? ' (redacted by the provider)' : ''}
          </summary>
          <div className="mt-1 border-l-2 border-line pl-3 font-serif break-words whitespace-pre-wrap italic select-text">
            {part.text || '…'}
          </div>
          <Cut n={part.cut} />
        </details>
      );
    case 'tool_call':
      return <ToolCard call={part} result={results.get(part.id)} results={results} />;
    case 'tool_result':
      // A result whose call isn't in the transcript (it was left out): on its own.
      return (
        <div
          className={cx('my-2 rounded-lg bg-surface px-3 py-2 shadow-card-ring', part.isError && 'text-danger-text')}
        >
          <div className="mb-1 text-caption text-fg-muted">Result of a call that was left out</div>
          <Folded text={part.text} />
          <Cut n={part.cut} />
        </div>
      );
    case 'image':
      return <Placeholder icon={<ImageIcon size={13} aria-hidden />}>A picture ({part.mime}), not sent</Placeholder>;
    case 'document':
      return (
        <Placeholder icon={<FileText size={13} aria-hidden />}>
          {part.name} ({part.mime}), not sent
        </Placeholder>
      );
    case 'context':
      return (
        <div className="my-1 flex gap-1.5 text-caption text-fg-muted">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 break-words whitespace-pre-wrap select-text">
            {part.text}
            <Cut n={part.cut} />
          </div>
        </div>
      );
  }
}

function Meta({ m }: { m: Message }) {
  const usage = m.usage ? Object.entries(m.usage).map(([k, v]) => `${num(v)} ${k}`) : [];
  const bits = [m.model, m.stopReason, ...usage].filter(Boolean);
  return (
    <div className="mt-1 flex flex-wrap gap-x-2 text-caption text-fg-muted">
      <span title={dateTime(m.createdAt)}>#{m.index}</span>
      {m.kind !== 'text' && <span>{m.kind}</span>}
      {bits.map((b, i) => (
        <span key={i}>{b}</span>
      ))}
    </div>
  );
}

function MessageView({
  m,
  results,
  calls,
  nested,
}: {
  m: Message;
  results: Map<string, ToolResult>;
  calls: Set<string>;
  nested: boolean;
}) {
  // Results shown in their call's card aren't shown again.
  const parts = m.parts.filter((p) => !(p.type === 'tool_result' && calls.has(p.callId)));
  if (!parts.length && !m.error) return null;
  if (m.role === 'user')
    return (
      <div className="flex flex-col items-end">
        {m.author && <div className="mb-0.5 text-caption text-fg-muted">{m.author}</div>}
        <div
          className={cx(
            'max-w-[85%] rounded-2xl bg-user-message px-3.5 py-2 text-user-text',
            nested && 'text-footnote',
          )}
        >
          {parts.map((p, i) => (
            <PartView key={i} part={p} speaker="user" results={results} />
          ))}
        </div>
        <Meta m={m} />
      </div>
    );
  return (
    <div className={nested ? 'text-footnote' : ''}>
      {m.author && <div className="mb-0.5 text-caption text-fg-muted">{m.author}</div>}
      {parts.map((p, i) => (
        <PartView key={i} part={p} speaker={m.role} results={results} />
      ))}
      {m.error && (
        <div className="my-1 rounded-lg bg-danger-subtle px-3 py-2 text-footnote break-words text-danger-text">
          {m.error}
        </div>
      )}
      <Meta m={m} />
    </div>
  );
}

function GapDivider({ gap }: { gap: Gap }) {
  return (
    <div className="flex items-center gap-3 py-1 text-caption text-fg-muted" role="separator">
      <span className="h-px flex-1 bg-line" />
      Messages {num(gap.from)}–{num(gap.to)} left out
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Messages in order, with a divider before the first message after each gap. */
function Messages({
  messages,
  gaps,
  results,
  nested = false,
}: {
  messages: Message[];
  gaps: Gap[];
  results: Map<string, ToolResult>;
  nested?: boolean;
}) {
  const sorted = [...messages].sort((a, b) => a.index - b.index);
  const calls = new Set(
    sorted.flatMap((m) => m.parts.filter((p): p is ToolCall => p.type === 'tool_call').map((p) => p.id)),
  );
  const out: ReactNode[] = [];
  let prev = -1;
  const placed = new Set<Gap>();
  for (const m of sorted) {
    for (const g of gaps) {
      if (!placed.has(g) && g.from > prev && g.from <= m.index) {
        placed.add(g);
        out.push(<GapDivider key={`gap-${g.from}`} gap={g} />);
      }
    }
    out.push(<MessageView key={m.index} m={m} results={results} calls={calls} nested={nested} />);
    prev = m.index;
  }
  for (const g of gaps) if (!placed.has(g)) out.push(<GapDivider key={`gap-${g.from}`} gap={g} />);
  return <div className={nested ? 'space-y-2 py-1' : 'space-y-5'}>{out}</div>;
}

/** A sub-agent's messages come as its first and its last ones: the indices they skip, as gaps. */
function gapsBetween(messages: Message[]): Gap[] {
  const at = messages.map((m) => m.index).sort((a, b) => a - b);
  const gaps: Gap[] = [];
  for (let i = 1; i < at.length; i++) if (at[i]! - at[i - 1]! > 1) gaps.push({ from: at[i - 1]! + 1, to: at[i]! - 1 });
  return gaps;
}

/** Every tool result in the chat by its call id, sub-agents' included. */
function collectResults(messages: Message[], into = new Map<string, ToolResult>()): Map<string, ToolResult> {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_result') into.set(p.callId, p);
      if (p.type === 'tool_call' && p.child) collectResults(p.child.messages, into);
    }
  }
  return into;
}

const TODO_ICON: Record<string, ReactNode> = {
  completed: <CircleCheck size={14} className="text-success-text" aria-label="Done" />,
  in_progress: <CircleDot size={14} className="text-accent" aria-label="In progress" />,
};

export function ChatTab({ chat }: { chat: ReportChat }) {
  const results = useMemo(() => collectResults(chat.messages), [chat]);
  const s = chat.session;
  const c = chat.coverage;
  return (
    <div className="space-y-4">
      <Card title={s.title} actions={<Badge>{s.mode}</Badge>}>
        <div className="grid gap-4 md:grid-cols-2">
          <Facts
            rows={[
              ['Model', s.model],
              ['Provider', s.provider],
              ['Effort', s.effort],
              ['Permissions', s.permissionMode],
              ['Status', s.status],
              ['Folder', s.workspace ? `${s.workspace.name} (${s.workspace.kind})` : null],
              ['Co-op', s.coop ? 'Yes' : null],
              ['Started', dateTime(s.createdAt)],
              ['Last change', dateTime(s.updatedAt)],
            ]}
          />
          <div className="space-y-3">
            <Facts
              rows={[
                [
                  'Messages',
                  `${num(c.total)} in all, ${num(c.included)} here${c.shortened ? `, ${num(c.shortened)} parts shortened` : ''}`,
                ],
                ...Object.entries(s.usage ?? {}).map(([k, v]): [string, ReactNode] => [k, num(v)]),
              ]}
            />
            {s.todos && s.todos.length > 0 && (
              <div>
                <div className="mb-1 text-footnote text-fg-muted">Task list</div>
                <ul className="space-y-1 text-footnote">
                  {s.todos.map((t, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="mt-0.5 shrink-0">
                        {TODO_ICON[t.status] ?? <Circle size={14} className="text-fg-muted" aria-label="To do" />}
                      </span>
                      <span className={t.status === 'completed' ? 'text-fg-muted line-through' : ''}>{t.content}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </Card>
      <div className="rounded-xl bg-surface p-4 shadow-card-ring md:p-6">
        <div className="mx-auto max-w-[760px]">
          {chat.messages.length ? (
            <Messages messages={chat.messages} gaps={c.omitted} results={results} />
          ) : (
            <div className="text-footnote text-fg-muted">No messages.</div>
          )}
        </div>
      </div>
    </div>
  );
}
