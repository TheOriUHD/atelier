import { describe, expect, it, vi } from 'vitest';
import type { BrowserMethods } from '@atelier/protocol';
import { decide } from '../permissions/engine.ts';
import { createBrowserTool, elementLine, MAX_TABS, pageText, stepLabel, type BrowserSessionCall } from './browser.ts';

const ctx = { sessionId: 's', messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} };
const text = (out: { content: { type: string; text?: string }[] }) => out.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

function fake(answers: Partial<{ [M in keyof BrowserMethods]: (p: BrowserMethods[M]['params']) => BrowserMethods[M]['result'] }>) {
  const calls: { method: string; params: unknown }[] = [];
  const call: BrowserSessionCall = async (_session, method, params) => {
    calls.push({ method, params });
    const answer = answers[method] as ((p: unknown) => unknown) | undefined;
    if (!answer) throw new Error(`no answer for ${method}`);
    return answer(params) as never;
  };
  return { call, calls };
}

const page = { tab: 3, url: 'https://shop.example/cart', title: 'Cart', elements: [{ ref: 4, role: 'button', name: 'Checkout', visible: true }], text: 'Your cart' };

describe('Browser tool', () => {
  it('writes an element as one line the model can act on', () => {
    expect(elementLine({ ref: 12, role: 'textbox', name: 'Search', value: 'usb c', visible: true })).toBe('[12] textbox "Search" = "usb c"');
    expect(elementLine({ ref: 3, role: 'link', name: 'Help', href: 'https://x/help', visible: false, disabled: true })).toBe('[3] link "Help" → https://x/help (disabled) (off screen)');
    expect(pageText({ ...page, truncated: true })).toContain('Tab 3 · Cart · https://shop.example/cart\nElements (1):\n[4] button "Checkout"\n\nText:\nYour cart\n…(the page goes on');
    expect(pageText({ ...page, truncated: true, textLength: 20_000 }, 6000)).toContain('Text, from character 6000:\nYour cart\n…(characters 6000–6009 of 20000: read with from 6009 for the next part)');
  });

  it('opens a page in a tab of its own and reads it at once', async () => {
    const { call, calls } = fake({ 'tabs.open': () => ({ tab: 3, url: page.url, title: page.title }), 'page.read': () => page });
    const out = await createBrowserTool({ call, blobs: { put: vi.fn() } }).run({ action: 'open', url: 'https://shop.example/cart' }, ctx);
    expect(calls.map((c) => c.method)).toEqual(['status', 'tabs.open', 'page.read']);
    // An extension older than 0.2.0 doesn't know chats: the tab goes in its one "Atelier" group.
    expect(calls[1]!.params).toEqual({ url: 'https://shop.example/cart' });
    expect(text(out)).toContain('[4] button "Checkout"');
  });

  it('acts by ref and shows where the tab is after, with its summary', async () => {
    const { call, calls } = fake({ 'page.click': () => ({ tab: 3, url: page.url, title: page.title }), 'page.read': () => ({ ...page, text: undefined }) });
    const out = await createBrowserTool({ call, blobs: { put: vi.fn() } }).run({ action: 'click', tab: 3, ref: 4, summary: 'Opens the checkout' }, ctx);
    expect(calls.find((c) => c.method === 'page.click')).toEqual({ method: 'page.click', params: { tab: 3, ref: 4 } });
    expect(text(out)).toMatch(/^Opens the checkout: done\.\nTab 3 · Cart/);
  });

  it('says what an action is missing, and passes the extension’s refusals on', async () => {
    const { call } = fake({ 'page.key': () => {
      throw new Error('Meta+t would reach the browser itself');
    } });
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() } });
    expect(await tool.run({ action: 'type', tab: 3 }, ctx)).toMatchObject({ isError: true, content: [{ text: 'type needs text.' }] });
    expect(await tool.run({ action: 'key', tab: 3, keys: ['Meta', 't'] }, ctx)).toMatchObject({ isError: true, content: [{ text: 'Meta+t would reach the browser itself' }] });
  });

  it('returns a screenshot as an image in CSS pixels', async () => {
    const put = vi.fn(async () => ({ sha256: 'abc' }));
    const { call } = fake({ 'page.screenshot': () => ({ data: Buffer.from('jpeg').toString('base64'), width: 1280, height: 720, tab: 3, url: page.url, title: page.title }) });
    const out = await createBrowserTool({ call, blobs: { put } as never }).run({ action: 'screenshot', tab: 3 }, ctx);
    expect(out.content[1]).toEqual({ type: 'image', mime: 'image/jpeg', blob: 'abc' });
    expect(text(out)).toContain('1280×720 CSS pixels');
  });

  it('works in its own tabs without asking, reading or acting, until a rule says otherwise', () => {
    const rules = (ask: string[] = []) => ({ mode: 'default' as const, rules: { allow: [], ask, deny: [] }, cwd: '/', home: '/', projectRoot: null, roots: [], isReadOnly: () => false });
    for (const action of ['read', 'find', 'screenshot', 'tabs', 'open', 'click', 'type']) expect(decide({ name: 'Browser', input: { action, tab: 1 } }, rules()).behavior, action).toBe('allow');
    expect(decide({ name: 'Browser', input: { action: 'click', tab: 1, ref: 2 } }, rules(['Browser'])).behavior).toBe('ask');
  });

});

