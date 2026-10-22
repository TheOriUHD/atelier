import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), insert: vi.fn(async (_text: string) => {}), load: vi.fn(async () => {}), destroy: vi.fn(), show: vi.fn(), hide: vi.fn(), clear: vi.fn(async () => {}),
  origin: 'https://chatgpt.com/',
}));
vi.mock('electron', () => ({
  app: { once: vi.fn(), removeListener: vi.fn() },
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), clearStorageData: mocks.clear }) },
  BrowserWindow: class {
    webContents = { executeJavaScript: mocks.execute, insertText: mocks.insert, setWindowOpenHandler: vi.fn(), getURL: () => mocks.origin };
    loadURL = mocks.load;
    destroy = mocks.destroy;
    show = mocks.show;
    hide = mocks.hide;
    on = vi.fn();
    isDestroyed = () => false;
  },
}));
import { ChatGptChatBrowser } from './chatgpt-chat.ts';

const payload = (prompt: string, id = 'first', more: Record<string, unknown> = {}) => JSON.stringify({ id, prompt, ...more });
/** A page whose message field is ready, which takes the text and sends it with `baseline` replies already on it. */
const readyPage = (baseline = 0) => async (script: string): Promise<unknown> => (script.includes('assistantMessages().length') ? baseline : true);
const finished = (text = 'Hello back') => ({ text, generating: false, completed: true, alerts: '' });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.origin = 'https://chatgpt.com/';
  mocks.load.mockResolvedValue();
  mocks.insert.mockResolvedValue();
  mocks.clear.mockResolvedValue();
});

it('keeps authentication checks off third-party login pages', async () => {
  mocks.origin = 'https://auth.openai.com/';
  const browser = new ChatGptChatBrowser();
  expect(JSON.parse(await browser.request('status'))).toEqual({ signedIn: false });
  expect(mocks.execute).not.toHaveBeenCalled();
});

it('waits for the hydrated composer, inserts text through Chromium, and stays hidden', async () => {
  vi.useFakeTimers();
  try {
    let checks = 0;
    mocks.execute.mockImplementation(async (script: string) => (script.includes('assistantMessages().length') ? 0 : script.includes('return !!composer()') ? ++checks > 2 : true));
    const browser = new ChatGptChatBrowser();
    const start = browser.request('start', payload('Hello'));
    await vi.advanceTimersByTimeAsync(250);
    await start;
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith('Hello');
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/?temporary-chat=true');
    expect(mocks.execute.mock.calls[0]?.[0]).toContain('div[role="textbox"].ProseMirror');
    expect(mocks.execute.mock.calls[0]?.[0]).toContain('getClientRects');
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(mocks.show).not.toHaveBeenCalled();
    await browser.request('stop', 'first');
  } finally {
    vi.useRealTimers();
  }
});

it('does not open the browser on a preparation failure', async () => {
  mocks.execute.mockRejectedValue(new Error('Page unavailable'));
  const browser = new ChatGptChatBrowser();
  await expect(browser.request('start', payload('Hello'))).rejects.toThrow('Page unavailable');
  expect(mocks.show).not.toHaveBeenCalled();
  await browser.request('disconnect');
});

it('hides an explicitly opened session without clearing sign-in', async () => {
  const browser = new ChatGptChatBrowser();
  await browser.request('open');
  await browser.request('hide');
  expect(mocks.show).toHaveBeenCalledOnce();
  expect(mocks.hide).toHaveBeenCalledOnce();
  expect(mocks.clear).not.toHaveBeenCalled();
});

it('lets a new request take over a generation nobody stopped, and clears browser storage on disconnect', async () => {
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  await browser.request('start', payload('Hello'));
  await browser.request('start', payload('Again', 'second'));
  await expect(browser.request('poll', 'first')).rejects.toThrow('No active ChatGPT generation');
  expect(mocks.insert).toHaveBeenLastCalledWith('Again');
  await browser.request('disconnect');
  expect(mocks.clear).toHaveBeenCalledOnce();
  expect(mocks.destroy).toHaveBeenCalledOnce();
});

