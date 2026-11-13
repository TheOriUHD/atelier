/**
 * How each transcript row looks (ARCHITECTURE §25). Assistant text is a clay ◆ with markdown; a tool step a ● (green
 * when it worked, red when it failed, the paint dab while it runs) with the same words the app uses ("Read src/app.ts ·
 * 84 lines"), an edit's changed lines, a command's last lines of output, the task list. A gutter keeps wrapped lines
 * under their text.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { bashResult, displayPath, formatElapsed, placedEditRows, resultText, shownCall, summarize, writeRows, type DiffRow } from '@atelier/client';
import { studioPast } from '../art/words.ts';
import type { Todo, ToolCallPart, ToolResultPart } from '@atelier/protocol';
import { strip, type Paint } from '../style.ts';
import { renderMarkdown } from './markdown.ts';
import type { Row } from './rows.ts';
import { highlightLine, langOf } from './highlight.ts';

export type TranscriptView = 'normal' | 'thinking' | 'verbose';

export interface ViewContext {
  paint: Paint;
  columns: number;
  root: string | null;
  view: TranscriptView;
  /** How the person sees the rest of a step or a thought: a click (the fullscreen view with the mouse), or Ctrl+O. */
  reveal: 'click' | 'keys';
}

/** The hint after something cut short: "click to show", or the Ctrl+O presses that get there from this view. */
export function revealHint(ctx: ViewContext, what: 'thinking' | 'step'): string {
  if (ctx.reveal === 'click') return 'click to show';
  return what === 'thinking' || ctx.view === 'thinking' ? 'ctrl+o to show' : 'ctrl+o twice to show';
}

