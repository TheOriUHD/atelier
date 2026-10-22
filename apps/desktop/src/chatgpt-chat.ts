import { setTimeout as wait } from 'node:timers/promises';
import { app, BrowserWindow, session } from 'electron';
import { MARKDOWN_SCRIPT } from './chatgpt-markdown.ts';
import { PICKER_SCRIPT } from './chatgpt-picker.ts';

const PARTITION = 'persist:atelier-chatgpt-chat';
const CHAT_URL = 'https://chatgpt.com/';
/** A chat that is neither kept in the account's history nor shaped by (or added to) its memory. */
const TEMPORARY_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
/** How long a page must have been loaded before it takes a file. */
const ATTACH_AFTER_LOAD_MS = 2000;
const STOP = '[data-testid="stop-button"], button[aria-label="Stop generating" i], button[aria-label="Stop streaming" i], form button[aria-label="Stop" i]';
const composerHelpers = `
  const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const composer = () => {
    for (const selector of ['div[role="textbox"].ProseMirror', '#prompt-textarea[contenteditable]', 'textarea#prompt-textarea', 'textarea[name="prompt-textarea"]']) {
      const element = [...document.querySelectorAll(selector)].find(element => visible(element) && !element.disabled && !element.readOnly && (element instanceof HTMLTextAreaElement || element.isContentEditable));
      if (element) return element;
    }
    return null;
  };
  const sendButton = () => {
    const form = composer()?.closest('form');
    if (!form) return null;
    return [...form.elements].filter(element => element instanceof HTMLButtonElement)
      .find(button => (button.matches('[data-testid="send-button"], [aria-label*="Send" i]') || button.type === 'submit') && visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.matches(${JSON.stringify(STOP)}));
  };
  const normalize = (text) => text.normalize('NFC').replace(/\\r\\n?/g, '\\n').replace(/\\u00a0/g, ' ');
  const editorText = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.tagName === 'BR') return node.matches('.ProseMirror-trailingBreak') ? '' : '\\n';
    return [...node.childNodes].map(editorText).join('');
  };
  const composerText = () => {
    const input = composer();
    if (input instanceof HTMLTextAreaElement) return input.value;
    if (!input) return '';
    const blocks = [...input.children].some(child => /^(P|DIV)$/.test(child.tagName));
    return [...input.childNodes].map(node => node.nodeType === Node.ELEMENT_NODE && /^(P|DIV)$/.test(node.tagName) && node.childNodes.length === 1 && node.firstChild.nodeName === 'BR' ? '' : editorText(node)).join(blocks ? '\\n' : '');
  };
  const matchesText = (expected) => { const actual = normalize(composerText()); const wanted = normalize(expected); return actual === wanted || actual === wanted + '\\n'; };
`;
const composerReady = `(() => { ${composerHelpers} return !!composer(); })()`;
const focusComposer = `(() => {
  ${composerHelpers}
  const input = composer();
  if (!input) return false;
  input.focus();
  if (input instanceof HTMLTextAreaElement) input.select();
  else { const selection = window.getSelection(); selection.removeAllRanges(); selection.selectAllChildren(input); }
  return true;
})()`;
const ASSISTANT = '[data-message-author-role="assistant"], [data-conversation-role="assistant"], [data-markdown-text-style="assistant-message"]';
// The assistant messages on the page, as the page shows them: a reply is whatever comes after those that were there when the message was sent.
const messageHelpers = `
  const shown = element => {
    if (!element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    }
    return true;
  };
  const assistantMessages = () => [...document.querySelectorAll(${JSON.stringify(ASSISTANT)})].filter(shown);
`;
const snapshot = (baseline: number) => `(() => {
  ${messageHelpers}
  ${MARKDOWN_SCRIPT}
  const visible = shown;
  const messages = assistantMessages().slice(${Math.max(0, Math.floor(baseline))});
  const last = messages.at(-1);
  const turn = last?.closest('[data-turn-key], article, [data-testid^="conversation-turn-"]') ?? last;
  const user = '[data-user-message-bubble], [data-message-author-role="user"], [data-conversation-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]';
  const answerSelector = '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"] .markdown, [data-conversation-role="assistant"] .markdown';
  const blocks = turn ? [turn, ...turn.querySelectorAll(answerSelector)].filter(element => element.matches(answerSelector) && visible(element) && !element.closest('.result-thinking') && !element.closest(user)) : [];
  const answers = blocks.filter(element => !blocks.some(other => other !== element && other.contains(element)));
  const text = answers.map(element => toMarkdown(element)).filter(Boolean).join('\\n\\n').trim();
  const activity = '[aria-busy="true"], [data-streaming="true"], [data-is-streaming="true"], .loading-shimmer';
  const active = !!turn && [turn, ...turn.querySelectorAll(activity)].some(element => element.matches(activity) && visible(element) && !element.closest(user));
  const generating = active || [...document.querySelectorAll(${JSON.stringify(STOP)})].some(visible);
  const actions = '[data-testid="copy-turn-action-button"], [data-testid="good-response-turn-action-button"], [data-testid="bad-response-turn-action-button"], button[aria-label="Copy response" i], .turn-action-controls button';
  const finalAnswer = answers.at(-1);
  const completed = !!turn && !!finalAnswer && [...turn.querySelectorAll(actions)].some(element => visible(element) && !element.closest(user) && !!(finalAnswer.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
  const alerts = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(el => el.textContent || '').join(' ');
  // ChatGPT shows its own tool use (its Python sandbox) as a button above the reply ("Analyzed", or "Analyzing" while it runs)
  // and a "View analysis" button; the text is read with textContent, since a hidden window has no rendered text.
  const ownTools = !!turn && [...turn.querySelectorAll('button')].some(button => !button.closest(user) && (/^(analy[sz](ed|ing)|running|ran)\\b/i.test((button.textContent || '').trim()) || /view analysis/i.test(button.getAttribute('aria-label') || '')));
  return { text, generating, completed, alerts, ownTools };
})()`;

