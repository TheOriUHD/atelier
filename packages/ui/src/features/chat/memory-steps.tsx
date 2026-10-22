/**
 * Memory and past-chat steps in a transcript (design/components.md › Transcript › `MemoryStep`): one folded line
 * ("Looked at memories", "Saved a memory", "Searched past chats") that opens to the memories or chats it touched, each a
 * link to that memory's page in Settings or to that chat.
 */
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { parseChatHits, parseChatRead, parseMemoryHits, parseMemoryUpdate, type ToolCallPart, type ToolResultPart } from '@atelier/protocol';
import { ThinkingDots } from '../../components/ui/index.ts';
import { SESSION_ROUTE, useOpenMemory } from '../../app/navigation.ts';
import { Summary } from './parts.tsx';
import type { ActivityStepView } from './turns.ts';

type ToolStep = Extract<ActivityStepView, { kind: 'tool' }>;

/** Tools whose calls read as memory steps rather than generic tool rows. */
export const MEMORY_TOOLS: ReadonlySet<string> = new Set(['MemorySearch', 'MemoryView', 'MemoryUpdate', 'ChatSearch', 'ChatRead']);

const LOOKS = new Set(['MemorySearch', 'MemoryView']);

const resultText = (result: ToolResultPart | undefined) => result?.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n') ?? '';
const input = (call: ToolCallPart) => (call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {});

/** What a memory step says, running or done. */
export function memoryStepLabel(call: Pick<ToolCallPart, 'name' | 'input'>, running: boolean): string {
  switch (call.name) {
    case 'MemorySearch':
    case 'MemoryView':
      return running ? 'Looking at memories' : 'Looked at memories';
    case 'MemoryUpdate': {
      const op = input(call as ToolCallPart).op;
      if (op === 'delete') return running ? 'Forgetting a memory' : 'Forgot a memory';
      if (op === 'update') return running ? 'Updating a memory' : 'Updated a memory';
      return running ? 'Saving a memory' : 'Saved a memory';
    }
    case 'ChatSearch':
      return running ? 'Searching past chats' : 'Searched past chats';
    case 'ChatRead':
      return running ? 'Reading a past chat' : 'Read a past chat';
    default:
      return call.name;
  }
}

/**
 * Splits a run of steps into memory steps and the rest, in order. Lookups in a row (MemorySearch, then MemoryView) share
 * one "Looked at memories" line.
 */
export function splitMemorySteps(steps: readonly ActivityStepView[]): ({ kind: 'memory'; steps: ToolStep[] } | { kind: 'other'; steps: ActivityStepView[] })[] {
  const out: ({ kind: 'memory'; steps: ToolStep[] } | { kind: 'other'; steps: ActivityStepView[] })[] = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (step.kind === 'tool' && MEMORY_TOOLS.has(step.call.name)) {
      const lookup = LOOKS.has(step.call.name);
      if (lookup && last?.kind === 'memory' && last.steps.every((s) => LOOKS.has(s.call.name))) last.steps.push(step);
      else out.push({ kind: 'memory', steps: [step] });
    } else if (last?.kind === 'other') last.steps.push(step);
    else out.push({ kind: 'other', steps: [step] });
  }
  return out;
}

const ROW = 'flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left text-body outline-none focus-ring hover:bg-fill-ghost-hover';

/** One memory step (or lookups in a row), folded to its line. */
export function MemoryStep({ steps }: { steps: ToolStep[] }) {
  const [open, setOpen] = useState(false);
  const openMemory = useOpenMemory();
  const first = steps[0]!;
  const running = steps.some((s) => s.running);
  const failed = steps.every((s) => s.result?.isError);
  const label = memoryStepLabel(first.call, running);

  let rows: ReactNode[] = [];
  if (LOOKS.has(first.call.name)) {
    const seen = new Set<string>();
    const hits = steps.flatMap((s) => (s.result && !s.result.isError ? parseMemoryHits(resultText(s.result)) : [])).filter((h) => !seen.has(h.id) && seen.add(h.id));
    rows = hits.map((h) => (
      <li key={h.id} className="border-t border-line first:border-t-0">
        <button type="button" onClick={() => openMemory(h.id)} className={ROW}>
          <span className="truncate text-fg">{h.title}</span>
          {h.summary && <span className="truncate text-footnote text-fg-muted">{h.summary}</span>}
        </button>
      </li>
    ));
    if (!hits.length && !running) rows = [<li key="none" className="px-3 py-2 text-body text-fg-muted">{failed ? 'It couldn’t look at memory.' : 'No memories matched.'}</li>];
  } else if (first.call.name === 'MemoryUpdate') {
    const changed = first.result && !first.result.isError ? parseMemoryUpdate(resultText(first.result)) : null;
    const deleted = input(first.call).op === 'delete';
    if (changed)
      rows = [
        <li key={changed.id}>
          {deleted ? (
            <span className={`${ROW} hover:bg-transparent`}>
              <span className="truncate text-fg">{changed.title}</span>
            </span>
          ) : (
            <button type="button" onClick={() => openMemory(changed.id)} className={ROW}>
              <span className="truncate text-fg">{changed.title}</span>
              <span className="truncate text-footnote text-fg-muted">Open in Settings › Memory</span>
            </button>
          )}
        </li>,
      ];
    else if (first.result?.isError) rows = [<li key="error" className="px-3 py-2 text-body text-danger-text">{resultText(first.result)}</li>];
  } else if (first.call.name === 'ChatSearch') {
    const hits = first.result && !first.result.isError ? parseChatHits(resultText(first.result)) : [];
    rows = hits.map((h) => (
      <li key={h.sessionId} className="border-t border-line first:border-t-0">
        <Link to={SESSION_ROUTE[h.mode]} params={{ sessionId: h.sessionId }} className={ROW}>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-fg">{h.title}</span>
            <span className="shrink-0 text-footnote text-fg-muted">{h.date}</span>
          </span>
          {h.snippet && <span className="line-clamp-2 text-footnote text-fg-muted">{h.snippet}</span>}
        </Link>
      </li>
    ));
    if (!hits.length && !running) rows = [<li key="none" className="px-3 py-2 text-body text-fg-muted">No past chats matched.</li>];
  } else if (first.call.name === 'ChatRead') {
    const chat = first.result && !first.result.isError ? parseChatRead(resultText(first.result)) : null;
    if (chat)
      rows = [
        <li key={chat.sessionId}>
          <Link to={SESSION_ROUTE[chat.mode]} params={{ sessionId: chat.sessionId }} className={ROW}>
            <span className="truncate text-fg">{chat.title}</span>
            <span className="truncate text-footnote text-fg-muted">Open this chat</span>
          </Link>
        </li>,
      ];
    else if (first.result?.isError) rows = [<li key="error" className="px-3 py-2 text-body text-danger-text">{resultText(first.result)}</li>];
  }

  return (
    <div className="flex flex-col">
      <Summary open={open} onToggle={() => setOpen((o) => !o)}>
        {running && <ThinkingDots />}
        <span className="truncate">{label}</span>
        {failed && !running && <span className="text-danger-text">· failed</span>}
      </Summary>
      {open && rows.length > 0 && <ul className="mt-2 overflow-hidden rounded-2xl inset-ring inset-ring-line">{rows}</ul>}
    </div>
  );
}
