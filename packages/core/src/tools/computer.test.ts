import { describe, expect, it } from 'vitest';
import type { AppGrant, ControllerMethods, PermissionAnswer, PermissionRequest, PreparedApp } from '@atelier/protocol';
import { createComputerTools, namedIn, type ComputerCall, type ComputerToolDeps } from './computer.ts';
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
function setup(answers: PermissionAnswer[], computer: Partial<{ [M in keyof ControllerMethods]: (p: ControllerMethods[M]['params']) => ControllerMethods[M]['result'] }>, wanted?: ComputerToolDeps['wanted']) {
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
    ...(wanted ? { wanted } : {}),
  });
  const tool = (name: string) => tools.find((t) => t.name === name) as Tool<Record<string, unknown>>;
  return { tool, asked, calls };
}

const state = (apps: AppGrant[], control = false, mode: 'background' | 'full' = 'background'): ControllerMethods['access.state']['result'] => ({
  apps,
  platform: 'darwin',
  mode,
  background: false,
  denied: ['1Password'],
  control,
  displays: [{ id: '1', name: 'Main', primary: true }],
});
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

  it('allows the apps the person named in their own words without a card', async () => {
    const chrome = prepared('Google Chrome', { app: { id: 'com.google.Chrome', name: 'Google Chrome' } });
    const { tool, asked, calls } = setup(
      [{ behavior: 'allow' }],
      {
        'access.prepare': () => ({ apps: [chrome, prepared('Zen')], unknown: [] }),
        'access.allow': ({ ids }) => ({ allowed: ids }),
        'access.state': () => ({ ...state([{ app: chrome.app, tier: 'full' }, { app: { id: 'com.example.Zen', name: 'Zen' }, tier: 'full' }]), background: true }),
      },
      async () => ({ all: false, said: 'No, use chrome. Find me a gift on Amazon.' }),
    );
    const out = await tool('ComputerAccess').run({ apps: ['Google Chrome', 'Zen'] }, ctx);
    expect(calls.find((c) => c.method === 'access.allow')?.params).toEqual({ ids: ['com.google.Chrome'] });
    // Zen wasn't named: it still asks.
    expect((asked[0]!.input as { apps: PreparedApp[] }).apps.map((a) => a.app.name)).toEqual(['Zen']);
    // How browsers take input in the background, and when to ask for more.
    expect(text(out)).toContain('In a browser, use the tab you have: for an address press cmd+L');
    expect(text(out)).toContain('so does a click that is refused or an app that ignores what you do in the background');
  });

  it('asks for nothing in Bypass, and keeps the tier the person picked for an app it has', async () => {
    const { tool, asked, calls } = setup(
      [],
      {
        'access.prepare': () => ({ apps: [prepared('TextEdit'), prepared('Notes', { granted: 'view' })], unknown: [] }),
        'access.allow': ({ ids }) => ({ allowed: ids }),
        'access.state': () => state([textEdit]),
      },
      async () => ({ all: true, said: '' }),
    );
    await tool('ComputerAccess').run({ apps: ['TextEdit', 'Notes'] }, ctx);
    expect(asked).toHaveLength(0);
    expect(calls.find((c) => c.method === 'access.allow')?.params).toEqual({ ids: ['com.example.TextEdit'] });
  });

  it('still asks when the computer allows nothing itself (a server’s session)', async () => {
    const { tool, asked } = setup(
      [{ behavior: 'allow' }],
      { 'access.prepare': () => ({ apps: [prepared('TextEdit')], unknown: [] }), 'access.allow': () => ({ allowed: [] }), 'access.state': () => state([textEdit]) },
      async () => ({ all: false, said: 'open textedit' }),
    );
    await tool('ComputerAccess').run({ apps: ['TextEdit'] }, ctx);
    expect(asked).toHaveLength(1);
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

describe('namedIn', () => {
  it('finds an app named as people name it, as a whole word', () => {
    expect(namedIn('No bro chrome why zen', 'Google Chrome')).toBe(true);
    expect(namedIn('keep browsing in CHROME', 'Google Chrome')).toBe(true);
    expect(namedIn('use brave', 'Brave Browser')).toBe(true);
    expect(namedIn('open Microsoft Word', 'Microsoft Word')).toBe(true);
    expect(namedIn('write it in word', 'Microsoft Word')).toBe(true);
    expect(namedIn('the Visual Studio Code window', 'Visual Studio Code')).toBe(true);
    expect(namedIn('check my mail', 'Mail')).toBe(true);
    // Part of a word isn't a name.
    expect(namedIn('the citizen app', 'Zen')).toBe(false);
    expect(namedIn('search for it', 'Arc')).toBe(false);
    expect(namedIn('my mailchimp list', 'Mail')).toBe(false);
    expect(namedIn('use the browser', 'Brave Browser')).toBe(false);
    expect(namedIn('google it', 'Google Chrome')).toBe(false);
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

describe('in the background', () => {
  it('acts in the window of its latest screenshot without asking to take over', async () => {
    const { tool, asked, calls } = setup([], {
      'access.state': () => ({ ...state([textEdit]), background: true }),
      screenshot: () => ({ data: 'AAAA', mime: 'image/jpeg', width: 400, height: 300, display: 'TextEdit’s window', note: 'Only this window.' }),
      'control.batch': () => ({ results: [{ action: 'left_click', ok: true }] }),
    });
    expect(text(await tool('Screenshot').run({ app: 'TextEdit' }, ctx))).toBe('Screenshot of TextEdit’s window, 400×300 pixels. Only this window.');
    expect(calls.find((c) => c.method === 'screenshot')?.params).toMatchObject({ app: 'TextEdit' });
    expect(text(await tool('ComputerAction').run({ actions: [{ action: 'left_click', coordinate: [5, 5] }] }, ctx))).toBe('1. left_click: done');
    expect(calls.some((c) => c.method === 'control.request')).toBe(false);
    expect(asked).toEqual([]);
  });

  it('tells it how Background works, and how to get more in an app', async () => {
    const { tool } = setup([{ behavior: 'allow' }], {
      'access.prepare': () => ({ apps: [prepared('Safari', { granted: 'view', tier: 'full', maxTier: 'full', category: 'browser' })], unknown: [] }),
      'access.state': () => ({ ...state([{ app: { id: 'com.example.Safari', name: 'Safari' }, tier: 'view' }]), background: true }),
    });
    // Safari has less than it could get: the card comes up again for it, offering full use.
    const asked: PermissionRequest[] = [];
    const again = createComputerTools({
      approve: async (_s, request) => (asked.push(request), { behavior: 'deny' }),
      call: (async (_s: string, method: string) =>
        method === 'access.prepare'
          ? { apps: [prepared('Safari', { granted: 'view', tier: 'full', maxTier: 'full' })], unknown: [] }
          : state([])) as never,
      blobs: { put: async () => ({ sha256: 'b' }) as never },
      size: async () => ({ maxWidth: 1280, maxHeight: 800 }),
    }).find((t) => t.name === 'ComputerAccess') as Tool<Record<string, unknown>>;
    await again.run({ apps: ['Safari'] }, ctx);
    expect((asked[0]?.input as { apps: PreparedApp[] }).apps[0]).toMatchObject({ app: { name: 'Safari' }, tier: 'full', granted: 'view' });
    const out = text(await tool('ComputerAccess').run({ apps: ['Safari'] }, ctx));
    expect(out).toContain('You work in the background, in one app at a time');
    expect(out).toContain('If you need more in an app than you were given, ask with ComputerAccess again');
  });
});

describe('Full control', () => {
  it('names the shortcuts of the computer’s system', async () => {
    const { tool } = setup([], {
      'access.prepare': () => ({ apps: [], unknown: [] }),
      'access.state': () => ({ ...state([], false, 'full'), platform: 'win32' }),
    });
    const out = text(await tool('ComputerAccess').run({ apps: [] }, ctx));
    expect(out).toContain('(or alt+tab, the Windows key)');
    expect(out).toContain('(ctrl+L). Shortcuts use ctrl on Windows.');
  });

  it('names Linux’s shortcuts, and says the computer can’t tell a password field', async () => {
    const { tool } = setup([], {
      'access.prepare': () => ({ apps: [], unknown: [] }),
      'access.state': () => ({ ...state([], false, 'full'), platform: 'linux' }),
    });
    const out = text(await tool('ComputerAccess').run({ apps: [] }, ctx));
    expect(out).toContain('(or alt+tab)');
    expect(out).toContain('(ctrl+L). Shortcuts use ctrl on Linux.');
    expect(out).toContain('can’t tell you when a field is a password field: never type a password');
    // The other systems can tell, and don't say so.
    const mac = setup([], { 'access.prepare': () => ({ apps: [], unknown: [] }), 'access.state': () => state([], false, 'full') });
    expect(text(await mac.tool('ComputerAccess').run({ apps: [] }, ctx))).not.toContain('password field');
  });

  it('needs no card for apps, and says what it may use', async () => {
    const { tool, asked } = setup([], {
      'access.prepare': () => ({ apps: [prepared('Safari', { granted: 'full' }), prepared('1Password', { denied: true })], unknown: [] }),
      'access.state': () => state([], false, 'full'),
    });
    const out = await tool('ComputerAccess').run({ apps: ['Safari', '1Password'] }, ctx);
    expect(asked).toEqual([]);
    expect(text(out)).toContain("Full control is on: you may use any app on this computer as the person sees the screen, except Atelier itself, parts of the system and the person's denied apps (1Password).");
    expect(text(out)).toContain("1Password is on the person's denied list");
  });

  it('opens any app it may use by taking the computer first, and acts without apps allowed one by one', async () => {
    let control = false;
    const { tool, asked, calls } = setup([], {
      'access.state': () => state([], control, 'full'),
      'apps.list': () => ({ apps: [{ app: { id: 'com.google.Chrome', name: 'Google Chrome' }, category: 'browser', running: true, granted: 'full' }] }),
      'control.request': () => ((control = true), { granted: true }),
      'apps.open': () => ({}),
      'control.batch': () => ({ results: [{ action: 'key', ok: true }] }),
    });
    expect(text(await tool('OpenApp').run({ app: 'google chrome' }, ctx))).toBe('Opened Google Chrome and brought it to the front.');
    expect(calls.map((c) => c.method)).toEqual(['access.state', 'apps.list', 'control.request', 'apps.open']);
    expect(asked).toEqual([]);
    expect(text(await tool('ComputerAction').run({ actions: [{ action: 'key', text: 'cmd+l' }] }, ctx))).toBe('1. key: done');
  });

  it("can't open a denied app", async () => {
    const { tool } = setup([], {
      'access.state': () => state([], false, 'full'),
      'apps.list': () => ({ apps: [{ app: { id: 'com.1password.1password', name: '1Password' }, category: 'password-manager', running: true, granted: null }] }),
    });
    const out = await tool('OpenApp').run({ app: '1Password' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toBe("You may not use 1Password: it isn't installed, or it is on the person's denied list or part of the system.");
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
