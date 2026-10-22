import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../store/db.ts';
import { users } from '../store/schema.ts';
import { hostRunnerBinary } from '../workspaces/runner-client.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { WorkspaceManager } from '../workspaces/workspace-manager.ts';
import { hooksFor, parseOutput, runHooks, type HookInput } from './hooks.ts';

const command = (c: string) => ({ type: 'command', command: c });

describe('hooksFor', () => {
  it('picks command hooks whose matcher fits the tool', () => {
    const configs = [
      { PreToolUse: [{ matcher: 'Edit|Write', hooks: [command('fmt')] }, { matcher: 'Bash', hooks: [command('lint'), { type: 'prompt', prompt: 'x' }] }] },
      { PreToolUse: [{ hooks: [command('all')] }, { matcher: '*', hooks: [command('star')] }, { matcher: 'mcp__github__.*', hooks: [command('gh')] }, { matcher: '(', hooks: [command('bad')] }] },
    ];
    expect(hooksFor(configs, 'PreToolUse', 'Write').map((h) => h.command)).toEqual(['fmt', 'all', 'star']);
    expect(hooksFor(configs, 'PreToolUse', 'Bash').map((h) => h.command)).toEqual(['lint', 'all', 'star']);
    expect(hooksFor(configs, 'PreToolUse', 'mcp__github__list_prs').map((h) => h.command)).toEqual(['all', 'star', 'gh']);
    expect(hooksFor(configs, 'PreToolUse', '(').map((h) => h.command)).toEqual(['all', 'star', 'bad']);
    expect(hooksFor(configs, 'Stop')).toEqual([]);
  });
});

describe('parseOutput', () => {
  it('reads decisions, rewritten input and context', () => {
    expect(parseOutput('PreToolUse', JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no rm' } }))).toEqual({ permission: 'deny', block: 'no rm', errors: [] });
    expect(parseOutput('PreToolUse', JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { command: 'ls -a' } } }))).toEqual({ permission: 'allow', updatedInput: { command: 'ls -a' }, errors: [] });
    expect(parseOutput('Stop', JSON.stringify({ decision: 'block', reason: 'tests fail' }))).toEqual({ block: 'tests fail', errors: [] });
    expect(parseOutput('UserPromptSubmit', JSON.stringify({ continue: false, stopReason: 'quiet hours' }))).toEqual({ stop: 'quiet hours', errors: [] });
    expect(parseOutput('UserPromptSubmit', 'Ticket ABC-1 is open.')).toEqual({ context: 'Ticket ABC-1 is open.', errors: [] });
    expect(parseOutput('PostToolUse', 'ignored plain output')).toEqual({ errors: [] });
  });
});

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../runner/bin'));
const built = existsSync(binary);
/** Hooks run in PowerShell on Windows and in `sh` elsewhere (hooks.ts). */
const windows = process.platform === 'win32';

describe.skipIf(!built)('runHooks', () => {
  let db: Db;
  let dir: string;
  let manager: WorkspaceManager;
  let ws: Workspace;
  const input: HookInput = { session_id: 's1', cwd: '', hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } };

  beforeAll(async () => {
    db = openDatabase(':memory:');
    await db.insert(users).values({ id: 'ada', username: 'ada', name: 'Ada', role: 'user', passwordHash: 'x', createdAt: 0, updatedAt: 0 });
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'atelier-hooks-')));
    manager = new WorkspaceManager({ db, runnerBinary: binary, logger: { info: () => {}, error: () => {} } });
    ws = await manager.open('ada', (await manager.addLocal('ada', dir)).id);
  });
  afterAll(async () => {
    await manager.disposeAll();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes the event on stdin and CLAUDE_PROJECT_DIR, and combines decisions', async () => {
    const outcome = await runHooks(
      ws,
      [
        { type: 'command', command: windows ? '[IO.File]::WriteAllText("$env:CLAUDE_PROJECT_DIR\\event.json", ($input -join "`n"))' : 'cat > "$CLAUDE_PROJECT_DIR/event.json"' },
        { type: 'command', command: `echo '{"hookSpecificOutput":{"permissionDecision":"ask","additionalContext":"careful"}}'` },
        { type: 'command', command: windows ? '[Console]::Error.WriteLine("rm is not allowed here"); exit 2' : 'echo "rm is not allowed here" >&2; exit 2' },
        { type: 'command', command: 'exit 1' },
      ],
      input,
    );
    expect(JSON.parse(readFileSync(join(dir, 'event.json'), 'utf8'))).toEqual(input);
    expect(outcome).toEqual({ block: 'rm is not allowed here', permission: 'ask', context: 'careful', errors: ['Hook failed (exit 1): exit 1'] });
  });

  it('times out slow hooks without blocking', async () => {
    const outcome = await runHooks(ws, [{ type: 'command', command: 'sleep 5', timeout: 0.3 }], input);
    expect(outcome).toEqual({ errors: ['Hook timed out after 0.3s: sleep 5'] });
  });
});