it('ignores stale stop and poll requests after another generation takes ownership', async () => {
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  await browser.request('start', payload('Hello'));
  await browser.request('stop', 'first');
  await browser.request('start', payload('Again', 'second'));
  const calls = mocks.execute.mock.calls.length;
  await browser.request('stop', 'first');
  expect(mocks.execute).toHaveBeenCalledTimes(calls);
  await expect(browser.request('poll', 'first')).rejects.toThrow('No active ChatGPT generation for this request');
  await browser.request('stop', 'second');
});

it('discards a poll result that arrives after its generation was stopped', async () => {
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  await browser.request('start', payload('Hello'));
  let reply!: (state: unknown) => void;
  mocks.execute.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  const poll = browser.request('poll', 'first');
  const stopped = expect(poll).rejects.toThrow('This ChatGPT generation was stopped');
  await vi.waitFor(() => expect(reply).toBeDefined());
  await browser.request('stop', 'first');
  await browser.request('start', payload('Again', 'second'));
  reply({ text: 'Old reply', generating: true, completed: false, alerts: '' });
  await stopped;
  mocks.execute.mockResolvedValue({ text: 'New reply', generating: false, completed: false, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'second'))).toEqual({ text: 'New reply', done: false });
  await browser.request('stop', 'second');
});

it('cancels preparation before typing, and a request that follows waits for it to unwind', async () => {
  let loaded!: () => void;
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  mocks.load.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve; }));
  const start = browser.request('start', payload('Hello'));
  const failed = expect(start).rejects.toThrow();
  const stop = browser.request('stop', 'first');
  const next = browser.request('start', payload('Again', 'second'));
  await vi.waitFor(() => expect(loaded).toBeDefined());
  expect(mocks.insert).not.toHaveBeenCalled();
  loaded();
  await failed;
  await stop;
  await next;
  expect(mocks.insert).toHaveBeenCalledExactlyOnceWith('Again');
  await browser.request('stop', 'second');
});

it.each([
  ['return matchesText(', 'does not contain the complete intended text'],
  ['return !!sendButton()', 'Send button is missing or disabled'],
])('reports the failed preparation check separately: %s', async (check, error) => {
  vi.useFakeTimers();
  try {
    mocks.execute.mockImplementation(async (script: string) => !script.includes(check));
    const browser = new ChatGptChatBrowser();
    const start = browser.request('start', payload('Hello'));
    const failed = expect(start).rejects.toThrow(error);
    await vi.advanceTimersByTimeAsync(20100);
    await failed;
    expect(mocks.execute.mock.calls.some(([script]) => String(script).includes('button.click()'))).toBe(false);
    expect(mocks.show).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('does not claim ChatGPT failed when Atelier cannot observe a reply', async () => {
  vi.useFakeTimers();
  try {
    mocks.execute.mockImplementation(readyPage());
    const browser = new ChatGptChatBrowser();
    await browser.request('start', payload('Hello'));
    mocks.execute.mockResolvedValue({ text: '', generating: false, completed: false, alerts: '' });
    await vi.advanceTimersByTimeAsync(60100);
    expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: '', done: false, error: expect.stringContaining('Atelier could not confirm the ChatGPT reply') });
    expect(mocks.insert).toHaveBeenCalledOnce();
    await browser.request('stop', 'first');
  } finally {
    vi.useRealTimers();
  }
});

it('waits for the answer completion controls through a pause without Stop', async () => {
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  await browser.request('start', payload('Hello'));
  mocks.execute.mockResolvedValue({ text: 'First part', generating: true, completed: false, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'First part', done: false });
  mocks.execute.mockResolvedValue({ text: 'First part', generating: false, completed: false, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'First part', done: false });
  mocks.execute.mockResolvedValue({ text: 'First part. Final answer.', generating: true, completed: true, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'First part. Final answer.', done: false });
  mocks.execute.mockResolvedValue({ text: 'First part. Final answer.', generating: false, completed: true, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'First part. Final answer.', done: false });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'First part. Final answer.', done: true });
  await browser.request('stop', 'first');
});

it('recognizes a completed fast reply even when its Stop button was never observed', async () => {
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  await browser.request('start', payload('Hello'));
  mocks.execute.mockResolvedValue({ text: 'Hello back', generating: false, completed: true, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'Hello back', done: false });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'Hello back', done: true });
  await browser.request('stop', 'first');
});

