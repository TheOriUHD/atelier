/**
 * Bash, BashOutput and KillShell over the session's runner shell. Each command is a fresh process: the cwd
 * carries over to the next command, exports, aliases and sourced files do not.
 */
import { RpcError, RunnerErrorCode } from '@atelier/protocol';
import { unescapeTags } from '../../prompts/escape.ts';
import { newId } from '../../util/ids.ts';
import type { Workspace } from '../../workspaces/workspace.ts';
import { textOutput, type DescribeContext, type Tool, type ToolContext } from '../types.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
/** Live output shown while a command runs; past this the person waits for the result. */
const MAX_STREAMED_CHARS = 1_000_000;

interface BashInput {
  command: string;
  timeout?: number;
  run_in_background?: boolean;
  description?: string;
}

/** Keeps the start and the end of long output, where commands usually say what happened. */
function clip(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const half = MAX_OUTPUT_CHARS / 2;
  return `${output.slice(0, half)}\n[... ${output.length - MAX_OUTPUT_CHARS} characters cut ...]\n${output.slice(-half)}`;
}

/** An ID the runner doesn't know: never started, or started before the runner (or the app) restarted. */
const gone = (e: unknown) => e instanceof RpcError && e.code === RunnerErrorCode.ShellRestarted;
const goneNote = (id: string) =>
  `${id} isn't running: background commands stop when the app or its runner restarts, and this ID is from before that (or was never started). Start the command again if it's still needed.`;

function body(output: string, empty: string): string {
  return clip(output).trimEnd() || empty;
}

/** Git procedures for Code sessions; they cost nothing in sessions without Bash or outside Code. */
const GIT = `Committing (only when the person asks):
1. In one message, run \`git status\`, \`git diff\` (staged and unstaged) and \`git log -n 10 --oneline\` to see the changes and how this repository words its commit messages.
2. Draft a message in that style: a one-line summary in the imperative that says why, and a body only when it helps. Choose the verb that fits: add for something new, fix for a bug, update for a change to existing behaviour.
3. Leave out files that probably hold secrets (\`.env\`, key files, credentials), and tell the person if they asked for them.
4. Stage files by name rather than with \`git add -A\` or \`git add .\`, commit with the message passed through a heredoc, then run \`git status\` to confirm.
5. If a pre-commit hook rejects the commit, nothing was committed: fix what it reported, stage again and make a new commit. Never use \`--no-verify\`, \`--no-gpg-sign\` or an amend to get past a hook.
6. Never change git config, never force-push to the default branch, never use interactive flags (\`-i\`), make no empty commits, and don't push unless asked.

Discarding work (at any time): \`reset --hard\`, \`checkout\` or \`restore\` of paths, \`clean -f\` or \`-fd\`, \`stash drop\` or \`clear\`, \`branch -D\` and rebasing pushed commits run only when the person explicitly asked for that outcome, after \`git status\`, with a sentence naming what will be lost. Prefer \`git stash push -m "<label>"\` or a work-in-progress commit to discarding.

Pull requests (only when the person asks):
1. In one message, check \`git status\`, whether the branch tracks a remote and is up to date, and the log and diff of \`<base>...HEAD\`.
2. Read every commit on the branch, not only the latest.
3. Write a title under 70 characters and a body with a short summary list and a test-plan checklist.
4. Create the branch and push it with \`-u\` when needed, run \`gh pr create\` with the body in a heredoc, and return the URL.
5. Use \`gh\` for other GitHub work too: issues, checks, and review comments through \`gh api\`.`;