/** A gutter of fixed width with the body beside it, wrapping under itself. */
export function Gutter({ mark, children, width = 2 }: { mark: string; children: ReactNode; width?: number }) {
  return (
    <Box flexDirection="row">
      <Box width={width} flexShrink={0}>
        <Text>{mark}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const tail = (text: string, n: number) => text.replace(/\n+$/, '').split('\n').slice(-n);

/** Diff rows as coloured, numbered lines; at most `limit`, then how many more (and how to see them, given `hint`). */
export function diffLines(rows: DiffRow[], paint: Paint, limit: number, language = '', hint = ''): string[] {
  const lang = langOf(language);
  const shown = rows.slice(0, limit);
  const numberWidth = Math.max(2, ...shown.map((r) => String(r.line ?? '').length));
  const out = shown.map((r) => {
    const n = String(r.line ?? '').padStart(numberWidth);
    if (r.kind === 'hunk') return paint.fg('faint', `${' '.repeat(numberWidth)}   ${r.text}`);
    const sign = r.kind === 'add' ? '+' : r.kind === 'remove' ? '-' : ' ';
    const code = r.kind === 'context' ? highlightLine(r.text, lang, paint) : r.text;
    const body = `${n} ${sign} ${code}`;
    return r.kind === 'add' ? paint.bg(paint.p.addedBg, paint.fg('added', `${n} ${sign} `) + code) : r.kind === 'remove' ? paint.bg(paint.p.removedBg, paint.fg('removed', `${n} ${sign} `) + code) : paint.fg('muted', body.slice(0, n.length + 3)) + code;
  });
  if (rows.length > limit) out.push(paint.fg('muted', `… ${rows.length - limit} more ${rows.length - limit === 1 ? 'line' : 'lines'}${hint ? ` · ${hint}` : ''}`));
  return out;
}

export function todoLines(todos: Todo[], paint: Paint): string[] {
  return todos.map((t) =>
    t.status === 'completed' ? `${paint.fg('good', '☒')} ${paint.fg('muted', `\x1b[9m${t.content}\x1b[29m`)}` : t.status === 'in_progress' ? `${paint.fg('accent', '◐')} ${paint.bold(t.activeForm || t.content)}` : `${paint.fg('muted', '☐')} ${t.content}`,
  );
}

const languageOf = (path: string) => path.slice(path.lastIndexOf('.') + 1);

/**
 * What a tool step shows under its line: changed lines, output, the plan, the task list. In full (the verbose view, or
 * the step opened with a click) the whole of it; otherwise a short part and how to see the rest.
 */
function toolDetail(call: ToolCallPart, result: ToolResultPart | undefined, ctx: ViewContext, output?: string, open = false): string[] {
  const { paint } = ctx;
  const full = ctx.view === 'verbose' || open;
  const hint = full ? '' : revealHint(ctx, 'step');
  const input = asRecord(call.input);
  const text = result ? resultText(result) : '';
  if (result?.isError) {
    const lines = text.split('\n').filter(Boolean);
    return [paint.fg('bad', lines[0] ?? 'Failed'), ...(full ? lines.slice(1, 200).map((l) => paint.fg('muted', l)) : [])];
  }
  switch (call.name) {
    case 'Edit':
      return diffLines(placedEditRows(str(input.old_string), str(input.new_string), result?.edit), paint, full ? 2000 : 40, languageOf(str(input.file_path)), hint);
    case 'Write': {
      const rows = writeRows(str(input.content));
      return full ? diffLines(rows, paint, 2000, languageOf(str(input.file_path))) : [paint.fg('muted', `${rows.length} ${rows.length === 1 ? 'line' : 'lines'} · ${hint}`)];
    }
    case 'Bash': {
      const running = !result;
      const shown = running ? (output ?? '') : bashResult(text).output;
      const { exitCode, note } = running ? { exitCode: null, note: null } : bashResult(text);
      const all = shown.replace(/\n+$/, '').split('\n');
      const lines = full ? all.slice(-2000) : tail(shown, running ? 5 : exitCode ? 6 : 3);
      const body = shown.trim() ? lines.map((l) => paint.fg('muted', l)) : [];
      // The lines above the last few, when there are any and the step is done.
      if (!full && !running && shown.trim() && all.length > lines.length) body.unshift(paint.fg('faint', `… ${all.length - lines.length} more ${all.length - lines.length === 1 ? 'line' : 'lines'} above · ${hint}`));
      if (exitCode) body.push(paint.fg('bad', `Exit code ${exitCode}`));
      if (note) body.push(paint.fg('warn', note));
      return body;
    }
    case 'TodoWrite':
      return todoLines((input.todos ?? []) as Todo[], paint);
    case 'ExitPlanMode':
      return renderMarkdown(str(input.plan), paint, ctx.columns - 6)
        .split('\n')
        .map((l) => `${paint.fg('faint', '│')} ${l}`);
    case 'Agent':
    case 'AskUser':
      return text ? tail(text, full ? 200 : 2).map((l) => paint.fg('muted', l)) : [];
    default: {
      // Read, Glob, Grep, the web and the rest: what came back, only in full.
      if (!full || !text) return [];
      const lines = text.split('\n');
      const limit = open ? 400 : 30;
      return [...lines.slice(0, limit).map((l) => paint.fg('muted', l)), ...(lines.length > limit ? [paint.fg('faint', `… ${lines.length - limit} more lines`)] : [])];
    }
  }
}

/** The step's one line: "Read src/app.ts · 84 lines", with "Edited", "Created" for file changes. */
export function toolLine(call: ToolCallPart, result: ToolResultPart | undefined, ctx: ViewContext): string {
  const { paint } = ctx;
  // A Read of a folder says it listed the folder; one that brought an image, that it looked at it.
  const s = summarize(shownCall({ call, result }), result ? resultText(result) : null, ctx.root);
  const input = asRecord(call.input);
  let verb = s.verb;
  let meta = s.meta;
  if (call.name === 'Edit' || call.name === 'Write') {
    verb = call.name === 'Write' ? (result ? 'Created' : 'Creating') : result ? 'Edited' : 'Editing';
    const rows = call.name === 'Edit' ? placedEditRows(str(input.old_string), str(input.new_string), result?.edit) : writeRows(str(input.content));
    const added = rows.filter((r) => r.kind === 'add').length;
    const removed = rows.filter((r) => r.kind === 'remove').length;
    meta = `${paint.fg('added', `+${added}`)} ${paint.fg('removed', `−${removed}`)}`;
  }
  if (call.name.startsWith('mcp__')) {
    const [, server, tool] = call.name.split('__');
    verb = `${server} › ${tool}`;
  }
  const target = s.target ? ` ${call.name === 'Bash' ? paint.fg('secondary', s.target) : s.target}` : '';
  return `${paint.bold(verb)}${target}${meta ? paint.fg('muted', ` · `) + (strip(meta) === meta ? paint.fg('muted', meta) : meta) : ''}`;
}

export function ToolRow({ call, result, ctx, running, output, dab, open }: { call: ToolCallPart; result: ToolResultPart | undefined; ctx: ViewContext; running?: boolean; output?: string; dab?: string; open?: boolean }) {
  const { paint } = ctx;
  const denied = !!result?.isError && /denied|didn’t allow|did not allow|declined/i.test(resultText(result).slice(0, 200));
  const mark = running ? paint.fg('accent', dab ?? '●') : !result ? paint.fg('muted', '○') : denied ? paint.fg('warn', '●') : result.isError ? paint.fg('bad', '●') : paint.fg('good', '●');
  const detail = toolDetail(call, result, ctx, output, open);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Gutter mark={mark}>
        <Text>{toolLine(call, result, ctx)}</Text>
      </Gutter>
      {detail.length > 0 && (
        <Gutter mark={paint.fg('faint', '⎿ ')} width={4}>
          <Text>{detail.join('\n')}</Text>
        </Gutter>
      )}
    </Box>
  );
}

export function TextRow({ text, ctx }: { text: string; ctx: ViewContext }) {
  return (
    <Box marginBottom={1}>
      <Gutter mark={ctx.paint.fg('accent', '◆')}>
        <Text>{renderMarkdown(text, ctx.paint, ctx.columns - 4)}</Text>
      </Gutter>
    </Box>
  );
}

/** A thought: one line in the short view ("∴ Thought for 4s · click to show"), its text with thinking shown or opened. */
export function ThinkingRow({ text, seconds, ctx, live, open }: { text: string; seconds: number | null; ctx: ViewContext; live?: boolean; open?: boolean }) {
  const { paint, view } = ctx;
  const head = live ? 'Thinking…' : seconds ? `Thought for ${seconds}s` : 'Thought';
  const body = text.trim();
  if (view === 'normal' && !open) return live ? null : <Text>{paint.fg('muted', paint.italic(`∴ ${head}`)) + (body ? paint.fg('faint', ` · ${revealHint(ctx, 'thinking')}`) : '')}</Text>;
  const hide = view === 'normal' && ctx.reveal === 'click' ? paint.fg('faint', ' · click to hide') : '';
  return (
    <Box marginBottom={1}>
      <Gutter mark={paint.fg('muted', '∴')}>
        <Text>{paint.fg('muted', paint.italic(head)) + hide + (body ? `\n${paint.fg('muted', paint.italic(body))}` : '')}</Text>
      </Gutter>
    </Box>
  );
}

export function UserRow({ text, attachments, ctx }: { text: string; attachments: string[]; ctx: ViewContext }) {
  const { paint } = ctx;
  const files = attachments.length ? paint.fg('muted', ` [${attachments.map((a) => (a === 'image' ? 'image' : a)).join(', ')}]`) : '';
  return (
    <Box marginBottom={1}>
      <Gutter mark={paint.fg('accent', '❯')}>
        <Text>{paint.fg('secondary', text) + files}</Text>
      </Gutter>
    </Box>
  );
}

/** Any row that is done; `open` when a click opened it. */
export function RowView({ row, ctx, open }: { row: Row; ctx: ViewContext; open?: boolean }) {
  const { paint } = ctx;
  switch (row.kind) {
    case 'user':
      return <UserRow text={row.text} attachments={row.attachments} ctx={ctx} />;
    case 'text':
      return <TextRow text={row.text} ctx={ctx} />;
    case 'thinking':
      return <ThinkingRow text={row.text} seconds={row.seconds} ctx={ctx} open={open} />;
    case 'tool':
      return <ToolRow call={row.call} result={row.result} ctx={ctx} open={open} />;
    case 'notice':
      return (
        <Box marginBottom={1}>
          <Text>{paint.fg('muted', `  ⎿ ${row.text}`)}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Gutter mark={paint.fg('bad', '✗')}>
            <Text>{paint.fg('bad', row.text)}</Text>
          </Gutter>
          {row.fix && <Text>{paint.fg('muted', `  Fix: ${row.fix}`)}</Text>}
        </Box>
      );
    case 'local':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>{row.lines.join('\n')}</Text>
        </Box>
      );
    case 'turn':
      return (
        <Box marginBottom={1}>
          <Text>{paint.fg('muted', turnLine(row.since, row.end, row.stopped))}</Text>
        </Box>
      );
  }
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Under a finished turn: "◉ Glazed for 29s · done 1:13 PM", the spinner's last word said as done. */
export function turnLine(since: number, end: number, stopped: boolean): string {
  const took = formatElapsed(end - since);
  const at = clock.format(end);
  return stopped ? `◉ Stopped after ${took} · ${at}` : `◉ ${studioPast(since, end)} for ${took} · done ${at}`;
}

export const shortPath = (path: string, home = process.env.HOME ?? process.env.USERPROFILE ?? '') => (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) ? `~${path.slice(home.length)}` : path);
export { displayPath };
