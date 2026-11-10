/**
 * How each transcript row looks (ARCHITECTURE §25). Assistant text is a clay ◆ with markdown; a tool step a ● (green
 * when it worked, red when it failed, the paint dab while it runs) with the same words the app uses ("Read src/app.ts ·
 * 84 lines"), an edit's changed lines, a command's last lines of output, the task list. A gutter keeps wrapped lines
 * under their text.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { bashResult, displayPath, placedEditRows, resultText, shownCall, summarize, writeRows, type DiffRow } from '@atelier/client';
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

/** Diff rows as coloured, numbered lines; at most `limit`, then how many more. */
export function diffLines(rows: DiffRow[], paint: Paint, limit: number, language = ''): string[] {
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
  if (rows.length > limit) out.push(paint.fg('muted', `… ${rows.length - limit} more ${rows.length - limit === 1 ? 'line' : 'lines'}`));
  return out;
}

export function todoLines(todos: Todo[], paint: Paint): string[] {
  return todos.map((t) =>
    t.status === 'completed' ? `${paint.fg('good', '☒')} ${paint.fg('muted', `\x1b[9m${t.content}\x1b[29m`)}` : t.status === 'in_progress' ? `${paint.fg('accent', '◐')} ${paint.bold(t.activeForm || t.content)}` : `${paint.fg('muted', '☐')} ${t.content}`,
  );
}

const languageOf = (path: string) => path.slice(path.lastIndexOf('.') + 1);

/** What a tool step shows under its line: changed lines, output, the plan, the task list. */
function toolDetail(call: ToolCallPart, result: ToolResultPart | undefined, ctx: ViewContext, output?: string): string[] {
  const { paint, view } = ctx;
  const input = asRecord(call.input);
  const text = result ? resultText(result) : '';
  if (result?.isError) {
    const lines = text.split('\n').filter(Boolean);
    return [paint.fg('bad', lines[0] ?? 'Failed'), ...(view === 'verbose' ? lines.slice(1, 20).map((l) => paint.fg('muted', l)) : [])];
  }
  switch (call.name) {
    case 'Edit':
      return diffLines(placedEditRows(str(input.old_string), str(input.new_string), result?.edit), paint, view === 'verbose' ? 400 : 40, languageOf(str(input.file_path)));
    case 'Write': {
      const rows = writeRows(str(input.content));
      return view === 'verbose' ? diffLines(rows, paint, 400, languageOf(str(input.file_path))) : [paint.fg('muted', `${rows.length} ${rows.length === 1 ? 'line' : 'lines'}`)];
    }
    case 'Bash': {
      const running = !result;
      const shown = running ? (output ?? '') : bashResult(text).output;
      const { exitCode, note } = running ? { exitCode: null, note: null } : bashResult(text);
      const lines = view === 'verbose' ? shown.replace(/\n+$/, '').split('\n').slice(-200) : tail(shown, running ? 5 : exitCode ? 6 : 3);
      const body = shown.trim() ? lines.map((l) => paint.fg('muted', l)) : [];
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
      return text ? tail(text, view === 'verbose' ? 40 : 2).map((l) => paint.fg('muted', l)) : [];
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
    case 'WebFetch':
      return view === 'verbose' && text ? text.split('\n').slice(0, 30).map((l) => paint.fg('muted', l)) : [];
    default:
      return view === 'verbose' && text ? text.split('\n').slice(0, 30).map((l) => paint.fg('muted', l)) : [];
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

export function ToolRow({ call, result, ctx, running, output, dab }: { call: ToolCallPart; result: ToolResultPart | undefined; ctx: ViewContext; running?: boolean; output?: string; dab?: string }) {
  const { paint } = ctx;
  const denied = !!result?.isError && /denied|didn’t allow|did not allow|declined/i.test(resultText(result).slice(0, 200));
  const mark = running ? paint.fg('accent', dab ?? '●') : !result ? paint.fg('muted', '○') : denied ? paint.fg('warn', '●') : result.isError ? paint.fg('bad', '●') : paint.fg('good', '●');
  const detail = toolDetail(call, result, ctx, output);
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

export function ThinkingRow({ text, seconds, ctx, live }: { text: string; seconds: number | null; ctx: ViewContext; live?: boolean }) {
  const { paint, view } = ctx;
  const head = live ? 'Thinking…' : seconds ? `Thought for ${seconds}s` : 'Thought';
  if (view === 'normal') return live ? null : <Text>{paint.fg('muted', paint.italic(`∴ ${head}`))}</Text>;
  return (
    <Box marginBottom={1}>
      <Gutter mark={paint.fg('muted', '∴')}>
        <Text>{paint.fg('muted', paint.italic(`${head}\n${text.trim()}`))}</Text>
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

/** Any row that is done. */
export function RowView({ row, ctx }: { row: Row; ctx: ViewContext }) {
  const { paint } = ctx;
  switch (row.kind) {
    case 'user':
      return <UserRow text={row.text} attachments={row.attachments} ctx={ctx} />;
    case 'text':
      return <TextRow text={row.text} ctx={ctx} />;
    case 'thinking':
      return <ThinkingRow text={row.text} seconds={row.seconds} ctx={ctx} />;
    case 'tool':
      return <ToolRow call={row.call} result={row.result} ctx={ctx} />;
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
  }
}

export const shortPath = (path: string, home = process.env.HOME ?? process.env.USERPROFILE ?? '') => (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) ? `~${path.slice(home.length)}` : path);
export { displayPath };
