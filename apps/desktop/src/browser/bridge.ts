// Atelier for Chrome on the desktop's side (docs/ARCHITECTURE.md §22): registers the native messaging host with every
// Chromium browser found, listens on a socket only this user can open, and passes the core's Browser calls to the
// extension connected through it.

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
  type BrowserMethods,
  type BrowserStatus,
} from '@atelier/protocol';

/** A browser's own folders: where its native messaging host manifests go, and the registry key on Windows. */
interface BrowserHome {
  name: string;
  /** macOS and Linux: the browser's user data folder; the manifests go in its NativeMessagingHosts. */
  dir?: string;
  /** Windows: HKCU\Software\…\NativeMessagingHosts. */
  registry?: string;
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
    ];
  }
  if (platform === 'win32') {
    return [
      { name: 'Google Chrome', registry: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' },
      { name: 'Microsoft Edge', registry: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' },
      { name: 'Brave', registry: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts' },
    ];
  }
  return [];
}

/** The manifest a browser reads to start the host for the extension. */
export function hostManifest(path: string): string {
  return `${JSON.stringify(
    {
      name: BROWSER_HOST_NAME,
      description: 'Atelier for Chrome: lets the Atelier desktop app work in web pages',
      path,
      type: 'stdio',
      allowed_origins: BROWSER_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
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
}

/** Writes the host script and the manifests, and listens for the host. */
export function startBrowserBridge(options: BridgeOptions): BrowserBridge {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? (() => {});
  const runDir = join(options.configDir, 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(runDir, 'browser.token');
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const socket = socketPath(platform, runDir);
  if (options.register !== false) register(platform, options, socket, tokenFile, log);

  let connected: Connected | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const server: Server = createServer((client) => {
    client.setEncoding('utf8');
    let authed = false;
    let lines = '';
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
        const hello = message.hello as { protocol?: number; extensionVersion?: string; browser?: string } | undefined;
        if (hello) {
          // The latest browser to connect is the one used (a person mostly has one in use).
          connected?.socket.destroy();
          connected = { socket: client, browser: String(hello.browser ?? 'Chromium'), extensionVersion: String(hello.extensionVersion ?? '?'), protocol: Number(hello.protocol ?? 0) };
          log(`Atelier for Chrome connected: ${connected.browser}, extension ${connected.extensionVersion}`);
          continue;
        }
        const id = Number(message.id);
        const waiting = pending.get(id);
        if (!waiting) continue;
        pending.delete(id);
        clearTimeout(waiting.timer);
        if (typeof message.error === 'string') waiting.reject(new Error(message.error));
        else waiting.resolve(message.result);
      }
    });
    client.on('close', () => {
      if (connected?.socket === client) {
        connected = null;
        for (const [id, waiting] of pending) {
          clearTimeout(waiting.timer);
          waiting.reject(new Error('The browser closed its connection to Atelier.'));
          pending.delete(id);
        }
      }
    });
    client.on('error', () => client.destroy());
  });
  if (platform !== 'win32') rmSync(socket, { force: true });
  server.listen(socket, () => {
    if (platform !== 'win32') chmodSync(socket, 0o600);
  });
  server.on('error', (error) => log(`Atelier for Chrome: the socket couldn't open: ${error.message}`));

  return {
    status() {
      if (!connected) return { connected: false, problem: 'Atelier for Chrome isn’t connected: install it in Chrome (or Brave, Edge, Arc) and keep the browser open.' };
      if (connected.protocol !== BROWSER_PROTOCOL_VERSION) {
        return { connected: false, browser: connected.browser, extensionVersion: connected.extensionVersion, problem: 'Atelier for Chrome is a different version from this app: update both.' };
      }
      return { connected: true, browser: connected.browser, extensionVersion: connected.extensionVersion };
    },
    call(method, params, timeoutMs = 60_000) {
      const current = connected;
      if (!current || current.protocol !== BROWSER_PROTOCOL_VERSION) return Promise.reject(new Error(this.status().problem ?? 'Atelier for Chrome isn’t connected.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The browser didn't answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        current.socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    stop() {
      server.close();
      connected?.socket.destroy();
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
  const manifest = hostManifest(scriptPath);
  const homes = browserHomes(platform, home);
  if (platform === 'win32') {
    const manifestPath = join(hostDir, `${BROWSER_HOST_NAME}.json`);
    writeFileSync(manifestPath, manifest);
    for (const browser of homes) {
      execFile('reg', ['add', `${browser.registry}\\${BROWSER_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true }, (error) => {
        if (error) log(`Atelier for Chrome: couldn't register with ${browser.name}: ${error.message}`);
      });
    }
    return;
  }
  const installed = homes.filter((b) => b.dir && existsSync(b.dir));
  const chrome = homes[0];
  // Brave on a Mac reads Chrome's folder: written when Brave is there even without Chrome.
  if (platform === 'darwin' && chrome && !installed.includes(chrome) && installed.some((b) => b.name === 'Brave')) installed.push(chrome);
  for (const browser of installed) {
    try {
      const dir = join(browser.dir!, 'NativeMessagingHosts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${BROWSER_HOST_NAME}.json`), manifest);
    } catch (error) {
      log(`Atelier for Chrome: couldn't register with ${browser.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