interface Generation {
  id: string;
  /** Names the conversation as it stands once this reply is complete; the next request names it as its parent to continue it. */
  token: string;
  controller: AbortController;
  preparing?: Promise<void>;
  /** How many assistant messages the page showed when the message was sent: the reply is what comes after them. */
  baseline: number;
  /** The reply is complete: stopping it afterwards (the provider always does, to be sure) leaves the conversation as it is. */
  completed?: boolean;
  /** The text of the last poll that found the reply complete: the page can show its copy buttons a moment before the last paragraph has rendered. */
  settled?: string;
}

interface StartRequest {
  id: string;
  /** The whole conversation, for a chat that starts here. */
  prompt: string;
  /** Only what was added since the conversation the page holds, when `parent` names it. */
  delta?: string;
  parent?: string;
  token: string;
  /** Default true. */
  temporary: boolean;
  /** The model's name in ChatGPT's picker, and the stop of its Power slider (its place and name), when the person chose them. */
  model?: string;
  stop?: { index: number; label: string };
  /** Attached to the message, as base64. */
  files: { name: string; mime: string; data: string }[];
}

export class ChatGptChatBrowser {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private generation: Generation | null = null;
  private since = 0;
  private observed = false;
  /** The conversation the page holds after a complete reply (Generation.token); null once anything went wrong or the page moved on. */
  private chat: string | null = null;
  /** The model and stop set in the page since it last loaded (a new page starts at the account's own); null when none was set. */
  private selected: string | null = null;
  /** When the page last finished loading. */
  private loadedAt = 0;
  /** The account's models with their stops, as the picker lists them; kept a while. */
  private catalog: { at: number; json: string } | null = null;
  /** When a scan last found nothing (no picker on the page, not signed in): another one waits a little. */
  private scanFailedAt = 0;
  private scanning: Promise<unknown> | null = null;

