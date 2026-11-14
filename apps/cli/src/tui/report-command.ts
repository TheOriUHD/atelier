/**
 * `/bug` and `/feature` (ARCHITECTURE §26): an issue report or a feature request from the terminal, to the Atelier
 * developer. The text after the command is the report; its first sentence (or line) is the title. `--chat` attaches
 * this session; `/bug` attaches diagnostics unless `--no-diagnostics`, `/feature` only with `--diagnostics`. The same
 * redaction applies as in the app: no keys, passwords or personal details.
 */
import { backendSystem } from '@atelier/core/device';
import { reportTextProblem, type ReportDiagnostics, type ReportKind } from '@atelier/protocol';
import { VERSION } from '../runtime.ts';
import type { Command, CommandContext } from './commands.ts';

/** The flags, and the text that is left. */
export function parseReportArgs(args: string): { text: string; chat: boolean; diagnostics: boolean | null } {
  let chat = false;
  let diagnostics: boolean | null = null;
  const text = args
    .replace(/(^|\s)--(chat|diagnostics|no-diagnostics)(?=\s|$)/g, (_m, lead: string, flag: string) => {
      if (flag === 'chat') chat = true;
      else diagnostics = flag === 'diagnostics';
      return lead;
    })
    .trim();
  return { text, chat, diagnostics };
}

/** The title: the first line, or its first sentence, at most 120 characters. */
export function titleOf(text: string): string {
  const line = text.split('\n')[0]!.trim();
  const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}…` : sentence;
}

async function send(ctx: CommandContext, kind: ReportKind, args: string): Promise<void> {
  const { paint, conn } = ctx;
  const { text, chat, diagnostics } = parseReportArgs(args);
  const usage = kind === 'issue' ? '/bug [--chat] [--no-diagnostics] <what happened, and what you expected>' : '/feature [--chat] [--diagnostics] <what you would like, and how you would use it>';
  if (!text) return ctx.print([paint.fg('muted', `Usage: ${usage}`), paint.fg('muted', 'It goes to the Atelier developer. Keys and passwords are never sent.')]);
  const title = titleOf(text);
  const problem = reportTextProblem('title', title) ?? reportTextProblem('description', text);
  if (problem) return ctx.print(paint.fg('warn', problem));
  const withDiagnostics = diagnostics ?? kind === 'issue';
  if (chat && !ctx.sessionId) return ctx.print(paint.fg('warn', 'There is no conversation here yet to attach. Send without --chat, or after a message.'));
  ctx.print(paint.fg('muted', `Sending${withDiagnostics ? ' with diagnostics' : ''}${chat ? ' and this conversation' : ''}…`));
  try {
    const prepared = withDiagnostics || chat ? await conn.rpc.call('reports.prepare', { kind, diagnostics: withDiagnostics, chatSessionId: chat ? ctx.sessionId : null }) : { diagnostics: null, chat: null };
    const client = withDiagnostics ? await backendSystem(process.cwd()).catch(() => undefined) : undefined;
    const diag: ReportDiagnostics | null = prepared.diagnostics
      ? { ...prepared.diagnostics, ...(client ? { client } : {}), notes: { terminal: `${process.env.TERM_PROGRAM ?? process.env.TERM ?? 'unknown'}, ${ctx.columns} columns${ctx.fullscreen ? ', fullscreen' : ''}`.slice(0, 400) } }
      : null;
    const info = await conn.rpc.call('app.info', {}).catch(() => null);
    const receipt = await conn.rpc.call('reports.submit', {
      kind,
      title,
      description: text,
      app: { version: VERSION, surface: 'cli', mode: 'cli', ...(conn.mode === 'server' && info ? { serverVersion: info.version } : {}) },
      diagnostics: diag,
      chat: prepared.chat,
      screenshots: [],
    });
    ctx.print(`${kind === 'issue' ? 'Report' : 'Request'} sent: ${paint.bold(receipt.id)}. Thank you. Mention it if you write about this anywhere else.`);
  } catch (e) {
    ctx.print(paint.fg('bad', e instanceof Error ? e.message : String(e)));
  }
}

export const REPORT_COMMANDS: Command[] = [
  {
    name: 'bug',
    description: 'Report an issue to the Atelier developer (with diagnostics; --chat adds this conversation)',
    argumentHint: '[--chat] <what happened>',
    aliases: ['report'],
    run: (ctx, args) => send(ctx, 'issue', args),
  },
  {
    name: 'feature',
    description: 'Request a feature from the Atelier developer (--diagnostics, --chat to attach them)',
    argumentHint: '[--chat] <what you would like>',
    run: (ctx, args) => send(ctx, 'feature', args),
  },
];
