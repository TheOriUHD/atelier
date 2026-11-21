import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_EXTENSION_IDS, BROWSER_HOST_NAME, BROWSER_PROTOCOL_VERSION, FIREFOX_EXTENSION_ID } from '@atelier/protocol';
import { browserHomes, hostManifest, hostScript, startBrowserBridge, type BrowserBridge } from './bridge.ts';
import { frame, readFrames } from './host.ts';

const dirs: string[] = [];
const bridges: BrowserBridge[] = [];
afterEach(() => {
  for (const b of bridges.splice(0)) b.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
// Unix socket paths stay under 104 bytes: a short temp folder.
const temp = () => {
  const d = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'atb-'));
  dirs.push(d);
  return d;
};

describe('Atelier for Chrome: the host manifest and script', () => {
  it('names the host, its script and only Atelier’s extension', () => {
    const manifest = JSON.parse(hostManifest('/x/atelier-browser-host'));
    expect(manifest).toEqual({
      name: BROWSER_HOST_NAME,
      description: expect.any(String),
      path: '/x/atelier-browser-host',
      type: 'stdio',
      allowed_origins: BROWSER_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
    });
  });

  it('allows Atelier for Firefox by its add-on id in Firefox’s manifest', () => {
    const manifest = JSON.parse(hostManifest('/x/atelier-browser-host', true));
    expect(manifest).toEqual({ name: BROWSER_HOST_NAME, description: expect.stringContaining('Firefox'), path: '/x/atelier-browser-host', type: 'stdio', allowed_extensions: [FIREFOX_EXTENSION_ID] });
  });

  it('runs Atelier as Node with the socket and token, quoted', () => {
    const script = hostScript('darwin', "/Applications/At'elier.app/Contents/MacOS/Atelier", '/r/browser-host.cjs', '/h/.atelier/run/browser.sock', '/h/.atelier/run/browser.token');
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(script).toContain(`'/Applications/At'\\''elier.app/Contents/MacOS/Atelier'`);
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(hostScript('win32', 'C:\\A\\Atelier.exe', 'C:\\A\\host.cjs', '\\\\.\\pipe\\atelier-browser-me', 'C:\\t')).toContain('set ELECTRON_RUN_AS_NODE=1\r\n');
  });

  it('knows each system’s browser folders', () => {
    const mac = browserHomes('darwin', '/Users/me').map((b) => b.dir);
    expect(mac).toContain('/Users/me/Library/Application Support/Google/Chrome');
    expect(mac).toContain('/Users/me/Library/Application Support/BraveSoftware/Brave-Browser');
    expect(browserHomes('linux', '/home/me').map((b) => b.dir)).toContain(join(process.env.XDG_CONFIG_HOME || '/home/me/.config', 'google-chrome'));
    expect(browserHomes('win32', 'C:\\Users\\me')[0]?.registry).toBe('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts');
    expect(browserHomes('win32', 'C:\\Users\\me').find((b) => b.firefox)?.registry).toBe('HKCU\\Software\\Mozilla\\NativeMessagingHosts');
    expect(browserHomes('linux', '/home/me').find((b) => b.firefox)?.hosts).toBe('/home/me/.mozilla/native-messaging-hosts');
    expect(browserHomes('darwin', '/Users/me').find((b) => b.firefox)?.dir).toBe('/Users/me/Library/Application Support/Mozilla');
  });

  it('registers with Firefox in its own folder, allowing the add-on by id, once Firefox has run', () => {
    if (process.platform === 'win32') return;
    const mac = temp();
    mkdirSync(join(mac, 'Library', 'Application Support', 'Firefox'), { recursive: true });
    bridges.push(startBrowserBridge({ configDir: join(mac, 'config'), executable: '/bin/atelier', hostJs: '/r/host.cjs', platform: 'darwin', home: mac }));
    const written = JSON.parse(readFileSync(join(mac, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', `${BROWSER_HOST_NAME}.json`), 'utf8'));
    expect(written).toMatchObject({ allowed_extensions: [FIREFOX_EXTENSION_ID], path: join(mac, 'config', 'browser', 'atelier-browser-host') });
    const linux = temp();
    mkdirSync(join(linux, 'snap', 'firefox'), { recursive: true });
    bridges.push(startBrowserBridge({ configDir: join(linux, 'config'), executable: '/bin/atelier', hostJs: '/r/host.cjs', platform: 'linux', home: linux }));
    expect(JSON.parse(readFileSync(join(linux, '.mozilla', 'native-messaging-hosts', `${BROWSER_HOST_NAME}.json`), 'utf8'))).toMatchObject({ allowed_extensions: [FIREFOX_EXTENSION_ID] });
    // Without Firefox, nothing of Mozilla's is made.
    const none = temp();
    bridges.push(startBrowserBridge({ configDir: join(none, 'config'), executable: '/bin/atelier', hostJs: '/r/host.cjs', platform: 'linux', home: none }));
    expect(existsSync(join(none, '.mozilla'))).toBe(false);
  });

  it('registers with installed browsers only, and with Chrome’s folder for Brave on a Mac', () => {
    if (process.platform === 'win32') return;
    const home = temp();
    const config = join(home, 'config');
    const brave = join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
    mkdirSync(brave, { recursive: true });
    bridges.push(startBrowserBridge({ configDir: config, executable: '/bin/atelier', hostJs: '/r/host.cjs', platform: 'darwin', home }));
    expect(existsSync(join(brave, 'NativeMessagingHosts', `${BROWSER_HOST_NAME}.json`))).toBe(true);
    expect(existsSync(join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${BROWSER_HOST_NAME}.json`))).toBe(true);
    expect(existsSync(join(home, 'Library', 'Application Support', 'Microsoft Edge'))).toBe(false);
    const script = join(config, 'browser', 'atelier-browser-host');
    expect(statSync(script).mode & 0o777).toBe(0o700);
    expect(statSync(join(config, 'run', 'browser.token')).mode & 0o777).toBe(0o600);
  });

  it('leaves the browsers alone when told to', () => {
    if (process.platform === 'win32') return;
    const home = temp();
    mkdirSync(join(home, 'Library', 'Application Support', 'Google', 'Chrome'), { recursive: true });
    bridges.push(startBrowserBridge({ configDir: join(home, 'config'), executable: '/bin/atelier', hostJs: '/r/host.cjs', platform: 'darwin', home, register: false }));
    expect(existsSync(join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'))).toBe(false);
  });
});

describe('Atelier for Chrome: the socket', () => {
  if (process.platform === 'win32') return;

  const start = () => {
    const home = temp();
    const config = join(home, 'c');
    const bridge = startBrowserBridge({ configDir: config, executable: '/bin/atelier', hostJs: '/r/host.cjs', platform: process.platform, home, register: false });
    bridges.push(bridge);
    return { bridge, socket: join(config, 'run', 'browser.sock'), token: readFileSync(join(config, 'run', 'browser.token'), 'utf8') };
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('is not connected until an extension says hello with the token', async () => {
    const { bridge, socket, token } = start();
    expect(bridge.status()).toMatchObject({ connected: false, problem: expect.stringContaining('isn’t connected') });
    await expect(bridge.call('tabs.list', {})).rejects.toThrow(/isn’t connected/);
    const client = connect(socket);
    await new Promise((r) => client.on('connect', r));
    client.write(`${JSON.stringify({ auth: token })}\n${JSON.stringify({ hello: { protocol: BROWSER_PROTOCOL_VERSION, extensionVersion: '0.1.0', browser: 'Brave 1.74' } })}\n`);
    await until(() => bridge.status().connected);
    expect(bridge.status()).toEqual({ connected: true, browser: 'Brave 1.74', extensionVersion: '0.1.0', input: 'trusted' });
    // A call goes out with an id; the answer with that id settles it.
    client.setEncoding('utf8');
    client.on('data', (line: string) => {
      const request = JSON.parse(line.trim()) as { id: number; method: string };
      client.write(`${JSON.stringify({ id: request.id, result: { tabs: [{ tab: 7, url: 'https://example.com/', title: 'Example' }] } })}\n`);
    });
    await expect(bridge.call('tabs.list', {})).resolves.toEqual({ tabs: [{ tab: 7, url: 'https://example.com/', title: 'Example' }] });
    client.destroy();
    await until(() => !bridge.status().connected);
    expect(bridge.status().connected).toBe(false);
  });

  it('works in the browser used last when two are connected, and keeps a chat’s tabs where they were opened', async () => {
    let clock = 1000;
    const home = temp();
    const config = join(home, 'c');
    const bridge = startBrowserBridge({ configDir: config, executable: '/bin/atelier', hostJs: '/r/host.cjs', platform: process.platform, home, register: false, now: () => clock });
    bridges.push(bridge);
    const token = readFileSync(join(config, 'run', 'browser.token'), 'utf8');
    const seen: Record<string, string[]> = { chrome: [], firefox: [] };
    const join_ = async (name: 'chrome' | 'firefox', hello: object, tabBase: number) => {
      const client = connect(join(config, 'run', 'browser.sock'));
      await new Promise((r) => client.on('connect', r));
      client.setEncoding('utf8');
      client.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const request = JSON.parse(line) as { id: number; method: string; params: { tab?: number } };
          seen[name]!.push(`${request.method}${request.params?.tab !== undefined ? `:${request.params.tab}` : ''}`);
          const result = request.method === 'tabs.open' ? { tab: tabBase, url: 'https://example.com/', title: '' } : request.method === 'tabs.closeSession' ? { closed: 1 } : { tab: request.params.tab ?? 0, url: '', title: '' };
          client.write(`${JSON.stringify({ id: request.id, result })}\n`);
        }
      });
      client.write(`${JSON.stringify({ auth: token })}\n${JSON.stringify({ hello })}\n`);
      return client;
    };
    const chrome = await join_('chrome', { protocol: BROWSER_PROTOCOL_VERSION, extensionVersion: '0.3.0', browser: 'Google Chrome 142', input: 'trusted' }, 100);
    await until(() => bridge.status().connected);
    clock = 2000;
    const firefox = await join_('firefox', { protocol: BROWSER_PROTOCOL_VERSION, extensionVersion: '0.3.0', browser: 'Firefox 158', input: 'page' }, 7);
    await until(() => bridge.status().browser === 'Firefox 158');
    // The one that came last is in use until a window says otherwise; the other is listed.
    expect(bridge.status()).toEqual({ connected: true, browser: 'Firefox 158', extensionVersion: '0.3.0', input: 'page', others: [{ browser: 'Google Chrome 142', extensionVersion: '0.3.0' }] });
    await bridge.call('tabs.open', { url: 'https://example.com/', session: { id: 'chat-1', title: 'Shopping' } });
    // The person goes back to Chrome: new work goes there, chat-1's tab stays in Firefox.
    clock = 3000;
    chrome.write(`${JSON.stringify({ focus: true })}\n`);
    await until(() => bridge.status().browser === 'Google Chrome 142');
    await bridge.call('page.read', { tab: 7 });
    await bridge.call('tabs.open', { url: 'https://example.org/', session: { id: 'chat-2', title: 'Train times' } });
    await bridge.call('tabs.list', { session: 'chat-1' });
    expect(seen.firefox).toEqual(['tabs.open', 'page.read:7', 'tabs.list']);
    expect(seen.chrome).toEqual(['tabs.open']);
    // Deleting a chat closes its tabs in every browser.
    await expect(bridge.call('tabs.closeSession', { session: 'chat-1' })).resolves.toEqual({ closed: 2 });
    // Firefox goes: Chrome stays connected and takes the calls.
    firefox.destroy();
    await until(() => !bridge.status().others);
    expect(bridge.status()).toMatchObject({ connected: true, browser: 'Google Chrome 142' });
    chrome.destroy();
  });

  it('drops a connection without the right token', async () => {
    const { bridge, socket } = start();
    const client = connect(socket);
    await new Promise((r) => client.on('connect', r));
    const closed = new Promise((r) => client.on('close', r));
    client.write(`${JSON.stringify({ auth: 'nope' })}\n${JSON.stringify({ hello: { protocol: 1, extensionVersion: 'x', browser: 'y' } })}\n`);
    await closed;
    expect(bridge.status().connected).toBe(false);
  });

  it('reports an extension of another protocol version instead of using it', async () => {
    const { bridge, socket, token } = start();
    const client = connect(socket);
    await new Promise((r) => client.on('connect', r));
    client.write(`${JSON.stringify({ auth: token })}\n${JSON.stringify({ hello: { protocol: 999, extensionVersion: '9.0.0', browser: 'Chrome 140' } })}\n`);
    await until(() => bridge.status().browser !== undefined);
    expect(bridge.status()).toMatchObject({ connected: false, problem: expect.stringContaining('different version') });
    client.destroy();
  });
});

describe('Atelier for Chrome: the host’s framing', () => {
  it('reads length-prefixed messages and keeps a partial one', () => {
    const a = frame('{"hello":1}');
    const b = frame('{"id":2}');
    const both = Buffer.concat([a, b]);
    const split = readFrames(both.subarray(0, a.length + 3));
    expect(split.messages).toEqual(['{"hello":1}']);
    expect(readFrames(Buffer.concat([split.rest, both.subarray(a.length + 3)])).messages).toEqual(['{"id":2}']);
  });

  it('refuses an absurd length', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff, 0);
    expect(() => readFrames(header)).toThrow(/too large/);
  });
});
