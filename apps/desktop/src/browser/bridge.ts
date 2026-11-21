// Atelier for Chrome and Atelier for Firefox on the desktop's side (docs/ARCHITECTURE.md §22): registers the native
// messaging host with every Chromium browser and Firefox found, listens on a socket only this user can open, and passes
// the core's Browser calls to the extension connected through it. With several browsers connected, calls go to the one
// the person used last, and a chat's tabs stay in the browser that opened them.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_EXTENSION_IDS,
  BROWSER_HOST_NAME,
  BROWSER_PROTOCOL_VERSION,
  FIREFOX_EXTENSION_ID,
  type BrowserInput,
  type BrowserMethods,
  type BrowserStatus,
} from '@atelier/protocol';

/** A browser's own folders: where its native messaging host manifests go, and the registry key on Windows. */
interface BrowserHome {
  name: string;
  /** macOS and Linux: the browser's user data folder; the manifests go in its NativeMessagingHosts. */
  dir?: string;
  /** Where the manifests go when that isn't `dir`/NativeMessagingHosts (Firefox's own folder names). */
  hosts?: string;
  /** Folders whose presence says the browser is installed, when that isn't `dir` itself. */
  seenAt?: string[];
  /** Windows: HKCU\Software\…\NativeMessagingHosts. */
  registry?: string;
  /** Firefox: its manifest allows the add-on by id (`allowed_extensions`) rather than by origin. */
  firefox?: boolean;
}

