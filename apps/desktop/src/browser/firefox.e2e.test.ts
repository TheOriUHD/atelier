// Atelier for Firefox end to end, in a real Firefox: the add-on built from apps/browser-extension, installed for the run
// through Firefox's WebDriver BiDi (as a temporary add-on, so unsigned is fine), connected through the real native
// messaging host to this bridge, and driven with the same calls the core sends. Only with FIREFOX_E2E=1 (and Firefox
// installed): it starts Firefox headless with a profile of its own, and for the run puts the host's manifest where Firefox
// looks for it (the person's own NativeMessagingHosts folder), putting back whatever was there.
//
//   FIREFOX_E2E=1 npx vitest run src/browser/firefox.e2e.test.ts      (in apps/desktop)
//
// FIREFOX_BIN names another Firefox; FIREFOX_E2E_SHOTS a folder to keep the screenshots in.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_HOST_NAME, type BrowserElement } from '@atelier/protocol';
import { startBrowserBridge, type BrowserBridge } from './bridge.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const extension = join(repo, 'apps', 'browser-extension');
const firefoxBin = process.env.FIREFOX_BIN ?? (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
const enabled = !!process.env.FIREFOX_E2E;

/** Where Firefox reads native messaging host manifests for this user (Windows: the registry, not covered here). */
const hostsDir = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts') : join(homedir(), '.mozilla', 'native-messaging-hosts');

const PAGE = `<!doctype html><html><head><title>Atelier test form</title><style>body{font:16px sans-serif;margin:20px} #tall{height:3000px} #menu-items{display:none} #menu:hover #menu-items,#menu.open #menu-items{display:block}</style></head><body>
<h1>Order form</h1>
<form id="order"><label for="name">Name</label> <input id="name" name="name"> <label for="size">Size</label>
<select id="size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
<label><input type="checkbox" id="gift"> Gift wrap</label> <button type="submit">Place order</button></form>
<p id="state">nothing yet</p><p id="keys"></p>
<textarea id="notes" aria-label="Notes"></textarea>
<div id="editor" contenteditable="true" aria-label="Editor" style="border:1px solid #999;min-height:30px"></div>
<button id="count" type="button">Clicked 0 times</button>
<div id="menu" onmouseover="this.classList.add('open')"><button type="button" id="menu-button">Menu</button><div id="menu-items"><a href="#chosen" id="item">Second item</a></div></div>
<a href="/second" target="_blank">Next page</a>
<div id="tall"></div><p id="bottom">The end</p>
<script>
const state = document.getElementById('state');
const name = document.getElementById('name');
let typed = '';
name.addEventListener('input', (e) => { typed = name.value; state.textContent = 'name=' + typed + ' (' + e.inputType + ')'; });
document.getElementById('order').addEventListener('submit', (e) => { e.preventDefault(); state.textContent = 'submitted ' + name.value + ' ' + document.getElementById('size').value + ' gift=' + document.getElementById('gift').checked; });
let n = 0; document.getElementById('count').addEventListener('click', () => { n++; document.getElementById('count').textContent = 'Clicked ' + n + ' times'; });
document.addEventListener('keydown', (e) => { document.getElementById('keys').textContent += e.key + ' '; });
document.getElementById('editor').addEventListener('input', (e) => { state.textContent = 'editor=' + e.target.textContent; });
</script></body></html>`;

type Call = BrowserBridge['call'];

describe.skipIf(!enabled)('Atelier for Firefox in a real Firefox', () => {
  let work: string;
  let server: Server;
  let base: string;
  let bridge: BrowserBridge;
  let firefox: ChildProcess;
  let saved: string | null = null;
  const manifestPath = join(hostsDir, `${BROWSER_HOST_NAME}.json`);
  const shots = process.env.FIREFOX_E2E_SHOTS;
  let call: Call;
  let bidi: (method: string, params: object) => Promise<Record<string, unknown>>;

  beforeAll(async () => {
    work = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'atff-'));
    execFileSync(process.execPath, [join(extension, 'scripts', 'build.mjs'), '--firefox'], { stdio: 'ignore' });

    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(req.url === '/second' ? '<!doctype html><title>Second page</title><h1>Second page</h1><p>Arrived.</p>' : PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // The bridge writes the host script into a home of its own; its Firefox manifest goes where this Firefox reads it.
    const fakeHome = join(work, 'home');
    mkdirSync(join(fakeHome, 'Library', 'Application Support', 'Firefox'), { recursive: true });
    mkdirSync(join(fakeHome, '.mozilla'), { recursive: true });
    bridge = startBrowserBridge({ configDir: join(work, 'config'), executable: process.execPath, hostJs: join(here, 'host.ts'), home: fakeHome, log: () => {} });
    call = bridge.call.bind(bridge) as Call;
    const written = process.platform === 'darwin' ? join(fakeHome, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', `${BROWSER_HOST_NAME}.json`) : join(fakeHome, '.mozilla', 'native-messaging-hosts', `${BROWSER_HOST_NAME}.json`);
    mkdirSync(hostsDir, { recursive: true });
    if (existsSync(manifestPath)) saved = readFileSync(manifestPath, 'utf8');
    copyFileSync(written, manifestPath);

    const profile = join(work, 'profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, 'user.js'),
      [
        ['browser.shell.checkDefaultBrowser', false],
        ['browser.startup.homepage_override.mstone', 'ignore'],
        ['browser.aboutwelcome.enabled', false],
        ['datareporting.policy.dataSubmissionEnabled', false],
        ['toolkit.telemetry.reportingpolicy.firstRun', false],
        ['browser.tabs.groups.enabled', true],
      ]
        .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join('\n'),
    );
    const port = 9300 + Math.floor(Math.random() * 500);
    firefox = spawn(firefoxBin, ['-headless', '-no-remote', '-profile', profile, '--remote-debugging-port', String(port), '--width', '1280', '--height', '900'], { stdio: 'ignore' });

    // WebDriver BiDi: a session, then the add-on from its folder.
    let socket: WebSocket | null = null;
    for (let i = 0; i < 100 && !socket; i++) {
      await new Promise((r) => setTimeout(r, 200));
      socket = await new Promise<WebSocket | null>((resolve) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/session`);
        s.onopen = () => resolve(s);
        s.onerror = () => resolve(null);
      });
    }
    if (!socket) throw new Error('Firefox did not open WebDriver BiDi.');
    let id = 0;
    bidi = (method: string, params: object) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const mine = ++id;
        const listener = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: string; message?: string };
          if (message.id !== mine) return;
          socket!.removeEventListener('message', listener);
          if (message.error) reject(new Error(`${message.error}: ${message.message}`));
          else resolve(message.result ?? {});
        };
        socket!.addEventListener('message', listener);
        socket!.send(JSON.stringify({ id: mine, method, params }));
      });
    await bidi('session.new', { capabilities: {} });
    await bidi('webExtension.install', { extensionData: { type: 'path', path: join(extension, 'dist-firefox') } });

    for (let i = 0; i < 150 && !bridge.status().connected; i++) await new Promise((r) => setTimeout(r, 200));
  }, 90_000);

  afterAll(() => {
    firefox?.kill();
    bridge?.stop();
    server?.close();
    if (saved !== null) writeFileSync(manifestPath, saved);
    else rmSync(manifestPath, { force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const element = (elements: BrowserElement[] | undefined, name: RegExp) => {
    const found = elements?.find((e) => name.test(e.name));
    if (!found) throw new Error(`No element named ${name}: ${JSON.stringify(elements?.map((e) => e.name))}`);
    return found.ref;
  };
  const text = async (tab: number) => (await call('page.read', { tab, elements: false })).text ?? '';

  it('connects through the native messaging host as Firefox, with input inside the page', () => {
    expect(bridge.status()).toMatchObject({ connected: true, browser: expect.stringMatching(/^Firefox \d+/), input: 'page' });
  });

  it('opens a tab of its own in a chat’s group, reads it, clicks, types, chooses, ticks and submits', async () => {
    const opened = await call('tabs.open', { url: `${base}/form`, session: { id: 'chat-1', title: 'Order a sweater' } });
    expect(opened.title).toBe('Atelier test form');
    const tab = opened.tab;
    await call('overlay.step', { session: { id: 'chat-1', title: 'Order a sweater' }, tab, step: 'Reading page…' });
    const page = await call('page.read', { tab });
    expect(page.text).toContain('Order form');
    // In the chat's tab group, named after it.
    expect((await call('tabs.list', { session: 'chat-1' })).tabs).toEqual([expect.objectContaining({ tab, group: 'Order a sweater' })]);

    // A click: the page's own handler runs.
    const count = element(page.elements, /^Clicked 0 times$/);
    await call('page.click', { tab, ref: count });
    await call('page.click', { tab, ref: count });
    expect(await text(tab)).toContain('Clicked 2 times');

    // Typing into a field: the page sees input events, and the value is there.
    await call('page.type', { tab, ref: element(page.elements, /^Name$/), text: 'Ada' });
    expect(await text(tab)).toMatch(/name=Ada \(insertText\)/);
    await call('page.type', { tab, ref: element(page.elements, /^Name$/), text: 'Grace', replace: true });
    expect(await text(tab)).toContain('name=Grace');

    // A list, a checkbox, then Enter in the field: the form's own submit handler gets it all.
    await call('page.select', { tab, ref: element(page.elements, /^Size$/), option: 'Large' });
    await call('page.click', { tab, ref: element(page.elements, /Gift wrap/) });
    await call('page.type', { tab, ref: element(page.elements, /^Name$/), text: ' Hopper', submit: true });
    expect(await text(tab)).toContain('submitted Grace Hopper l gift=true');
  }, 60_000);

  it('types into a text area and an editable area, presses keys, and moves the focus with Tab', async () => {
    const { tabs } = await call('tabs.list', { session: 'chat-1' });
    const tab = tabs[0]!.tab;
    const page = await call('page.read', { tab });
    await call('page.type', { tab, ref: element(page.elements, /^Notes$/), text: 'line one' });
    await call('page.key', { tab, keys: ['Enter'] });
    await call('page.type', { tab, text: 'line two' });
    const after = await call('page.find', { tab, query: 'Notes' });
    expect(after.elements?.[0]?.value).toBe('line one\nline two');
    await call('page.type', { tab, ref: element(page.elements, /^Editor$/), text: 'Rich text' });
    expect(await text(tab)).toContain('editor=Rich text');
    await call('page.key', { tab, keys: ['Escape'] });
    expect(await text(tab)).toContain('Escape');
  }, 60_000);

  it('opens a hover menu, scrolls, follows a link in the same tab and goes back', async () => {
    const { tabs } = await call('tabs.list', { session: 'chat-1' });
    const tab = tabs[0]!.tab;
    let page = await call('page.read', { tab });
    await call('page.click', { tab, ref: element(page.elements, /^Menu$/) });
    page = await call('page.read', { tab });
    expect(page.elements?.some((e) => e.name === 'Second item')).toBe(true);
    await call('page.scroll', { tab, dy: 2500 });
    page = await call('page.read', { tab });
    expect(page.elements?.find((e) => e.name === 'Next page')?.visible).toBe(false);
    const moved = await call('page.click', { tab, ref: element(page.elements, /^Next page$/) });
    expect(moved.title).toBe('Second page');
    expect((await call('tabs.list', { session: 'chat-1' })).tabs).toHaveLength(1);
    const back = await call('page.back', { tab });
    expect(back.title).toBe('Atelier test form');
  }, 60_000);

  it('takes a screenshot of its tab in the background, at most the width asked for', async () => {
    const { tabs } = await call('tabs.list', { session: 'chat-1' });
    const shot = await call('page.screenshot', { tab: tabs[0]!.tab, maxWidth: 800 });
    const bytes = Buffer.from(shot.data, 'base64');
    expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(shot.width).toBeLessThanOrEqual(800);
    expect(shot.height).toBeGreaterThan(100);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, 'firefox-screenshot.jpg'), bytes);
    }
  }, 60_000);

  it('shows the glow and the label in the tab, as the person sees it when they look', async () => {
    const { tabs } = await call('tabs.list', { session: 'chat-1' });
    await call('overlay.step', { session: { id: 'chat-1', title: 'Order a sweater' }, tab: tabs[0]!.tab, step: 'Clicking “Place order”…' });
    // A tab in the background doesn't run its animations: the label slides in once it is in front.
    const tree = (await bidi('browsingContext.getTree', {})) as { contexts: { context: string; url: string }[] };
    const context = tree.contexts.find((c) => c.url.startsWith(`${base}/form`))!.context;
    await bidi('browsingContext.activate', { context });
    await new Promise((r) => setTimeout(r, 800));
    const drawn = Buffer.from(String((await bidi('browsingContext.captureScreenshot', { context })).data), 'base64');
    expect(drawn.length).toBeGreaterThan(1000);
    if (shots) {
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, 'firefox-overlay.png'), drawn);
    }
  }, 30_000);

  it('stays connected while idle (the background script isn’t put to sleep with the host open)', async () => {
    await new Promise((r) => setTimeout(r, 45_000));
    expect(bridge.status().connected).toBe(true);
    const { tabs } = await call('tabs.list', { session: 'chat-1' });
    expect(tabs).toHaveLength(1);
  }, 70_000);

  it('closes a chat’s tabs when the chat goes', async () => {
    await call('overlay.end', { session: 'chat-1', state: 'done' });
    await expect(call('tabs.closeSession', { session: 'chat-1' })).resolves.toEqual({ closed: 1 });
    expect((await call('tabs.list', { session: 'chat-1' })).tabs).toEqual([]);
  }, 30_000);
});
