/**
 * `atelier -p "…"`: one turn without the screen, for scripts and CI. The reply's text goes to stdout (or JSON, or a
 * stream of JSON lines). Nobody is there to answer prompts: a permission is allowed only by a rule the session already
 * has or one given with `--allow` (`Bash(npm test *)`, `Edit`), else denied with a note the model reads; questions are
 * skipped and a plan is turned down. Exit codes: 0 done, 1 failed, 2 a usage limit was reached, 3 sign-in needed.
 */
import type { LiveSessionState } from '@atelier/client';
import type { Effort, Message, PermissionMode, PermissionRequest, WorkspaceSummary } from '@atelier/protocol';
import type { Connected } from '../connection/connect.ts';
import { describe } from '../connection/connect.ts';

export interface PrintOptions {
  conn: Connected;
  folder: WorkspaceSummary;
  prompt: string;
  format: 'text' | 'json' | 'stream-json';
  allow: string[];
  mode?: PermissionMode | undefined;
  model?: string | undefined;
  effort?: Effort | undefined;
  sessionId?: string | null | undefined;
}

const glob = (pattern: string, text: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(text);

/** Whether `--allow` patterns allow a call: `Tool`, or `Tool(pattern)` against its command, path or address. */
export function allowedBy(patterns: readonly string[], req: Pick<PermissionRequest, 'toolName' | 'input'>): boolean {
  const input = (req.input ?? {}) as Record<string, unknown>;
  const subject = String(input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? '');
  return patterns.some((p) => {
    const m = /^([\w:*-]+)(?:\((.*)\))?$/.exec(p.trim());
    if (!m) return false;
    const tool = m[1]!;
    const sameTool = tool === req.toolName || (tool === 'Edit' && req.toolName === 'Write') || glob(tool, req.toolName);
    if (!sameTool) return false;
    if (m[2] === undefined) return true;
    const arg = m[2].replace(/:\*$/, ' *');
    return glob(arg, subject) || (arg.endsWith(' *') && subject === arg.slice(0, -2));
  });
}

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');

export async function runPrint(o: PrintOptions): Promise<number> {
  const { conn } = o;
  const sessionId =
    o.sessionId ??
    (
      await conn.rpc.call('sessions.create', {
        mode: 'code',
        workspaceId: o.folder.id,
        ...(o.model ? { model: o.model } : {}),
        ...(o.effort ? { effort: o.effort } : {}),
        ...(o.mode ? { permissionMode: o.mode } : {}),
      })
    ).id;
  const store = conn.live.store(sessionId);
  conn.live.retain(sessionId);
  const out = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`);
  if (o.format === 'stream-json') {
    out({ type: 'start', session_id: sessionId });
    conn.rpc.on('session.event', ({ sessionId: id, event }) => id === sessionId && out({ type: 'event', event }));
  }
  const answered = new Set<string>();
  const started = Date.now();
  let sent = false;
  const result = await new Promise<LiveSessionState>((resolve, reject) => {
    const check = () => {
      const s = store.getState();
      if (s.status === 'error') return reject(new Error(s.error ?? 'The session failed.'));
      if (s.status !== 'ready') return;
      if (!sent) {
        sent = true;
        void conn.rpc.call('chat.send', { sessionId, parts: [{ type: 'text', text: o.prompt }] }).catch(reject);
        return;
      }
      const p = s.pending;
      if (p && !answered.has(p.id)) {
        answered.add(p.id);
        const answer =
          p.kind === 'question'
            ? { answers: {} }
            : p.kind === 'elicitation'
              ? { action: 'decline' as const }
              : (p.payload as PermissionRequest).toolName === 'ExitPlanMode'
                ? { behavior: 'deny' as const, message: 'Running without a person: plans are not approved in print mode.' }
                : allowedBy(o.allow, p.payload as PermissionRequest)
                  ? { behavior: 'allow' as const }
                  : { behavior: 'deny' as const, message: `Nobody is here to approve this (atelier -p). Allow it with --allow '${(p.payload as PermissionRequest).suggestedRule || (p.payload as PermissionRequest).toolName}', or do without it.` };
        void conn.rpc.call('chat.respond', { sessionId, interactionId: p.id, answer }).catch(() => undefined);
      }
      const last = s.messages.at(-1);
      const userIndex = s.messages.findLastIndex((m) => m.role === 'user' && m.kind === 'normal');
      if (userIndex !== -1 && s.session && s.session.status !== 'running' && s.session.status !== 'waiting' && last && last.role === 'assistant' && last.stopReason) resolve(s);
    };
    store.subscribe(check);
    check();
  });
  const turn = result.messages.slice(result.messages.findLastIndex((m) => m.role === 'user' && m.kind === 'normal') + 1);
  const reply = turn.filter((m) => m.role === 'assistant');
  const last = reply.at(-1);
  const error = last?.error ?? null;
  const text = reply.map(textOf).filter(Boolean).join('\n\n');
  const usage = reply.reduce((u, m) => ({ input: u.input + (m.usage?.input ?? 0), output: u.output + (m.usage?.output ?? 0) }), { input: 0, output: 0 });
  const code = error ? (error.code === 'limit_reached' ? 2 : 1) : 0;
  if (o.format === 'text') {
    if (text) process.stdout.write(`${text}\n`);
    if (error) process.stderr.write(`${error.message}\n`);
  } else {
    const breakdown = await conn.rpc.call('chat.contextBreakdown', { sessionId }).catch(() => null);
    out({ type: 'result', session_id: sessionId, is_error: !!error, error: error?.message ?? null, result: text, duration_ms: Date.now() - started, usage, cost_usd: breakdown?.usage.costUsd ?? null, model: last?.model ?? null });
  }
  conn.live.release(sessionId);
  return code;
}

export { describe };