export function browserHomes(platform: NodeJS.Platform, home: string): BrowserHome[] {
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return [
      // Brave reads Chrome's folder too (seen on a Mac): Chrome's is written whenever either is installed.
      { name: 'Google Chrome', dir: join(support, 'Google', 'Chrome') },
      { name: 'Google Chrome Beta', dir: join(support, 'Google', 'Chrome Beta') },
      { name: 'Google Chrome Canary', dir: join(support, 'Google', 'Chrome Canary') },
      { name: 'Chromium', dir: join(support, 'Chromium') },
      { name: 'Brave', dir: join(support, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Microsoft Edge', dir: join(support, 'Microsoft Edge') },
      { name: 'Arc', dir: join(support, 'Arc', 'User Data') },
      { name: 'Vivaldi', dir: join(support, 'Vivaldi') },
      // Firefox reads ~/Library/Application Support/Mozilla/NativeMessagingHosts; its profiles are in …/Firefox.
      { name: 'Firefox', dir: join(support, 'Mozilla'), seenAt: [join(support, 'Firefox'), join(support, 'Mozilla')], firefox: true },
    ];
  }
  if (platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
    return [
      { name: 'Google Chrome', dir: join(config, 'google-chrome') },
      { name: 'Chromium', dir: join(config, 'chromium') },
      { name: 'Brave', dir: join(config, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Microsoft Edge', dir: join(config, 'microsoft-edge') },
      { name: 'Vivaldi', dir: join(config, 'vivaldi') },
      // Firefox, its snap included (which reads the same folder through the desktop portal), takes ~/.mozilla/native-messaging-hosts.
      { name: 'Firefox', dir: join(home, '.mozilla'), hosts: join(home, '.mozilla', 'native-messaging-hosts'), seenAt: [join(home, '.mozilla'), join(home, 'snap', 'firefox')], firefox: true },
    ];
  }
  if (platform === 'win32') {
    return [
      { name: 'Google Chrome', registry: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' },
      { name: 'Microsoft Edge', registry: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' },
      { name: 'Brave', registry: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts' },
      { name: 'Firefox', registry: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts', firefox: true },
    ];
  }
  return [];
}

/** The manifest a browser reads to start the host for the extension: Chromium's allows origins, Firefox's add-on ids. */
export function hostManifest(path: string, firefox = false): string {
  const allowed = firefox ? { allowed_extensions: [FIREFOX_EXTENSION_ID] } : { allowed_origins: BROWSER_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`) };
  return `${JSON.stringify(
    {
      name: BROWSER_HOST_NAME,
      description: `Atelier for ${firefox ? 'Firefox' : 'Chrome'}: lets the Atelier desktop app work in web pages`,
      path,
      type: 'stdio',
      ...allowed,
    },
    null,
    2,
  )}\n`;
}

/** The script a browser starts: Atelier's own executable in Node mode, running the host with the socket and token named. */
export function hostScript(platform: NodeJS.Platform, executable: string, hostJs: string, socket: string, tokenFile: string): string {
  if (platform === 'win32') {
    return [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `set ATELIER_BROWSER_SOCKET=${socket}`,
      `set ATELIER_BROWSER_TOKEN=${tokenFile}`,
      `"${executable}" "${hostJs}" %*`,
      '',
    ].join('\r\n');
  }
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ATELIER_BROWSER_SOCKET=${quote(socket)} ATELIER_BROWSER_TOKEN=${quote(tokenFile)} exec ${quote(executable)} ${quote(hostJs)} "$@"\n`;
}

/** Where the socket goes: a named pipe on Windows; elsewhere a path short enough for a Unix socket (104 bytes on macOS). */
export function socketPath(platform: NodeJS.Platform, runDir: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\atelier-browser-${userInfo().username}`;
  return join(runDir, 'browser.sock');
}

interface Connected {
  socket: Socket;
  browser: string;
  extensionVersion: string;
  protocol: number;
  input: BrowserInput;
  /** When one of its windows last got the focus (its hello counts as one): the browser used last gets the calls. */
  usedAt: number;
}

export interface BrowserBridge {
  status(): BrowserStatus;
  call<M extends keyof BrowserMethods>(method: M, params: BrowserMethods[M]['params'], timeoutMs?: number): Promise<BrowserMethods[M]['result']>;
  stop(): void;
}

export interface BridgeOptions {
  /** The app's config folder (~/.atelier): run/ holds the socket and the token, browser/ the host script. */
  configDir: string;
  /** Atelier's executable and the host's script, run with ELECTRON_RUN_AS_NODE. */
  executable: string;
  hostJs: string;
  platform?: NodeJS.Platform;
  home?: string;
  /** False leaves the browsers' folders alone (test runs with a config folder of their own). */
  register?: boolean;
  log?: (message: string) => void;
  now?: () => number;
}

/** How often, at most, the host is registered again while no browser is connected (one installed since the app started). */
const REREGISTER_MS = 60_000;

/** The chat a call is for, when it names one: an id, or `{ id, title }`. */
function sessionOf(params: unknown): string | undefined {
  const session = (params as { session?: unknown } | undefined)?.session;
  if (typeof session === 'string') return session;
  if (session && typeof session === 'object' && typeof (session as { id?: unknown }).id === 'string') return (session as { id: string }).id;
  return undefined;
}

/** Writes the host script and the manifests, and listens for the host. */
export function startBrowserBridge(options: BridgeOptions): BrowserBridge {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const runDir = join(options.configDir, 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(runDir, 'browser.token');
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const socket = socketPath(platform, runDir);
  let registeredAt = 0;
  const registerNow = () => {
    if (options.register === false) return;
    registeredAt = now();
    register(platform, options, socket, tokenFile, log);
  };
  registerNow();

  /** Every browser connected now, in the order they came. */
  const connections: Connected[] = [];
  /** Which browser opened each tab, and holds each chat's tabs: their calls go there, whichever browser is in use now. */
  const tabOwners = new Map<number, Connected>();
  const sessionOwners = new Map<string, Connected>();
  let nextId = 1;
  const pending = new Map<number, { to: Connected; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const usable = () => connections.filter((c) => c.protocol === BROWSER_PROTOCOL_VERSION);
  /** The browser in use: the one whose window had the focus last (on a tie, the one that came last). */
  const inUse = () => usable().reduce<Connected | undefined>((best, c) => (!best || c.usedAt >= best.usedAt ? c : best), undefined);
  const live = (c: Connected | undefined) => (c && connections.includes(c) && c.protocol === BROWSER_PROTOCOL_VERSION ? c : undefined);
  const describeOf = (c: Connected) => `${c.browser}, extension ${c.extensionVersion}`;

  const server: Server = createServer((client) => {
    client.setEncoding('utf8');
    let authed = false;
    let lines = '';
    let me: Connected | null = null;
    client.on('data', (chunk: string) => {
      lines += chunk;
      if (lines.length > 32 * 1024 * 1024) return void client.destroy();
      let end: number;
      while ((end = lines.indexOf('\n')) >= 0) {
        const line = lines.slice(0, end);
        lines = lines.slice(end + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return void client.destroy();
        }
        if (!authed) {
          // The host's first line is the token from the file only this user can read.
          const given = Buffer.from(String(message.auth ?? ''));
          const expected = Buffer.from(token);
          if (given.length !== expected.length || !timingSafeEqual(given, expected)) return void client.destroy();
          authed = true;
          continue;
        }
        const hello = message.hello as { protocol?: number; extensionVersion?: string; browser?: string; input?: string } | undefined;
        if (hello) {
          if (me) continue;
          // Extensions before 0.3.0 say nothing of their input: they were all Chrome's, with the debugger.
          me = { socket: client, browser: String(hello.browser ?? 'Chromium'), extensionVersion: String(hello.extensionVersion ?? '?'), protocol: Number(hello.protocol ?? 0), input: hello.input === 'page' ? 'page' : 'trusted', usedAt: now() };
          connections.push(me);
          log(`Atelier browser extension connected: ${describeOf(me)}`);
          continue;
        }
        if (message.focus === true) {
          if (me) me.usedAt = now();
          continue;
        }
        const id = Number(message.id);
        const waiting = pending.get(id);
        if (!waiting || waiting.to.socket !== client) continue;
        pending.delete(id);
        clearTimeout(waiting.timer);
        if (typeof message.error === 'string') waiting.reject(new Error(message.error));
        else waiting.resolve(message.result);
      }
    });
    client.on('close', () => {
      if (!me) return;
      const gone = me;
      connections.splice(connections.indexOf(gone), 1);
      for (const [tab, owner] of tabOwners) if (owner === gone) tabOwners.delete(tab);
      for (const [session, owner] of sessionOwners) if (owner === gone) sessionOwners.delete(session);
      for (const [id, waiting] of pending) {
        if (waiting.to !== gone) continue;
        clearTimeout(waiting.timer);
        waiting.reject(new Error('The browser closed its connection to Atelier.'));
        pending.delete(id);
      }
      log(`Atelier browser extension disconnected: ${describeOf(gone)}`);
    });
    client.on('error', () => client.destroy());
  });
  if (platform !== 'win32') rmSync(socket, { force: true });
  server.listen(socket, () => {
    if (platform !== 'win32') chmodSync(socket, 0o600);
  });
  server.on('error', (error) => log(`Atelier browser extension: the socket couldn't open: ${error.message}`));

  const send = (to: Connected, method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The browser didn't answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      pending.set(id, { to, resolve, reject, timer });
      to.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };

  return {
    status() {
      const using = inUse();
      if (!using) {
        // A browser installed (or run for the first time) since the app started finds the host after this.
        if (now() - registeredAt > REREGISTER_MS) registerNow();
        const other = connections[0];
        if (other) return { connected: false, browser: other.browser, extensionVersion: other.extensionVersion, problem: 'The Atelier browser extension is a different version from this app: update both.' };
        return { connected: false, problem: 'The Atelier browser extension isn’t connected: add Atelier for Chrome (Chrome, Brave, Edge, Arc) or Atelier for Firefox, and keep the browser open.' };
      }
      const others = usable().filter((c) => c !== using).map((c) => ({ browser: c.browser, extensionVersion: c.extensionVersion }));
      return { connected: true, browser: using.browser, extensionVersion: using.extensionVersion, input: using.input, ...(others.length ? { others } : {}) };
    },
    async call(method, params, timeoutMs = 60_000) {
      const fallback = inUse();
      if (!fallback) throw new Error(this.status().problem ?? 'The Atelier browser extension isn’t connected.');
      // A chat's tabs are closed (or renamed) wherever they are: every browser is asked.
      if (method === 'tabs.closeSession' || method === 'tabs.rename') {
        const results = await Promise.all(usable().map((c) => send(c, method, params, timeoutMs).catch(() => null)));
        const session = sessionOf(params);
        if (method === 'tabs.closeSession' && session) sessionOwners.delete(session);
        return (method === 'tabs.closeSession' ? { closed: results.reduce<number>((n, r) => n + ((r as { closed?: number } | null)?.closed ?? 0), 0) } : {}) as never;
      }
      const tab = (params as { tab?: unknown } | undefined)?.tab;
      const session = sessionOf(params);
      const to = (typeof tab === 'number' ? live(tabOwners.get(tab)) : undefined) ?? (session ? live(sessionOwners.get(session)) : undefined) ?? fallback;
      const result = await send(to, method, params, timeoutMs);
      if (method === 'tabs.open') {
        tabOwners.set((result as { tab: number }).tab, to);
        if (session) sessionOwners.set(session, to);
      } else if (method === 'tabs.list') {
        for (const t of (result as { tabs?: { tab: number }[] }).tabs ?? []) tabOwners.set(t.tab, to);
      }
      return result as never;
    },
    stop() {
      server.close();
      for (const c of connections) c.socket.destroy();
      if (platform !== 'win32') rmSync(socket, { force: true });
    },
  };
}

function register(platform: NodeJS.Platform, options: BridgeOptions, socket: string, tokenFile: string, log: (message: string) => void): void {
  const home = options.home ?? homedir();
  const hostDir = join(options.configDir, 'browser');
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  const scriptPath = join(hostDir, platform === 'win32' ? 'atelier-browser-host.cmd' : 'atelier-browser-host');
  writeFileSync(scriptPath, hostScript(platform, options.executable, options.hostJs, socket, tokenFile), { mode: 0o700 });
  const homes = browserHomes(platform, home);
  if (platform === 'win32') {
    // Two manifests: Chromium's and Firefox's allow the extension in different ways.
    const manifests = { chromium: join(hostDir, `${BROWSER_HOST_NAME}.json`), firefox: join(hostDir, `${BROWSER_HOST_NAME}.firefox.json`) };
    writeFileSync(manifests.chromium, hostManifest(scriptPath));
    writeFileSync(manifests.firefox, hostManifest(scriptPath, true));
    for (const browser of homes) {
      const manifestPath = browser.firefox ? manifests.firefox : manifests.chromium;
      execFile('reg', ['add', `${browser.registry}\\${BROWSER_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true }, (error) => {
        if (error) log(`Atelier browser extension: couldn't register with ${browser.name}: ${error.message}`);
      });
    }
    return;
  }
  const installed = homes.filter((b) => b.dir && (b.seenAt ?? [b.dir]).some((path) => existsSync(path)));
  const chrome = homes[0];
  // Brave on a Mac reads Chrome's folder: written when Brave is there even without Chrome.
  if (platform === 'darwin' && chrome && !installed.includes(chrome) && installed.some((b) => b.name === 'Brave')) installed.push(chrome);
  for (const browser of installed) {
    try {
      const dir = browser.hosts ?? join(browser.dir!, 'NativeMessagingHosts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${BROWSER_HOST_NAME}.json`), hostManifest(scriptPath, browser.firefox));
    } catch (error) {
      log(`Atelier browser extension: couldn't register with ${browser.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
