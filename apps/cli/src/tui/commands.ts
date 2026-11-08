/**
 * The terminal's own slash commands (ARCHITECTURE §25). Skills and commands from the backend (`slash.list`) are sent
 * as text and expanded there; these run here, through the same RPC calls the app's buttons make.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatTokenCount, type LiveSessionState } from '@atelier/client';
import { parseLoopCommand, type Effort, type Message, type ModelInfo, type PermissionMode, type WorkspaceSummary } from '@atelier/protocol';
import type { CliConfig } from '../config.ts';
import type { Connected } from '../connection/connect.ts';
import { describe } from '../connection/connect.ts';
import type { CliPaths } from '../paths.ts';
import { VERSION } from '../runtime.ts';
import type { Paint } from '../style.ts';
import { copy, openUrl } from '../term.ts';
import { EFFORT_WORDS, findModel, MODE_WORDS, modeFrom } from './session.ts';
import { todoLines, type TranscriptView } from './views.tsx';

export type Overlay = { kind: 'model' } | { kind: 'effort' } | { kind: 'resume' } | { kind: 'rewind' } | { kind: 'config' } | { kind: 'mode' } | { kind: 'theme' };
export type AppExit = { kind: 'quit'; keepRunning?: boolean } | { kind: 'setup'; step: 'login' | 'connect' | 'all' } | { kind: 'logout' };

export interface CommandContext {
  conn: Connected;
  paths: CliPaths;
  paint: Paint;
  columns: number;
  folder: WorkspaceSummary;
  config: CliConfig;
  models: ModelInfo[];
  sessionId: string | null;
  live(): LiveSessionState | null;
  model(): ModelInfo | undefined;
  ensureSession(): Promise<string>;
  print(lines: string | string[]): void;
  send(text: string): Promise<void>;
  newSession(): void;
  switchTo(sessionId: string): void;
  open(overlay: Overlay): void;
  setMode(mode: PermissionMode): Promise<void>;
  setModel(model: ModelInfo): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  setView(view: TranscriptView): void;
  saveConfig(change: (c: CliConfig) => CliConfig): Promise<void>;
  exit(next: AppExit): void;
}

export interface Command {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  /** Left out of /help and the menu (still runs). */
  hidden?: boolean;
  run(ctx: CommandContext, args: string): Promise<void> | void;
}

const bar = (paint: Paint, share: number, width = 30) => {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * width);
  return paint.fg(share >= 0.8 ? 'warn' : 'accent', '█'.repeat(filled)) + paint.fg('faint', '░'.repeat(width - filled));
};

const money = (usd: number | null) => (usd === null ? 'no price' : usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`);

export function transcriptMarkdown(messages: Message[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'user' && m.kind === 'normal') {
      const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
      if (text) out.push(`## You\n\n${text}\n`);
    } else if (m.role === 'assistant') {
      const text = m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : p.type === 'tool_call' ? [`- \`${p.name}\` ${JSON.stringify(p.input).slice(0, 200)}`] : [])).join('\n\n');
      if (text) out.push(`## Atelier${m.model ? ` (${m.model})` : ''}\n\n${text}\n`);
    }
  }
  return out.join('\n');
}

const INIT_PROMPT = `Look through this repository and write an AGENTS.md at its root for coding agents: what the project is, how it is laid out, how to build, test and lint it (the exact commands), its conventions, and anything a newcomer would trip over. Keep it short and specific to this repository; if an AGENTS.md or CLAUDE.md is already there, improve it instead of starting over.`;
const REVIEW_PROMPT = `Review the changes in this repository that aren't committed yet (and the commits on this branch not on its base, if any): look for bugs, missed cases, security problems and code that could be simpler. List what you find, most important first, with the file and line; say plainly when something is fine.`;