  private async ensure(url = CHAT_URL): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      await this.ready;
      return this.window;
    }
    const browserSession = session.fromPartition(PARTITION);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const win = new BrowserWindow({ title: 'ChatGPT Chat — Atelier', width: 1000, height: 780, show: false, webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const quit = () => win.destroy();
    app.once('before-quit', quit);
    win.on('closed', () => {
      app.removeListener('before-quit', quit);
      if (this.window === win) {
        this.window = null;
        this.chat = null;
        this.selected = null;
        this.catalog = null;
        this.scanFailedAt = 0;
        this.generation?.controller.abort();
        this.generation = null;
      }
    });
    win.on('close', (event) => { event.preventDefault(); win.hide(); });
    this.window = win;
    this.ready = win.loadURL(url).catch((error: unknown) => { win.destroy(); throw error; });
    await this.ready;
    this.loadedAt = Date.now();
    return win;
  }

  private atChat(win: BrowserWindow): boolean {
    const url = win.webContents.getURL();
    return URL.canParse(url) && new URL(url).origin === 'https://chatgpt.com';
  }

  private async waitFor(win: BrowserWindow, script: string, signal: AbortSignal, message: string, limitMs = 20_000): Promise<void> {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (!this.atChat(win)) throw new Error('Finish signing in in the ChatGPT session first.');
      if (await win.webContents.executeJavaScript(script)) return;
      await wait(100, undefined, { signal });
    }
    throw new Error(message);
  }

  private async start(generation: Generation, request: StartRequest): Promise<void> {
    const { signal } = generation.controller;
    await this.scanning?.catch(() => {});
    const existing = this.window && !this.window.isDestroyed();
    const chatUrl = request.temporary ? TEMPORARY_CHAT_URL : CHAT_URL;
    const win = await this.ensure(chatUrl);
    signal.throwIfAborted();
    win.hide();
    // Continue the conversation the page holds when this is its next message; otherwise start a new chat.
    const resume = !!existing && request.parent !== undefined && request.delta !== undefined && this.chat === request.parent && this.atChat(win);
    this.chat = null;
    if (!resume && existing) {
      await win.loadURL(chatUrl);
      this.loadedAt = Date.now();
      this.selected = null;
    }
    const prompt = resume ? request.delta! : request.prompt;
    await this.waitFor(win, composerReady, signal, 'ChatGPT’s message field did not become ready. Open the ChatGPT session to check for sign-in or a page update.');
    await this.select(win, request, signal);
    if (request.files.length > 0) await this.attach(win, request.files, signal);
    const focused = await win.webContents.executeJavaScript(focusComposer);
    signal.throwIfAborted();
    if (!focused) throw new Error('ChatGPT’s message field changed before typing. Open the ChatGPT session to inspect it.');
    await win.webContents.insertText(prompt);
    const textMatches = `(() => { ${composerHelpers} return matchesText(${JSON.stringify(prompt)}); })()`;
    await this.waitFor(win, textMatches, signal, 'ChatGPT’s message field does not contain the complete intended text. Your message was not submitted.');
    await this.waitFor(win, `(() => { ${composerHelpers} return !!sendButton(); })()`, signal, 'ChatGPT’s Send button is missing or disabled. Open the ChatGPT session to check the page. Your message was not submitted.');
    signal.throwIfAborted();
    const baseline = await win.webContents.executeJavaScript(`(() => { ${composerHelpers} ${messageHelpers} const button = sendButton(); if (!button || !matchesText(${JSON.stringify(prompt)})) return -1; const baseline = assistantMessages().length; button.click(); return baseline; })()`) as number;
    if (typeof baseline !== 'number' || baseline < 0) throw new Error('ChatGPT could not send the message. Open the ChatGPT session to inspect it.');
    generation.baseline = baseline;
    this.since = Date.now();
    this.observed = false;
    signal.throwIfAborted();
  }

  /** Sets the model and the Power stop the person chose, unless the page is already set to them. */
  private async select(win: BrowserWindow, request: StartRequest, signal: AbortSignal): Promise<void> {
    if (!request.model && !request.stop) return;
    const wanted = JSON.stringify([request.model ?? null, request.stop ?? null]);
    if (this.selected === wanted) return;
    const result = await win.webContents.executeJavaScript(`(async () => { ${PICKER_SCRIPT} return await picker.apply(${JSON.stringify(request.model ?? null)}, ${request.stop?.index ?? 0}, ${JSON.stringify(request.stop?.label ?? '')}); })()`) as string;
    signal.throwIfAborted();
    // A page whose picker is not found (ChatGPT changed it) is used as it stands: its own model and effort.
    if (result === 'missing') return;
    if (result !== 'ok') {
      const [kind, what] = [result.split(':')[0], result.slice(result.indexOf(':') + 1)];
      throw new Error(kind === 'locked'
        ? `ChatGPT does not offer ${what} on this account right now. Pick another effort.`
        : kind === 'model'
          ? `ChatGPT’s model picker does not list ${what}. Pick another model.`
          : `Atelier could not set ${what} in ChatGPT’s picker. Pick another effort, or open the ChatGPT session to check.`);
    }
    this.selected = wanted;
  }

  /**
   * Adds the files to the message and waits until ChatGPT has taken them all. The page rebuilds its composer shortly
   * after it first shows one, and a file handed to the input it replaced is lost without a sign, so the files are
   * handed over again, to the input as it is then, until a chip for each appears.
   */
  private async attach(win: BrowserWindow, files: StartRequest['files'], signal: AbortSignal): Promise<void> {
    const place = `(() => {
      const input = document.querySelector('input[aria-label="Attach files"]') || [...document.querySelectorAll('input[type="file"]')].find(candidate => !/photo|video/i.test(candidate.getAttribute('aria-label') || ''));
      if (!input) return false;
      const transfer = new DataTransfer();
      for (const file of ${JSON.stringify(files)}) transfer.items.add(new File([Uint8Array.from(atob(file.data), character => character.charCodeAt(0))], file.name, { type: file.mime }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    const taken = `(() => { const form = document.querySelector('form'); return !!form && form.querySelectorAll('button[aria-label^="Remove "]').length >= ${files.length}; })()`;
    // A file given to a page that has only just loaded is dropped (measured: lost at once, taken from a second on).
    const age = Date.now() - this.loadedAt;
    if (age < ATTACH_AFTER_LOAD_MS) await wait(ATTACH_AFTER_LOAD_MS - age, undefined, { signal });
    let found = false;
    for (let attempt = 0; attempt < 5 && !found; attempt++) {
      const placed = await win.webContents.executeJavaScript(place) as boolean;
      signal.throwIfAborted();
      if (!placed) {
        await wait(500, undefined, { signal });
        continue;
      }
      for (let i = 0; i < 12 && !found; i++) {
        found = await win.webContents.executeJavaScript(taken) as boolean;
        if (!found) await wait(250, undefined, { signal });
      }
    }
    if (!found) throw new Error('ChatGPT did not take the attachments. Open the ChatGPT session to check the page.');
    // Send stays enabled while a file uploads, so the progress of each one is what says it is ready.
    await this.waitFor(win, `(() => { const form = document.querySelector('form'); return !!form && form.querySelectorAll('[role="progressbar"][aria-label^="Uploading"]').length === 0; })()`, signal, 'ChatGPT did not finish taking the attachments. Open the ChatGPT session to check them.', 180_000);
  }

  /** The account's models with the stops of their Power slider, read from the picker once in a while. */
  private async models(): Promise<string> {
    if (this.catalog && Date.now() - this.catalog.at < 10 * 60_000) return this.catalog.json;
    const none = JSON.stringify({ models: [] });
    if (this.generation || this.scanning || Date.now() - this.scanFailedAt < 60_000) return this.catalog?.json ?? none;
    const scan = (async () => {
      const win = await this.ensure();
      if (!this.atChat(win)) return none;
      const hasPicker = `!!document.querySelector('button[aria-label="Select ChatGPT model"]')`;
      if (!(await win.webContents.executeJavaScript(hasPicker))) {
        await win.loadURL(TEMPORARY_CHAT_URL);
        this.loadedAt = Date.now();
        this.selected = null;
        this.chat = null;
        // The picker comes up with the composer (measured on chatgpt.com: within a moment of it).
        const until = Date.now() + 20_000;
        while (Date.now() < until && !(await win.webContents.executeJavaScript(composerReady))) await wait(250);
        for (let i = 0; i < 4 && !(await win.webContents.executeJavaScript(hasPicker)); i++) await wait(250);
      }
      const scanned = await win.webContents.executeJavaScript(`(async () => { ${PICKER_SCRIPT} return await picker.scan(); })()`) as unknown[] | null;
      if (!scanned || scanned.length === 0) return none;
      const json = JSON.stringify({ models: scanned });
      this.catalog = { at: Date.now(), json };
      return json;
    })();
    this.scanning = scan.catch(() => none);
    try {
      const json = await scan;
      if (json === none) this.scanFailedAt = Date.now();
      return json;
    } catch (error) {
      this.scanFailedAt = Date.now();
      throw error;
    } finally {
      this.scanning = null;
    }
  }

  /** Ends a generation that is still registered (a stop that never came, a restart of the backend that asked for it): the next request takes over. */
  private async retire(old: Generation | null): Promise<void> {
    if (!old) return;
    old.controller.abort();
    if (!old.completed) this.chat = null;
    await old.preparing?.catch(() => {});
    if (this.window && !this.window.isDestroyed() && this.atChat(this.window)) await this.window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(STOP)})?.click()`).catch(() => {});
  }

  async request(operation: string, value = ''): Promise<string> {
    if (operation === 'hide') {
      this.window?.hide();
      return '{}';
    }
    if (operation === 'disconnect') {
      const old = this.generation;
      await this.retire(old);
      if (this.generation === old) this.generation = null;
      this.chat = null;
      this.selected = null;
      this.catalog = null;
      this.scanFailedAt = 0;
      this.window?.destroy();
      this.window = null;
      await session.fromPartition(PARTITION).clearStorageData();
      return '{}';
    }
    if (operation === 'stop') {
      const generation = this.generation;
      if (!generation || generation.id !== value) return '{}';
      if (generation.completed) {
        this.generation = null;
        return '{}';
      }
      generation.controller.abort();
      this.chat = null;
      try {
        await generation.preparing?.catch(() => {});
        if (this.window && this.atChat(this.window)) await this.window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(STOP)})?.click()`);
      } finally {
        if (this.generation === generation) this.generation = null;
      }
      return '{}';
    }
    if (operation === 'models') return this.models();
    if (operation === 'start') {
      const payload: unknown = JSON.parse(value);
      if (!payload || typeof payload !== 'object' || !('id' in payload) || typeof payload.id !== 'string' || !payload.id || !('prompt' in payload) || typeof payload.prompt !== 'string') throw new Error('Invalid ChatGPT Chat request.');
      const fields = payload as Record<string, unknown>;
      const text = (key: string) => { const field = fields[key]; return typeof field === 'string' && field ? field : undefined; };
      const stop = fields.stop as { index?: unknown; label?: unknown } | undefined;
      const files = Array.isArray(fields.files) ? fields.files.filter((file): file is StartRequest['files'][number] => !!file && typeof file === 'object' && typeof (file as { name?: unknown }).name === 'string' && typeof (file as { mime?: unknown }).mime === 'string' && typeof (file as { data?: unknown }).data === 'string') : [];
      const request: StartRequest = {
        id: payload.id, prompt: payload.prompt, token: text('token') ?? payload.id, temporary: fields.temporary !== false, files,
        ...(text('delta') !== undefined ? { delta: text('delta')! } : {}),
        ...(text('parent') !== undefined ? { parent: text('parent')! } : {}),
        ...(text('model') !== undefined ? { model: text('model')! } : {}),
        ...(stop && typeof stop.index === 'number' && typeof stop.label === 'string' ? { stop: { index: stop.index, label: stop.label } } : {}),
      };
      // One request at a time reaches here (the provider's queue), so one that is still registered was abandoned. The new
      // generation is registered at once, so a stop that follows finds it even while the old one is still being ended.
      const previous = this.generation;
      const generation: Generation = { id: request.id, token: request.token, controller: new AbortController(), baseline: 0 };
      this.generation = generation;
      try {
        generation.preparing = this.retire(previous).then(() => this.start(generation, request));
        await generation.preparing;
        return '{}';
      } catch (error) {
        if (this.generation === generation && !generation.controller.signal.aborted) this.generation = null;
        throw error;
      }
    }
    const win = await this.ensure();
    if (operation === 'open') { win.show(); return '{}'; }
    if (!this.atChat(win)) {
      if (operation === 'status') return JSON.stringify({ signedIn: false });
      throw new Error('Finish signing in in the ChatGPT session first.');
    }
    if (operation === 'status') {
      const signedIn = await win.webContents.executeJavaScript(`(async () => { try { const response = await fetch('/api/auth/session', { credentials: 'include' }); const data = await response.json(); return !!data.accessToken; } catch { return false; } })()`);
      return JSON.stringify({ signedIn: signedIn === true });
    }
    if (operation === 'poll') {
      const generation = this.generation;
      if (!generation || generation.id !== value) throw new Error('No active ChatGPT generation for this request.');
      const state = await win.webContents.executeJavaScript(snapshot(generation.baseline)) as { text: string; generating: boolean; completed: boolean; alerts: string; ownTools?: boolean };
      if (this.generation !== generation || generation.controller.signal.aborted) throw new Error('This ChatGPT generation was stopped.');
      this.observed ||= state.generating;
      if (state.alerts) return JSON.stringify({ text: state.text, done: false, error: state.alerts });
      if (Date.now() - this.since > 15 * 60_000 || (!this.observed && !state.text && Date.now() - this.since > 60_000)) return JSON.stringify({ text: state.text, done: false, error: 'Atelier could not confirm the ChatGPT reply before the timeout. Open the ChatGPT session to check whether it answered before sending again.' });
      const finished = state.completed && !state.generating && !!state.text;
      // Complete once it has looked complete, with the same text, in two polls in a row.
      const done = finished && generation.settled === state.text;
      generation.settled = finished ? state.text : undefined;
      // What the person can be told while nothing has been written yet, and what went wrong with the reply.
      const extra = { ...(state.generating && !state.text ? { thinking: true } : {}), ...(state.ownTools ? { ownTools: true } : {}) };
      if (done) {
        generation.completed = true;
        this.chat = generation.token;
      }
      return JSON.stringify({ text: state.text, done, ...extra });
    }
    throw new Error('Unknown ChatGPT Chat operation.');
  }
}