function describeBash({ tier, mode, has }: DescribeContext): string {
  // What the file tools at hand do instead (a chat's sandbox has only Read, so writing files is Bash's job there).
  const fileTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write'].filter(has);
  const join = (verbs: (string | false)[]) => {
    const v = verbs.filter((x): x is string => !!x);
    return v.length > 1 ? `${v.slice(0, -1).join(', ')} or ${v.at(-1)}` : (v[0] ?? '');
  };
  const edits = has('Edit') || has('Write');
  const listed = join([has('Read') && 'read', (has('Glob') || has('Grep')) && 'search', edits && 'edit']);
  if (tier === 'compact') {
    const short = join([has('Read') && 'read', edits && 'edit']);
    return [
      'Runs a command in the shell and returns what it printed.',
      '- The current folder stays the same between calls and relative paths follow it, so prefer `(cd dir && cmd)` to a bare `cd`.',
      ...(has('BashOutput') ? ['- Use `run_in_background` for servers.'] : []),
      ...(short ? [`- Don't use it to ${short} files.`] : []),
      "- Commit only when asked. Never force-push or throw away uncommitted changes unless asked.",
    ].join('\n');
  }
  const lines = [
    'Runs a shell command in the workspace and returns its output (stdout and stderr together) and exit code.',
    "- The working directory persists between calls, but exported variables, aliases and `source` don't, so chain dependent steps with `&&`. Relative paths in a command resolve against that current directory, while the file tools always resolve them against the workspace root. Keep the shell at the root by using `(cd dir && cmd)` or a flag such as `git -C` or `npm --prefix` instead of a bare `cd`.",
    '- Quote paths that contain spaces. Avoid interactive programs and pass flags that make them non-interactive. Commands are stopped after 2 minutes unless you set `timeout` (up to 10 minutes).',
    ...(has('BashOutput') ? ["- Start servers, watchers and other long-running processes with `run_in_background`, then read their output with BashOutput and stop them with KillShell. Don't poll in sleep loops; check once when you need the result."] : []),
    `- Output longer than ${MAX_OUTPUT_CHARS.toLocaleString('en')} characters is cut in the middle.`,
    '- The person may not see command output, so repeat in your reply what matters.',
    listed
      ? `- Don't use it to ${listed} files (${fileTools.join(', ')} ${fileTools.length === 1 ? 'does' : 'do'} that), or to send messages to the person.`
      : "- Don't use it to send messages to the person.",
  ];
  return mode === 'code' ? `${lines.join('\n')}\n\n${GIT}` : lines.join('\n');
}

/** Told about commands started in the background and stopped by KillShell (the Background tasks pane). */
export interface BackgroundCommands {
  started(ctx: ToolContext, command: { execId: string; command: string; description?: string }): void;
  killed(ctx: ToolContext, execId: string): void;
}

