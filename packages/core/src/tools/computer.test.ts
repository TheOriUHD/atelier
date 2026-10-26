import { describe, expect, it } from 'vitest';
import type { AppGrant, ControllerMethods, PermissionAnswer, PermissionRequest, PreparedApp } from '@atelier/protocol';
import { createComputerTools, type ComputerCall } from './computer.ts';
import type { Tool, ToolContext } from './types.ts';

const ctx: ToolContext = { sessionId: 's1', messageId: 'm1', callId: 'c1', signal: new AbortController().signal, emit: () => {} };
const text = (out: { content: { type: string; text?: string }[] }) =>
  out.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const prepared = (name: string, over: Partial<PreparedApp> = {}): PreparedApp => ({
  app: { id: `com.example.${name}`, name },
  category: 'other',
  tier: 'full',
  maxTier: 'full',
  denied: false,
  granted: null,
  ...over,
});

/** The tools against a pretend controller: `answers` are the person's, in order; every call is recorded. */
function setup(answers: PermissionAnswer[], computer: Partial<{ [M in keyof ControllerMethods]: (p: ControllerMethods[M]['params']) => ControllerMethods[M]['result'] }>) {
  const asked: PermissionRequest[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const call: ComputerCall = async (_session, method, params) => {
    calls.push({ method, params });
    const handler = computer[method] as ((p: unknown) => unknown) | undefined;
    if (!handler) throw new Error(`unexpected ${method}`);
    return handler(params) as never;
  };
  const tools = createComputerTools({
    approve: async (_s, request) => (asked.push(request), answers.shift() ?? { behavior: 'deny' }),
    call,
    blobs: { put: async () => ({ sha256: 'blob1' }) as never },
    size: async () => ({ maxWidth: 1280, maxHeight: 800 }),
  });
  const tool = (name: string) => tools.find((t) => t.name === name) as Tool<Record<string, unknown>>;
  return { tool, asked, calls };
}

const state = (apps: AppGrant[], control = false): ControllerMethods['access.state']['result'] => ({ apps, mode: 'background', control, displays: [{ id: '1', name: 'Main', primary: true }] });
const textEdit: AppGrant = { app: { id: 'com.example.TextEdit', name: 'TextEdit' }, tier: 'full' };

describe('ComputerAccess', () => {
  it('asks the person about the apps not yet allowed, then says what it may use', async () => {
    const { tool, asked } = setup([{ behavior: 'allow' }], {
      'access.prepare': () => ({ apps: [prepared('TextEdit'), prepared('Notes', { granted: 'full' }), prepared('1Password', { denied: true }), prepared('Settings', { tier: null, maxTier: null })], unknown: ['Nope'] }),
      'access.state': () => state([textEdit]),
    });
    const out = await tool('ComputerAccess').run({ apps: ['TextEdit', 'Notes', '1Password', 'Settings', 'Nope'], reason: 'Write notes.' }, ctx);
    // Only the one that needs an answer goes on the card.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ toolName: 'ComputerAccess', suggestedRule: '', input: { reason: 'Write notes.' } });
    expect((asked[0]!.input as { apps: PreparedApp[] }).apps.map((a) => a.app.name)).toEqual(['TextEdit']);
    expect(out.isError).toBeUndefined();
    expect(text(out)).toBe(
      [
        'You may use: TextEdit (full). Taking over the mouse and keyboard (ComputerAction) asks the person first. Take a Screenshot to see them.',
        'No app called "Nope" is on this computer.',
        "1Password is on the person's denied list: don't ask for it again.",
        "Settings can't be used: it's part of the system or Atelier itself.",
      ].join('\n'),
    );
  });

  it('passes on what the person said when they decline', async () => {
    const { tool } = setup([{ behavior: 'deny', message: 'Use the API.' }], { 'access.prepare': () => ({ apps: [prepared('TextEdit')], unknown: [] }) });
    const out = await tool('ComputerAccess').run({ apps: ['TextEdit'] }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe("The person didn't allow it and said: Use the API.");
  });

  it('says when computer use is off', async () => {
    const { tool } = setup([], {
      'access.prepare': () => {
        throw new Error('Computer use is off on this computer: turn it on in Settings › System.');
      },
    });
    expect(text(await tool('ComputerAccess').run({ apps: ['TextEdit'] }, ctx))).toBe("Computer use isn't available: Computer use is off on this computer: turn it on in Settings › System.");
  });
});

describe('ComputerAction', () => {
  it('asks to take the mouse and keyboard first, then reports each step with its screenshot', async () => {
    let requests = 0;
    const { tool, asked, calls } = setup([{ behavior: 'allow' }], {
      'access.state': () => state([textEdit]),
      'control.request': () => (++requests === 1 ? { granted: false, reason: 'ask' } : { granted: true }),
      'control.batch': () => ({
        results: [
          { action: 'left_click', ok: true },
          { action: 'screenshot', ok: true, screenshot: { data: 'AAAA', mime: 'image/jpeg', width: 10, height: 10 } },
        ],
      }),
    });
    const out = await tool('ComputerAction').run({ actions: [{ action: 'left_click', coordinate: [5, 5], summary: 'Clicks Save' }, { action: 'screenshot' }] }, ctx);
    expect(asked[0]).toMatchObject({ toolName: 'FullControl', input: { reason: 'Clicks Save', apps: [textEdit] } });
    expect(calls.map((c) => c.method)).toEqual(['access.state', 'control.request', 'access.state', 'control.request', 'control.batch']);
    expect(out.content).toEqual([
      { type: 'text', text: '1. Clicks Save: done' },
      { type: 'text', text: '2. screenshot: done' },
      { type: 'image', mime: 'image/jpeg', blob: 'blob1' },
    ]);
  });

  it('does nothing when the person keeps control, or before any app was allowed', async () => {
    const kept = setup([{ behavior: 'deny' }], { 'access.state': () => state([textEdit]), 'control.request': () => ({ granted: false, reason: 'ask' }) });
    const out = await kept.tool('ComputerAction').run({ actions: [{ action: 'left_click', coordinate: [5, 5] }] }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe('The person kept control of their computer. Go on without it, or ask them.');
    expect(kept.calls.some((c) => c.method === 'control.batch')).toBe(false);

    const none = setup([], { 'access.state': () => state([]) });
    expect(text(await none.tool('ComputerAction').run({ actions: [{ action: 'left_click', coordinate: [5, 5] }] }, ctx))).toBe('You may use no apps yet: ask with ComputerAccess first.');
  });

  it('marks a refused step as an error and says what was not run', async () => {
    const { tool } = setup([], {
      'access.state': () => state([textEdit], true),
      'control.batch': () => ({ results: [{ action: 'type', ok: false, note: 'That is a password field: you never type passwords.' }] }),
    });
    const out = await tool('ComputerAction').run({ actions: [{ action: 'type', text: 'x' }, { action: 'key', text: 'return' }] }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe(["1. type: not done — That is a password field: you never type passwords.", "The other 1 actions didn't run."].join('\n'));
  });

  it('refuses a malformed list before asking anything', async () => {
    const { tool, calls } = setup([], {});
    const out = await tool('ComputerAction').run({ actions: [{ action: 'fly' }] }, ctx);
    expect(out.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('the other computer tools', () => {
  it('opens only an app it may use, and takes screenshots into the blob store', async () => {
    const { tool, calls } = setup([], {
      'access.state': () => state([textEdit]),
      'apps.open': () => ({}),
      screenshot: () => ({ data: 'AAAA', mime: 'image/jpeg', width: 1280, height: 800, display: 'Main', note: 'Only the apps you may use are shown.' }),
    });
    expect(text(await tool('OpenApp').run({ app: 'textedit' }, ctx))).toBe('Opened TextEdit.');
    expect(calls.find((c) => c.method === 'apps.open')?.params).toEqual({ id: 'com.example.TextEdit' });
    expect(text(await tool('OpenApp').run({ app: 'Mail' }, ctx))).toBe('You may not use Mail: ask with ComputerAccess first.');
    const shot = await tool('Screenshot').run({}, ctx);
    expect(shot.content).toEqual([
      { type: 'text', text: 'Screenshot of Main, 1280×800 pixels. Only the apps you may use are shown.' },
      { type: 'image', mime: 'image/jpeg', blob: 'blob1' },
    ]);
    expect(calls.find((c) => c.method === 'screenshot')?.params).toEqual({ size: { maxWidth: 1280, maxHeight: 800 } });
  });

  it('hands the mouse and keyboard back on release', async () => {
    const { tool, calls } = setup([], { 'control.release': () => ({}) });
    expect(text(await tool('FullControl').run({ action: 'release' }, ctx))).toBe('The person has their mouse and keyboard back.');
    expect(calls.map((c) => c.method)).toEqual(['control.release']);
  });
});
