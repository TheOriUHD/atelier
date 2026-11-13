import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { PendingInteraction } from '@atelier/protocol';
import { Paint, palette } from '../style.ts';
import { PendingPrompt } from './prompts.tsx';
import type { ViewContext } from './views.tsx';

const ctx: ViewContext = { paint: new Paint(palette('dark', 0)), columns: 100, root: '/repo', view: 'normal', reveal: 'keys' };
const wait = () => new Promise((r) => setTimeout(r, 30));

function ask(pending: PendingInteraction) {
  const answers: unknown[] = [];
  const ui = render(<PendingPrompt pending={pending} ctx={ctx} respond={(a) => answers.push(a)} />);
  return { ui, answers };
}

const permission = (input: unknown, extra: object = {}): PendingInteraction => ({ kind: 'permission', id: 'p1', payload: { callId: 'c', toolName: 'Bash', input, reason: 'Ask mode asks before commands.', suggestedRule: 'Bash(npm test *)', ...extra } });

describe('the prompts', () => {
  it('asks to run a command and remembers it for the project when told to', async () => {
    const { ui, answers } = ask(permission({ command: 'npm test', description: 'Run the tests' }));
    expect(ui.lastFrame()).toContain('Run this command?');
    expect(ui.lastFrame()).toContain('npm test');
    ui.stdin.write('3');
    await wait();
    expect(answers).toEqual([{ behavior: 'allow', remember: 'project' }]);
  });

  it('offers no remembering for a dangerous command, and Esc says no', async () => {
    const { ui, answers } = ask(permission({ command: 'rm -rf build' }, { warning: 'Deletes files outside the workspace.', suggestedRule: '' }));
    expect(ui.lastFrame()).toContain('Deletes files outside the workspace.');
    expect(ui.lastFrame()).not.toContain('always');
    ui.stdin.write('\x1b');
    await wait();
    expect(answers).toEqual([{ behavior: 'deny' }]);
  });

  it('says no with a reason', async () => {
    const { ui, answers } = ask(permission({ command: 'npm publish' }));
    ui.stdin.write('5');
    await wait();
    ui.stdin.write('use the staging registry');
    await wait();
    ui.stdin.write('\r');
    await wait();
    expect(answers).toEqual([{ behavior: 'deny', message: 'use the staging registry' }]);
  });

  it('approves a plan into a mode', async () => {
    const { ui, answers } = ask({ kind: 'permission', id: 'p2', payload: { callId: 'c', toolName: 'ExitPlanMode', input: { plan: '1. Slow the waves' }, reason: '', suggestedRule: '' } });
    expect(ui.lastFrame()).toContain('Slow the waves');
    ui.stdin.write('2');
    await wait();
    expect(answers).toEqual([{ behavior: 'allow', mode: 'acceptEdits' }]);
  });

  it('answers questions, picking several where it may', async () => {
    const { ui, answers } = ask({
      kind: 'question',
      id: 'q',
      payload: {
        callId: 'c',
        questions: [
          { question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'SQLite', description: '' }, { label: 'Postgres', description: '' }] },
          { question: 'Which checks?', header: 'CI', multiSelect: true, options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }] },
        ],
      },
    });
    ui.stdin.write('2');
    await wait();
    ui.stdin.write('1');
    await wait();
    ui.stdin.write('2');
    await wait();
    ui.stdin.write('4');
    await wait();
    expect(answers).toEqual([{ answers: { 'Which database?': 'Postgres', 'Which checks?': 'Lint, Tests' } }]);
  });
});