export function createBashTools(workspace: Workspace, background?: BackgroundCommands): Tool[] {
  const { runner } = workspace;
  /** Last known cwd per shell; shells start at the workspace root. */
  const cwds = new Map<string, string>();
  /** How far BashOutput has read each background command. */
  const offsets = new Map<string, number>();

  const bash: Tool<BashInput> = {
    name: 'Bash',
    description: describeBash,
    compactExample: { command: '<command>', description: '<what it does>' },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run.' },
        timeout: {
          type: 'number',
          minimum: 1,
          description: `Milliseconds before the command is stopped (default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}).`,
        },
        run_in_background: {
          type: 'boolean',
          description: 'Start the command and return at once with an ID for BashOutput and KillShell. For servers and watchers.',
        },
        description: {
          type: 'string',
          description: "What the command achieves, in 5 to 10 words in the active voice, shown to the person (\"Run the unit tests\"). Don't repeat the command.",
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    readOnly: false,
    async run({ command: written, timeout, run_in_background, description }, ctx) {
      const command = unescapeTags(written);
      const shellId = await workspace.shellFor(ctx.sessionId);
      const timeoutMs = Math.min(Math.round(timeout ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
      if (run_in_background) {
        const { execId } = await runner.call(
          'shell.exec',
          { shellId, command, background: true, timeoutMs: timeout === undefined ? undefined : timeoutMs },
          { signal: ctx.signal },
        );
        background?.started(ctx, { execId, command, ...(description ? { description } : {}) });
        return textOutput(
          `Started in the background with ID ${execId}.\nRead its output with BashOutput and stop it with KillShell.`,
        );
      }

      const execId = newId();
      let streamed = 0;
      const off = runner.on('shell.output', (n) => {
        if (n.execId !== execId || streamed >= MAX_STREAMED_CHARS) return;
        streamed += n.chunk.length;
        ctx.emit({ type: 'tool_output', messageId: ctx.messageId, callId: ctx.callId, text: n.chunk });
      });
      const res = await runner
        .call('shell.exec', { shellId, command, timeoutMs, execId }, { signal: ctx.signal })
        .catch((e: unknown) => {
          if (ctx.signal.aborted) return null; // Stop: the runner killed the command
          throw e;
        })
        .finally(off);
      if (!res) return textOutput('The command was stopped before it finished.', true);
      const notes = [
        res.timedOut ? `Timed out after ${timeoutMs / 1000}s; the command was killed.` : `Exit code ${res.exitCode}.`,
      ];
      if (res.truncated) notes.push('The output was too long; its middle was dropped.');
      if (res.cwd !== (cwds.get(shellId) ?? workspace.root)) notes.push(`Working directory is now ${res.cwd}.`);
      cwds.set(shellId, res.cwd);
      return textOutput(
        `${body(res.output, '(no output)')}\n\n${notes.join('\n')}`,
        res.timedOut || res.exitCode !== 0,
      );
    },
  };

  const bashOutput: Tool<{ bash_id: string; filter?: string }> = {
    name: 'BashOutput',
    description: ({ tier }) =>
      [
        'Reads new output from a command started with Bash `run_in_background`: what it printed since the last call, and whether it is still running or its exit code.',
        ...(tier === 'compact' ? [] : ['- `filter` keeps only the lines that match a regular expression; the other lines are discarded.', "- Don't call it again and again in a tight loop."]),
      ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        bash_id: { type: 'string', description: 'The ID that Bash returned when it started the background command.' },
        filter: { type: 'string', description: 'A regular expression; only matching lines are returned.' },
      },
      required: ['bash_id'],
      additionalProperties: false,
    },
    readOnly: true,
    async run({ bash_id, filter }, ctx) {
      let re: RegExp | undefined;
      try {
        re = filter === undefined ? undefined : new RegExp(filter);
      } catch (e) {
        return textOutput(`Invalid filter: ${(e as Error).message}`, true);
      }
      const res = await runner
        .call('shell.read', { execId: bash_id, sinceOffset: offsets.get(bash_id) ?? 0 }, { signal: ctx.signal })
        .catch((e: unknown) => {
          if (gone(e)) return null;
          throw e;
        });
      if (!res) return textOutput(goneNote(bash_id), true);
      offsets.set(bash_id, res.offset);
      const output = re
        ? res.output
            .split('\n')
            .filter((line) => re.test(line))
            .join('\n')
        : res.output;
      const notes = [res.running ? 'Still running.' : `Exited with code ${res.exitCode}.`];
      if (res.truncated) notes.unshift('Some output before this was dropped.');
      return textOutput(`${body(output, '(no new output)')}\n\n${notes.join('\n')}`);
    },
  };

  const killShell: Tool<{ shell_id: string }> = {
    name: 'KillShell',
    description: ({ tier }) =>
      [
        'Stops a command started with Bash `run_in_background`, along with the processes it started.',
        ...(tier === 'compact' ? [] : ["- Stop servers you started once the task is done, unless the person wants them to keep running."]),
      ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { shell_id: { type: 'string', description: 'The ID that Bash returned when it started the background command.' } },
      required: ['shell_id'],
      additionalProperties: false,
    },
    readOnly: false,
    async run({ shell_id }, ctx) {
      const res = await runner.call('shell.kill', { execId: shell_id }, { signal: ctx.signal }).catch((e: unknown) => {
        if (gone(e)) return null;
        throw e;
      });
      if (!res) return textOutput(goneNote(shell_id));
      const { killed } = res;
      background?.killed(ctx, shell_id);
      return textOutput(killed ? `Killed ${shell_id}.` : `${shell_id} had already exited.`);
    },
  };

  return [bash, bashOutput, killShell];
}