export const COMMANDS: Command[] = [
  {
    name: 'help',
    description: 'What you can type and press',
    aliases: ['?'],
    run: (ctx) => {
      const { paint } = ctx;
      const rows = COMMANDS.filter((c) => !c.hidden).map((c) => `  ${paint.fg('accent', `/${c.name}`.padEnd(16))}${c.argumentHint ? paint.fg('muted', `${c.argumentHint} `) : ''}${c.description}`);
      const keys = [
        ['Enter', 'send (while a reply runs: it waits its turn)'],
        ['Ctrl+S', 'send into the reply that is running'],
        ['Shift+Enter, Alt+Enter, Ctrl+J', 'new line'],
        ['Esc', 'stop the reply · twice: go back to an earlier message'],
        ['Shift+Tab', 'Auto → Ask → Accept edits → Plan'],
        ['Ctrl+O', 'show thinking, then every step in full'],
        ['Ctrl+T', 'show or hide the task list'],
        ['Ctrl+R', 'search what you sent before'],
        ['Ctrl+G', 'write the message in your editor'],
        ['Ctrl+V', 'paste an image'],
        ['@', 'a file in this folder'],
        ['!', 'run a command here; its output goes with your next message'],
        ['Ctrl+C twice, Ctrl+D', 'quit'],
      ].map(([k, v]) => `  ${paint.fg('accent', k!.padEnd(32))}${v}`);
      ctx.print([paint.bold('Commands'), ...rows, '', paint.bold('Keys'), ...keys]);
    },
  },
  { name: 'clear', description: 'Start a new session (this one stays in /resume)', aliases: ['new', 'reset'], run: (ctx) => ctx.newSession() },
  { name: 'resume', description: 'Open another session, also from the browser or the app', run: (ctx) => ctx.open({ kind: 'resume' }) },
  {
    name: 'model',
    description: 'Choose the model',
    argumentHint: '[name]',
    run: async (ctx, args) => {
      if (!args.trim()) return ctx.open({ kind: 'model' });
      const found = findModel(ctx.models, args);
      if (!found) return ctx.print(ctx.paint.fg('bad', `No model matches “${args.trim()}”. /model lists them.`));
      await ctx.setModel(found);
    },
  },
  {
    name: 'effort',
    description: 'How hard the model thinks',
    argumentHint: '[low|medium|high|extra|max]',
    run: async (ctx, args) => {
      const w = args.trim().toLowerCase();
      if (!w) return ctx.open({ kind: 'effort' });
      const effort = (Object.entries(EFFORT_WORDS).find(([k, v]) => k === w || v.toLowerCase() === w)?.[0] ?? null) as Effort | null;
      if (!effort) return ctx.print(ctx.paint.fg('bad', `“${w}” isn’t an effort. Try low, medium, high, extra or max.`));
      await ctx.setEffort(effort);
    },
  },
  {
    name: 'mode',
    description: 'Auto, Ask, Accept edits, Plan or Bypass',
    argumentHint: '[mode]',
    run: async (ctx, args) => {
      if (!args.trim()) return ctx.open({ kind: 'mode' });
      const mode = modeFrom(args);
      if (!mode) return ctx.print(ctx.paint.fg('bad', `“${args.trim()}” isn’t a mode: auto, ask, accept, plan or bypass.`));
      await ctx.setMode(mode);
    },
  },
  { name: 'plan', description: 'Plan first, change nothing until you approve', run: (ctx) => ctx.setMode('plan') },
  {
    name: 'compact',
    description: 'Summarize the conversation to make room',
    argumentHint: '[what to keep]',
    run: async (ctx, args) => {
      if (!ctx.sessionId) return ctx.print(ctx.paint.fg('muted', 'Nothing to compact yet.'));
      await ctx.conn.rpc.call('chat.compact', { sessionId: ctx.sessionId, ...(args.trim() ? { focus: args.trim() } : {}) });
    },
  },
  {
    name: 'context',
    description: 'How full the context window is',
    run: async (ctx) => {
      const { paint } = ctx;
      if (!ctx.sessionId) return ctx.print(paint.fg('muted', 'Send a message first: the context is measured for a session.'));
      const { context } = await ctx.conn.rpc.call('chat.contextBreakdown', { sessionId: ctx.sessionId });
      if (!context) return ctx.print(paint.fg('muted', 'Not measured yet: it is after the first reply.'));
      const c = context.categories;
      const row = (name: string, n: number) => `  ${name.padEnd(16)}${paint.fg('secondary', formatTokenCount(n).padStart(7))}`;
      ctx.print([
        `${paint.bold('Context')}  ${bar(paint, context.used / context.limit)}  ${formatTokenCount(context.used)} of ${formatTokenCount(context.limit)} (${Math.round((context.used / context.limit) * 100)}%)`,
        row('System prompt', c.systemPrompt),
        row('Tools', c.systemTools),
        row('Connectors', c.mcpTools),
        row('Skills', c.skills),
        row('Messages', c.messages),
        paint.fg('muted', `  Compacts by itself above ${formatTokenCount(context.threshold)}. /compact does it now.`),
      ]);
    },
  },
  {
    name: 'cost',
    description: 'What this session used, and your limits',
    aliases: ['usage'],
    run: async (ctx) => {
      const { paint } = ctx;
      const lines: string[] = [];
      if (ctx.sessionId) {
        const { usage } = await ctx.conn.rpc.call('chat.contextBreakdown', { sessionId: ctx.sessionId });
        lines.push(
          paint.bold('This session'),
          `  ${usage.requests} requests · ${formatTokenCount(usage.input)} in · ${formatTokenCount(usage.output)} out · ${formatTokenCount(usage.cacheRead)} from cache · ${money(usage.costUsd)}${usage.tokensPerSecond ? ` · ${Math.round(usage.tokensPerSecond)} tokens/s` : ''}`,
        );
      }
      const limits = await ctx.conn.rpc.call('limits.mine', {}).catch(() => null);
      if (limits && !limits.exempt && limits.rows.length) {
        const words: Record<string, string> = { tokensDay: 'Tokens today', tokens30d: 'Tokens, 30 days', costDay: 'Cost today', cost30d: 'Cost, 30 days', requestsHour: 'Requests, last hour' };
        lines.push('', paint.bold('Your limits'), ...limits.rows.map((r) => `  ${(words[r.key] ?? r.key).padEnd(22)}${bar(paint, r.used / r.max, 20)} ${r.key.startsWith('cost') ? `${money(r.used)} of ${money(r.max)}` : `${formatTokenCount(r.used)} of ${formatTokenCount(r.max)}`}${r.reached ? paint.fg('bad', ' reached') : ''}`));
      }
      ctx.print(lines.length ? lines : paint.fg('muted', 'Nothing used yet.'));
    },
  },
  {
    name: 'status',
    description: 'Where this terminal is connected, as whom, and versions',
    run: async (ctx) => {
      const { paint, conn } = ctx;
      const info = await conn.rpc.call('app.info', {});
      const lines = [
        `${paint.bold('Atelier CLI')} ${VERSION}`,
        conn.mode === 'server' ? `  Server      ${conn.serverUrl} (Atelier ${info.version})` : `  Runs        on this computer (${ctx.paths.backendData})`,
        `  Signed in   ${conn.user.name} (${conn.user.username}${conn.user.role === 'admin' ? ', admin' : ''})`,
        `  Folder      ${ctx.folder.root}`,
        ...(conn.device ? [`  This device ${conn.device.name}`] : []),
        `  Model       ${ctx.model()?.displayName ?? 'none'}`,
      ];
      if (conn.service) {
        conn.service.send({ t: 'status' });
        const status = await new Promise<import('../daemon/wire.ts').ServiceStatus | null>((resolveStatus) => {
          const off = conn.service!.onFrame((f) => f.t === 'status' && (off(), resolveStatus(f.status)));
          setTimeout(() => (off(), resolveStatus(null)), 2000);
        });
        if (status) lines.push(`  Background  running since ${new Date(status.startedAt).toLocaleTimeString()}, ${status.clients} ${status.clients === 1 ? 'terminal' : 'terminals'}${status.link ? `, link ${status.link === 'online' ? 'up' : status.link}` : ''}`);
      }
      ctx.print(lines);
    },
  },
  {
    name: 'open',
    description: 'Open this session in the browser',
    run: (ctx) => {
      const { paint, conn } = ctx;
      if (conn.mode !== 'server' || !conn.serverUrl) return ctx.print(paint.fg('muted', 'Sessions on this computer only open here. Connect to a server (/connect) to pick them up anywhere.'));
      if (!ctx.sessionId) return ctx.print(paint.fg('muted', 'Send a message first.'));
      const url = `${conn.serverUrl}/#/code/${ctx.sessionId}`;
      ctx.print(openUrl(url) ? `Opened ${paint.fg('info', url)}` : `Open ${paint.fg('info', url)}`);
    },
  },
  { name: 'rewind', description: 'Go back to an earlier message (and the files as they were)', run: (ctx) => ctx.open({ kind: 'rewind' }) },
  {
    name: 'fork',
    description: 'Carry on in a copy of this session',
    run: async (ctx) => {
      if (!ctx.sessionId) return ctx.print(ctx.paint.fg('muted', 'Nothing to fork yet.'));
      const copy = await ctx.conn.rpc.call('sessions.fork', { id: ctx.sessionId });
      ctx.switchTo(copy.id);
    },
  },
  {
    name: 'btw',
    description: 'Ask on the side, without adding to this session',
    argumentHint: '<question>',
    run: async (ctx, args) => {
      if (!ctx.sessionId) return ctx.print(ctx.paint.fg('muted', 'Ask in the session first; /btw asks beside it.'));
      if (!args.trim()) return ctx.print(ctx.paint.fg('muted', 'Add the question: /btw what does this regex match?'));
      const side = await ctx.conn.rpc.call('sideChats.start', { sessionId: ctx.sessionId, question: args.trim() });
      ctx.print(ctx.paint.fg('muted', 'Asking on the side…'));
      const store = ctx.conn.live.store(side.id);
      ctx.conn.live.retain(side.id);
      const answer = await new Promise<string>((done) => {
        const check = () => {
          const s = store.getState();
          const reply = s.messages.findLast((m) => m.role === 'assistant');
          if (s.status === 'ready' && s.session?.status !== 'running' && reply?.stopReason) {
            off();
            done(reply.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n'));
          }
        };
        const off = store.subscribe(check);
        check();
      });
      ctx.conn.live.release(side.id);
      ctx.print([ctx.paint.fg('accentSoft', `btw · ${args.trim()}`), answer]);
    },
  },
  {
    name: 'loop',
    description: 'Send a prompt again and again',
    argumentHint: '[interval] <prompt> | stop',
    run: async (ctx, args) => {
      const cmd = parseLoopCommand(args);
      if (cmd.action === 'error') return ctx.print(ctx.paint.fg('bad', cmd.message));
      if (cmd.action === 'list') return ctx.print(ctx.paint.fg('muted', 'Running loops show in the task list (↓).'));
      const sessionId = await ctx.ensureSession();
      if (cmd.action === 'stop') await ctx.conn.rpc.call('loops.stop', { sessionId, target: cmd.target });
      else await ctx.conn.rpc.call('loops.start', { sessionId, prompt: cmd.prompt, intervalMs: cmd.intervalMs });
    },
  },
  {
    name: 'tasks',
    description: 'Commands and agents running in the background',
    run: (ctx) => {
      const tasks = ctx.live()?.tasks ?? [];
      if (!tasks.length) return ctx.print(ctx.paint.fg('muted', 'Nothing runs in the background.'));
      ctx.print(tasks.map((t) => `  ${t.status === 'running' ? ctx.paint.fg('accent', '●') : ctx.paint.fg('muted', '○')} ${ctx.paint.fg('muted', t.kind)} ${t.title}  ${ctx.paint.fg('muted', t.status)}`));
    },
  },
  {
    name: 'todos',
    description: 'The task list',
    run: (ctx) => {
      const todos = ctx.live()?.todos ?? [];
      ctx.print(todos.length ? todoLines(todos, ctx.paint) : ctx.paint.fg('muted', 'No task list yet.'));
    },
  },
  {
    name: 'export',
    description: 'Save the conversation as Markdown',
    argumentHint: '[file]',
    run: async (ctx, args) => {
      const messages = ctx.live()?.messages ?? [];
      if (!messages.length) return ctx.print(ctx.paint.fg('muted', 'Nothing to save yet.'));
      const file = resolve(args.trim() || `atelier-${(ctx.live()?.session?.title || 'session').replace(/[^\w-]+/g, '-').slice(0, 40)}.md`);
      await writeFile(file, transcriptMarkdown(messages));
      ctx.print(`Saved ${ctx.paint.fg('info', file)}`);
    },
  },
  {
    name: 'copy',
    description: 'Copy the last reply',
    run: (ctx) => {
      const reply = ctx.live()?.messages.findLast((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'text'));
      if (!reply) return ctx.print(ctx.paint.fg('muted', 'No reply to copy yet.'));
      copy(reply.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n\n'));
      ctx.print(ctx.paint.fg('muted', 'Copied the last reply.'));
    },
  },
  {
    name: 'permissions',
    description: 'Your “always allow” rules',
    argumentHint: '[add|remove <rule>]',
    run: async (ctx, args) => {
      const { paint, conn } = ctx;
      const [verb, ...rest] = args.trim().split(/\s+/);
      const rule = rest.join(' ');
      const prefs = await conn.rpc.call('prefs.get', {});
      const allow: string[] = (prefs as { permissions?: { allow?: string[] } }).permissions?.allow ?? [];
      if ((verb === 'add' || verb === 'remove') && rule) {
        const next = verb === 'add' ? [...new Set([...allow, rule])] : allow.filter((r) => r !== rule);
        await conn.rpc.call('prefs.set', { path: ['permissions', 'allow'], value: next });
        return ctx.print(`${verb === 'add' ? 'Allowed' : 'Removed'} ${paint.fg('accentSoft', rule)}`);
      }
      ctx.print([paint.bold('Always allowed, everywhere'), ...(allow.length ? allow.map((r) => `  ${r}`) : [paint.fg('muted', '  none')]), paint.fg('muted', 'Rules for this project are in .atelier/settings.local.json. /permissions add Bash(npm test *)')]);
    },
  },
  {
    name: 'mcp',
    description: 'Connectors and how they are doing',
    aliases: ['connectors'],
    run: async (ctx) => {
      const list = await ctx.conn.rpc.call('mcp.status', {});
      if (!list.length) return ctx.print(ctx.paint.fg('muted', 'No connectors yet.'));
      ctx.print(list.map((s) => `  ${s.state === 'ready' ? ctx.paint.fg('good', '●') : s.state === 'error' ? ctx.paint.fg('bad', '●') : ctx.paint.fg('muted', '○')} ${s.name}${s.personal ? ctx.paint.fg('muted', ' (yours)') : ''}  ${ctx.paint.fg('muted', s.state === 'ready' ? `${s.tools.length} tools` : (s.error ?? s.state))}`));
    },
  },
  {
    name: 'skills',
    description: 'Skills this session can use',
    run: async (ctx) => {
      const list = await ctx.conn.rpc.call('skills.list', { workspaceId: ctx.folder.id });
      if (!list.length) return ctx.print(ctx.paint.fg('muted', 'No skills yet.'));
      ctx.print(list.map((s) => `  ${ctx.paint.fg('accent', s.name)}  ${ctx.paint.fg('muted', (s.description ?? '').slice(0, 90))}`));
    },
  },
  { name: 'init', description: 'Write an AGENTS.md for this repository', run: (ctx) => ctx.send(INIT_PROMPT) },
  { name: 'review', description: 'Review the changes not committed yet', run: (ctx) => ctx.send(REVIEW_PROMPT) },
  { name: 'config', description: 'Look, notifications, editor, transcript', aliases: ['settings'], run: (ctx) => ctx.open({ kind: 'config' }) },
  { name: 'theme', description: 'Dark, light, plain', run: (ctx) => ctx.open({ kind: 'theme' }) },
  {
    name: 'statusline',
    description: 'A command whose output is the status line',
    argumentHint: '<command> | import | off',
    run: async (ctx, args) => {
      const a = args.trim();
      if (!a) return ctx.print(ctx.config.statusLine ? `Status line: ${ctx.config.statusLine.command}` : ctx.paint.fg('muted', 'No status line command. /statusline import copies Claude Code’s.'));
      if (a === 'off') return ctx.saveConfig((c) => ({ ...c, statusLine: undefined }));
      if (a === 'import') {
        const { readFile } = await import('node:fs/promises');
        const { homedir } = await import('node:os');
        const claude = await readFile(resolve(homedir(), '.claude/settings.json'), 'utf8').then((t) => JSON.parse(t) as { statusLine?: { command?: string } }, () => null);
        const command = claude?.statusLine?.command;
        if (!command) return ctx.print(ctx.paint.fg('muted', 'Claude Code has no status line command here.'));
        await ctx.saveConfig((c) => ({ ...c, statusLine: { command } }));
        return ctx.print(`Status line: ${command}`);
      }
      await ctx.saveConfig((c) => ({ ...c, statusLine: { command: a } }));
    },
  },
  {
    name: 'login',
    description: 'Sign in again (or as someone else)',
    run: (ctx) => ctx.exit({ kind: 'setup', step: 'login' }),
  },
  { name: 'logout', description: 'Sign this terminal out', run: (ctx) => ctx.exit({ kind: 'logout' }) },
  { name: 'connect', description: 'Connect to another server, or work on this computer only', run: (ctx) => ctx.exit({ kind: 'setup', step: 'connect' }) },
  { name: 'setup', description: 'Go through the setup again', run: (ctx) => ctx.exit({ kind: 'setup', step: 'all' }) },
  {
    name: 'doctor',
    description: 'Check that everything works',
    run: async (ctx) => {
      const { runChecks } = await import('../commands/doctor.ts');
      ctx.print(await runChecks(ctx.paths, ctx.paint));
    },
  },
  {
    name: 'bug',
    description: 'Copy what helps with a problem report',
    run: async (ctx) => {
      const info = await ctx.conn.rpc.call('app.info', {}).catch(() => null);
      const text = [`Atelier CLI ${VERSION} on ${process.platform} ${process.arch}, Node ${process.versions.node}`, `Backend: ${ctx.conn.mode}${info ? ` ${info.version}` : ''}`, `Model: ${ctx.model()?.ref ?? 'none'}`, `Session: ${ctx.sessionId ?? 'none'}`, `Logs: ${ctx.paths.logs}`].join('\n');
      copy(text);
      ctx.print([ctx.paint.fg('muted', 'Copied (no messages or keys):'), text]);
    },
  },
  { name: 'pip', description: 'Say hello to Pip', hidden: true, run: (ctx) => ctx.print('__pip__') },
  { name: 'quit', description: 'Leave (a running reply goes on in the background)', aliases: ['exit', 'q'], run: (ctx) => ctx.exit({ kind: 'quit' }) },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

export const MODE_LIST = Object.entries(MODE_WORDS) as [PermissionMode, string][];
export { describe };