it('waits for the last paragraph: a reply that looked complete but grew is not done yet', async () => {
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  await browser.request('start', payload('Hello'));
  mocks.execute.mockResolvedValue({ text: 'Intro', generating: false, completed: true, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'Intro', done: false });
  mocks.execute.mockResolvedValue({ text: 'Intro\n\n[Example](https://example.com)', generating: false, completed: true, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'Intro\n\n[Example](https://example.com)', done: false });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'Intro\n\n[Example](https://example.com)', done: true });
  await browser.request('stop', 'first');
});

describe('continuing a conversation', () => {
  const answer = async (browser: ChatGptChatBrowser, id: string, text = 'Hello back') => {
    mocks.execute.mockImplementation(async (script: string) => (script.includes('assistantMessages().length') ? 0 : script.includes('toMarkdown') ? finished(text) : true));
    await browser.request('poll', id);
    expect(JSON.parse(await browser.request('poll', id))).toEqual({ text, done: true });
    await browser.request('stop', id);
  };

  it('types only what was added, in the same chat, when the next request names the finished one as its parent', async () => {
    mocks.execute.mockImplementation(readyPage());
    const browser = new ChatGptChatBrowser();
    await browser.request('start', payload('everything so far', 'first', { token: 'one' }));
    await answer(browser, 'first');
    mocks.execute.mockImplementation(readyPage(1));
    await browser.request('start', payload('everything so far and more', 'second', { token: 'two', parent: 'one', delta: '[user]\nmore' }));
    expect(mocks.insert.mock.calls.map(([text]) => text)).toEqual(['everything so far', '[user]\nmore']);
    expect(mocks.load).toHaveBeenCalledOnce();
    // The reply is what comes after the one reply already on the page.
    mocks.execute.mockImplementation(async (script: string) => script.includes('assistantMessages().slice(1)') ? finished('Second') : true);
    await browser.request('poll', 'second');
    expect(JSON.parse(await browser.request('poll', 'second'))).toEqual({ text: 'Second', done: true });
    await browser.request('stop', 'second');
  });

  it('starts a new chat with everything when the parent is not the conversation the page holds', async () => {
    mocks.execute.mockImplementation(readyPage());
    const browser = new ChatGptChatBrowser();
    await browser.request('start', payload('first prompt', 'first', { token: 'one' }));
    await answer(browser, 'first');
    await browser.request('start', payload('full prompt', 'second', { token: 'two', parent: 'elsewhere', delta: 'delta' }));
    expect(mocks.insert).toHaveBeenLastCalledWith('full prompt');
    expect(mocks.load).toHaveBeenCalledTimes(2);
    await browser.request('stop', 'second');
  });

  it('does not continue a conversation whose reply was stopped before it was complete', async () => {
    mocks.execute.mockImplementation(readyPage());
    const browser = new ChatGptChatBrowser();
    await browser.request('start', payload('first prompt', 'first', { token: 'one' }));
    await browser.request('stop', 'first');
    await browser.request('start', payload('full prompt', 'second', { token: 'two', parent: 'one', delta: 'delta' }));
    expect(mocks.insert).toHaveBeenLastCalledWith('full prompt');
    await browser.request('stop', 'second');
  });

  it('opens a normal chat when temporary chats are switched off', async () => {
    mocks.execute.mockImplementation(readyPage());
    const browser = new ChatGptChatBrowser();
    await browser.request('start', payload('Hello', 'first', { temporary: false }));
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/');
    await browser.request('stop', 'first');
  });
});

it('says when the page is still thinking and when its own tool ran, without changing a plain reply', async () => {
  mocks.execute.mockImplementation(readyPage());
  const browser = new ChatGptChatBrowser();
  await browser.request('start', payload('Hello'));
  mocks.execute.mockResolvedValue({ text: '', generating: true, completed: false, alerts: '' });
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: '', done: false, thinking: true });
  mocks.execute.mockResolvedValue({ text: 'Ran it', generating: false, completed: true, alerts: '', ownTools: true });
  await browser.request('poll', 'first');
  expect(JSON.parse(await browser.request('poll', 'first'))).toEqual({ text: 'Ran it', done: true, ownTools: true });
  await browser.request('stop', 'first');
});

