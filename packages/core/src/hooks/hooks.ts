/**
 * Claude Code hooks (ARCHITECTURE §8): shell commands that run at points of a turn. Each gets the event as JSON
 * on stdin and steers it through its exit code (2 blocks, with stderr as the reason) or JSON on stdout
 * (`decision`, `continue`, `hookSpecificOutput.permissionDecision`/`updatedInput`/`additionalContext`).
 * They run in the session's workspace through its runner, with CLAUDE_PROJECT_DIR set.
 */
import { HookCommand, type HookEvent, type HooksConfig } from '@atelier/protocol';
import type { Workspace } from '../workspaces/workspace.ts';

const DEFAULT_TIMEOUT_S = 60;
const MAX_CONTEXT_CHARS = 10_000;

export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: HookEvent;
  permission_mode: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  source?: 'startup' | 'resume' | 'compact';
  stop_hook_active?: boolean;
}

/** What the hooks of one event decided, combined. */
export interface HookOutcome {
  /** Exit code 2, `decision: "block"` or a `deny` decision: why. */
  block?: string;
  /** PreToolUse: deny beats ask beats allow. */
  permission?: 'allow' | 'ask' | 'deny';
  /** PreToolUse: the input the tool runs with instead. */
  updatedInput?: Record<string, unknown>;
  /** For the model: `additionalContext`, or plain stdout of UserPromptSubmit and SessionStart hooks. */
  context?: string;
  /** `continue: false`: end the turn and show this to the person. */
  stop?: string;
  /** Hooks that failed without blocking, for the person (and the log). */
  errors: string[];
}

/** The `command` hooks of `event` whose matcher fits the tool (matchers are regular expressions; empty or `*` match all). */
export function hooksFor(configs: HooksConfig[], event: HookEvent, toolName?: string): HookCommand[] {
  const out: HookCommand[] = [];
  for (const config of configs) {
    for (const group of config[event] ?? []) {
      if (toolName !== undefined && !matches(group.matcher, toolName)) continue;
      for (const hook of group.hooks) {
        const command = HookCommand.safeParse(hook);
        if (command.success) out.push(command.data);
      }
    }
  }
  return out;
}

function matches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/** Runs the hooks in parallel and combines what they decided. Stopping the turn stops them. */
export async function runHooks(ws: Workspace, hooks: HookCommand[], input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
  const results = await Promise.all(hooks.map((hook) => runOne(ws, hook, input, signal)));
  const outcome: HookOutcome = { errors: [] };
  const context: string[] = [];
  for (const r of results) {
    if (r.block) outcome.block = outcome.block ? `${outcome.block}\n${r.block}` : r.block;
    if (r.permission && rank(r.permission) > rank(outcome.permission)) outcome.permission = r.permission;
    if (r.updatedInput && !outcome.updatedInput) outcome.updatedInput = r.updatedInput;
    if (r.context) context.push(r.context);
    if (r.stop && !outcome.stop) outcome.stop = r.stop;
    outcome.errors.push(...r.errors);
  }
  if (context.length) outcome.context = context.join('\n').slice(0, MAX_CONTEXT_CHARS);
  return outcome;
}

const rank = (p: HookOutcome['permission']) => (p === 'deny' ? 3 : p === 'ask' ? 2 : p === 'allow' ? 1 : 0);

async function runOne(ws: Workspace, hook: HookCommand, input: HookInput, signal?: AbortSignal): Promise<HookOutcome> {
  const argv = ws.os === 'windows' ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', hook.command] : ['/bin/sh', '-c', hook.command];
  const exec = await ws.runner
    .call('proc.exec', {
      argv,
      cwd: ws.root,
      env: { CLAUDE_PROJECT_DIR: ws.root, ATELIER_PROJECT_DIR: ws.root },
      stdin: JSON.stringify(input),
      timeoutMs: (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
    }, signal ? { signal } : undefined)
    .catch((e: unknown) => ({ exitCode: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false, truncated: false }));
  if (signal?.aborted) return { errors: [] };
  if (exec.timedOut) return { errors: [`Hook timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_S}s: ${hook.command}`] };
  if (exec.exitCode === 2) return { block: exec.stderr.trim() || `Blocked by hook: ${hook.command}`, errors: [] };
  if (exec.exitCode !== 0) return { errors: [`Hook failed (exit ${exec.exitCode}): ${hook.command}${exec.stderr.trim() ? `\n${exec.stderr.trim()}` : ''}`] };
  return parseOutput(input.hook_event_name, exec.stdout.trim());
}

/** Exit code 0: JSON output steers the event; plain stdout is context where Claude Code treats it so. */
export function parseOutput(event: HookEvent, stdout: string): HookOutcome {
  let json: Record<string, unknown> | null = null;
  if (stdout.startsWith('{')) {
    try {
      json = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      // Not JSON after all: plain output.
    }
  }
  if (!json) return { ...((event === 'UserPromptSubmit' || event === 'SessionStart') && stdout ? { context: stdout } : {}), errors: [] };
  const specific = (typeof json.hookSpecificOutput === 'object' && json.hookSpecificOutput) || {};
  const { permissionDecision, permissionDecisionReason, updatedInput, additionalContext } = specific as Record<string, unknown>;
  const reason = typeof json.reason === 'string' ? json.reason : undefined;
  const out: HookOutcome = { errors: [] };
  if (json.continue === false) out.stop = typeof json.stopReason === 'string' ? json.stopReason : 'Stopped by a hook.';
  if (json.decision === 'block') out.block = reason ?? 'Blocked by a hook.';
  if (json.decision === 'approve') out.permission = 'allow';
  if (permissionDecision === 'allow' || permissionDecision === 'ask' || permissionDecision === 'deny') out.permission = permissionDecision;
  if (out.permission === 'deny') out.block = typeof permissionDecisionReason === 'string' ? permissionDecisionReason : (reason ?? 'Denied by a hook.');
  if (updatedInput && typeof updatedInput === 'object' && !Array.isArray(updatedInput)) out.updatedInput = updatedInput as Record<string, unknown>;
  if (typeof additionalContext === 'string' && additionalContext) out.context = additionalContext;
  return out;
}