describe('Browser tool with Atelier for Chrome 0.2.0', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let nextTab = 10;
  const modern = (extra: Parameters<typeof fake>[0] = {}) =>
    fake({
      status: () => ({ connected: true, extensionVersion: '0.2.0' }),
      'tabs.open': ({ url }) => ({ tab: nextTab++, url, title: '' }),
      'tabs.list': () => ({ tabs: [] }),
      'tabs.close': () => ({}),
      'tabs.closeSession': () => ({ closed: 1 }),
      'tabs.rename': () => ({}),
      'overlay.step': () => ({}),
      'overlay.end': () => ({}),
      'page.read': ({ tab }) => ({ ...page, tab }),
      'page.click': ({ tab }) => ({ tab, url: page.url, title: page.title }),
      ...extra,
    });

  it('opens tabs in the chat’s group, shows each step in the page, and leaves the tabs open when the turn ends', async () => {
    const { call, calls } = modern();
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() }, title: async () => 'Lab Rax research' });
    await tool.run({ action: 'open', url: 'https://duckduckgo.com/?q=lab+rax+project' }, ctx);
    await tool.run({ action: 'click', tab: 10, ref: 4 }, ctx);
    await tick();
    expect(calls.find((c) => c.method === 'tabs.open')!.params).toEqual({ url: 'https://duckduckgo.com/?q=lab+rax+project', session: { id: 's', title: 'Lab Rax research' } });
    expect(calls.filter((c) => c.method === 'overlay.step').map((c) => (c.params as { step: string }).step)).toEqual(['Searching duckduckgo.com for “lab rax project”', 'Clicking “Checkout”']);
    // The status is asked once, not for every step.
    expect(calls.filter((c) => c.method === 'status')).toHaveLength(1);

    calls.length = 0;
    await tool.endTurn('s', false);
    expect(calls).toEqual([{ method: 'overlay.end', params: { session: 's', state: 'done' } }]);
    // A turn that didn't use the browser asks it nothing.
    calls.length = 0;
    await tool.endTurn('s', false);
    await tool.endTurn('other', true);
    expect(calls).toEqual([]);
  });

  it('says it waits on the person when the turn stops for a question', async () => {
    const { call, calls } = modern();
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() } });
    await tool.run({ action: 'read', tab: 3 }, ctx);
    await tool.endTurn('s', true);
    expect(calls.at(-1)).toEqual({ method: 'overlay.end', params: { session: 's', state: 'waiting' } });
    // The answer came and the turn ended without another step in the page: it still says it is done.
    await tool.endTurn('s', false);
    expect(calls.at(-1)).toEqual({ method: 'overlay.end', params: { session: 's', state: 'done' } });
  });

  it('closes a chat’s tabs when it is deleted, and asks the browser nothing for a chat that never used it', async () => {
    const { call, calls } = modern();
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() } });
    await tool.closeTabs('never-browsed');
    expect(calls).toEqual([]);
    await tool.run({ action: 'open', url: 'https://example.com' }, ctx);
    await tool.closeTabs('s');
    expect(calls.at(-1)).toEqual({ method: 'tabs.closeSession', params: { session: 's' } });
  });

  it('closes the tabs an older extension opened one by one', async () => {
    const { call, calls } = fake({ status: () => ({ connected: true, extensionVersion: '0.1.0' }), 'tabs.open': () => ({ tab: 7, url: page.url, title: '' }), 'page.read': () => page, 'tabs.close': () => ({}) });
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() } });
    await tool.run({ action: 'open', url: page.url }, ctx);
    await tool.endTurn('s', false);
    expect(calls.map((c) => c.method)).not.toContain('overlay.end');
    await tool.closeTabs('s');
    expect(calls.at(-1)).toEqual({ method: 'tabs.close', params: { tab: 7 } });
  });

  it(`keeps a chat to ${MAX_TABS} tabs, closing the one used longest ago`, async () => {
    let clock = 0;
    const open = new Set<number>();
    const { call, calls } = modern({
      'tabs.open': ({ url }) => {
        const tab = nextTab++;
        open.add(tab);
        return { tab, url, title: '' };
      },
      'tabs.list': () => ({ tabs: [...open].map((tab) => ({ tab, url: page.url, title: '' })) }),
      'tabs.close': ({ tab }) => {
        open.delete(tab);
        return {};
      },
    });
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() }, now: () => ++clock });
    nextTab = 100;
    for (let i = 0; i < MAX_TABS; i++) await tool.run({ action: 'open', url: `https://example.com/${i}` }, ctx);
    // The first tab is used again, so the second is now the one used longest ago.
    await tool.run({ action: 'read', tab: 100 }, ctx);
    const out = await tool.run({ action: 'open', url: 'https://example.com/more' }, ctx);
    expect(calls.filter((c) => c.method === 'tabs.close').map((c) => c.params)).toEqual([{ tab: 101 }]);
    expect(text(out)).toContain(`(Closed tab 101, used longest ago: a chat keeps at most ${MAX_TABS} tabs open.)`);
    expect(open.size).toBe(MAX_TABS);
  });

  it('lists only this chat’s tabs, and reads a long page in parts', async () => {
    const { call, calls } = modern({
      'tabs.list': ({ session }) => ({ tabs: session === 's' ? [{ tab: 3, url: page.url, title: 'Cart' }] : [] }),
      'page.read': ({ tab }) => ({ ...page, tab, text: 'b'.repeat(10), truncated: true, textLength: 30 }),
    });
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() } });
    expect(text(await tool.run({ action: 'tabs' }, ctx))).toBe("This chat's tabs:\nTab 3 · Cart · https://shop.example/cart");
    const out = await tool.run({ action: 'read', tab: 3, from: 10 }, ctx);
    expect(calls.find((c) => c.method === 'page.read')!.params).toEqual({ tab: 3, text: true, elements: true, from: 10 });
    expect(text(out)).toContain('…(characters 10–20 of 30: read with from 20 for the next part)');
  });

  it('names a renamed chat’s group only when it has tabs open', async () => {
    const { call, calls } = modern();
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() }, title: async () => 'New name' });
    await tool.renamed('s');
    expect(calls).toEqual([]);
    await tool.run({ action: 'open', url: 'https://example.com' }, ctx);
    await tool.renamed('s');
    expect(calls.at(-1)).toEqual({ method: 'tabs.rename', params: { session: { id: 's', title: 'New name' } } });
  });

  it('keeps what one chat read apart from another’s, even with the same tab number', async () => {
    const { call, calls } = modern();
    const tool = createBrowserTool({ call, blobs: { put: vi.fn() } });
    await tool.run({ action: 'read', tab: 3 }, ctx);
    await tool.run({ action: 'click', tab: 3, ref: 4 }, { ...ctx, sessionId: 'someone-else' });
    await tick();
    expect(calls.filter((c) => c.method === 'overlay.step').map((c) => (c.params as { step: string }).step)).toEqual(['Reading the page', 'Clicking']);
  });

  it('writes steps the person can follow', () => {
    expect(stepLabel({ action: 'click', tab: 1, ref: 2, summary: '  Opens the second   result ' })).toBe('Opens the second result');
    expect(stepLabel({ action: 'open', url: 'https://www.example.com/docs/' })).toBe('Opening example.com/docs');
    expect(stepLabel({ action: 'navigate', tab: 1, url: 'https://www.google.com/search?q=lab%20rax' })).toBe('Searching google.com for “lab rax”');
    expect(stepLabel({ action: 'scroll', tab: 1, dy: -300 })).toBe('Scrolling up');
    expect(stepLabel({ action: 'read', tab: 1, from: 6000 })).toBe('Reading further');
    expect(stepLabel({ action: 'type', tab: 1, text: 'usb c cable' })).toBe('Typing “usb c cable”');
  });
});
