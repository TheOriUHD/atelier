import { describe, expect, it, vi } from 'vitest';
import type { BrowserMethods } from '@atelier/protocol';
import { decide } from '../permissions/engine.ts';
import { createBrowserTool, elementLine, pageText, type BrowserCall } from './browser.ts';

const ctx = { sessionId: 's', messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} };
const text = (out: { content: { type: string; text?: string }[] }) => out.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

function fake(answers: Partial<{ [M in keyof BrowserMethods]: (p: BrowserMethods[M]['params']) => BrowserMethods[M]['result'] }>) {
  const calls: { method: string; params: unknown }[] = [];
  const call: BrowserCall = async (method, params) => {
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
    expect(pageText({ ...page, truncated: true })).toContain('Tab 3 · Cart · https://shop.example/cart\nElements (1):\n[4] button "Checkout"\n\nText:\nYour cart\n…(more');
  });

  it('opens a page in a tab of its own and reads it at once', async () => {
    const { call, calls } = fake({ 'tabs.open': () => ({ tab: 3, url: page.url, title: page.title }), 'page.read': () => page });
    const out = await createBrowserTool({ call, blobs: { put: vi.fn() } }).run({ action: 'open', url: 'https://shop.example/cart' }, ctx);
    expect(calls.map((c) => c.method)).toEqual(['tabs.open', 'page.read']);
    expect(text(out)).toContain('[4] button "Checkout"');
  });

  it('acts by ref and shows where the tab is after, with its summary', async () => {
    const { call, calls } = fake({ 'page.click': () => ({ tab: 3, url: page.url, title: page.title }), 'page.read': () => ({ ...page, text: undefined }) });
    const out = await createBrowserTool({ call, blobs: { put: vi.fn() } }).run({ action: 'click', tab: 3, ref: 4, summary: 'Opens the checkout' }, ctx);
    expect(calls[0]).toEqual({ method: 'page.click', params: { tab: 3, ref: 4 } });
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

  it('only reading is allowed without asking', () => {
    const rules = { mode: 'default' as const, rules: { allow: [], ask: [], deny: [] }, cwd: '/', home: '/', projectRoot: null, roots: [], isReadOnly: () => false };
    for (const action of ['read', 'find', 'screenshot', 'tabs']) expect(decide({ name: 'Browser', input: { action, tab: 1 } }, rules).behavior).toBe('allow');
    expect(decide({ name: 'Browser', input: { action: 'click', tab: 1, ref: 2 } }, rules).behavior).not.toBe('allow');
  });
});
