/**
 * Electron main process: window chrome, custom protocols, menus and OS integration only.
 * All application logic runs in a utility process: the embedded backend (backend.ts), or in server mode
 * a relay to the Atelier server (remote.ts).
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, net, powerSaveBlocker, protocol, safeStorage, session, shell, systemPreferences, utilityProcess, webContents, type UtilityProcess, type WebContents } from 'electron';
import { ChatGptChatBrowser } from './chatgpt-chat.ts';
import { autoUpdater } from 'electron-updater';
import { execFile } from 'node:child_process';
import { access, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { basename, join, normalize, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { APP, artifactRuntimeCsp } from '@atelier/protocol';
import type { BackendToMain, MainToBackend, MenuCommand } from './bridge.ts';

import { BROWSER_PARTITION, attachGuest, fetchFavicon, hardenWebview, prepareBrowserSession, type BrowserEvents } from './browser.ts';
import type { LinkProblem } from './link-problem.ts';
import type { Connection } from './connection.ts';
import { scanNetwork } from './discovery.ts';
import { healthCheck, resolveConnection } from './server-url.ts';
import { localDataDir } from './data-dir.ts';
import { readTrustedFolders, trustedPath } from './device-link.ts';
import { KeepAwake } from './keep-awake.ts';
import { FileReads, PAGES_PRIVILEGES, PAGES_SCHEME, WorkspacePages } from './workspace-pages.ts';
import { loginItem } from './login-item.ts';
import { loginShellPath, mergePaths } from './shell-path.ts';
import { createBundleSwap } from './bundle-swap.ts';
import { createUpdates, inertUpdater, type Updater } from './updater.ts';
import {
  clearConnection,
  clearToken,
  loadConnection,
  loadDevice,
  loadToken,
  loadUpdateSettings,
  saveConnection,
  saveToken,
  saveUpdateSettings,
  tokenTarget,
  trustedFoldersFile,
  trustFolder,
  workspaceRoot,
  type Device,
} from './user-data.ts';

const chatgptChatBrowser = new ChatGptChatBrowser();
const DEV_URL = process.env.ATELIER_DEV_URL;
const UI_DIR = join(import.meta.dirname, 'ui');
const isMac = process.platform === 'darwin';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: `${APP.scheme}-blob`, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: `${APP.scheme}-artifact`, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: PAGES_SCHEME, privileges: PAGES_PRIVILEGES },
]);

// The name first: the profile folder (userData) and the single-instance lock take their name from it, not from the package's.
app.setName(APP.name);
if (!app.requestSingleInstanceLock()) app.quit();

/** Null until the first-run choice; no backend runs before it. */
let connection: Connection | null = null;
/** The sign-in token for `connection`. It is only ever sent to that backend. */
let token: string | null = null;
/** Server mode: why the server can't be reached right now (relay's diagnosis), null while it can. Shown on the "Connecting…" screen. */
let linkProblem: LinkProblem | null = null;
let device: Device;
/** Read while Electron starts up; the backend and its runners use it to find programs (see shell-path.ts). */
const shellPath = loginShellPath();
let path = process.env.PATH;

let updates: ReturnType<typeof createUpdates>;

/** electron-updater's updater. Some runs can't build it, and a missing updater must never keep Atelier from opening. */
function loadUpdater(): Updater {
  try {
    return autoUpdater;
  } catch (error) {
    console.warn('Updates are unavailable:', error instanceof Error ? error.message : error);
    return inertUpdater();
  }
}
/** Updates come from the server this app is signed in to (updater.ts). */
const followConnection = () => updates.setServer(connection?.mode === 'server' ? { url: connection.serverUrl, token } : null);
// A check reads one small latest*.yml, so a new version reaches people within minutes at no real cost.
const CHECK_EVERY_MS = 5 * 60_000;

const launchAtLogin = loginItem({
  platform: process.platform,
  app,
  autostartDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart'),
  // An AppImage runs from a new mount point each time; the entry starts the image itself.
  executable: process.env.APPIMAGE ?? process.execPath,
  fs: { access, mkdir, writeFile, rm },
});

/** Code sessions' "Keep computer awake". */
const keepAwake = new KeepAwake(powerSaveBlocker);

/** The Browser pane's pages talk to the window showing them. */
const browserEvents: BrowserEvents = {
  open: (host, event) => host.send('browser:open', event),
  downloadBlocked: (host, event) => host.send('browser:download-blocked', event),
};

/** Workspace files shown in the Browser pane, read by the window that opened them (workspace-pages.ts). */
const fileReads = new FileReads((host, request) => {
  const contents = webContents.fromId(host);
  if (!contents || contents.isDestroyed()) return false;
  contents.send('browser:read-file', request);
  return true;
});
const workspacePages = new WorkspacePages(fileReads.read);

/** Settings › System's data folder: the built-in backend's data, or in server mode this app's own folder. */
const dataFolder = () => (connection?.mode === 'local' ? localDataDir() : app.getPath('userData'));

/** Where "Show in Finder" may look: the folders the person trusted here and the built-in backend's scratch folders. */
async function revealableFolders(): Promise<string[]> {
  const trusted = await readTrustedFolders(trustedFoldersFile());
  const scratch = connection?.mode === 'local' ? await realpath(join(localDataDir(), 'scratch-workspaces')).catch(() => null) : null;
  return scratch ? [...trusted, scratch] : trusted;
}

let backend: UtilityProcess | null = null;
let backendReady = false;
/** Renderers that asked for a port before the backend was ready. */
const waiting = new Set<WebContents>();
let blobSeq = 1;
const blobWaiters = new Map<number, (r: Extract<BackendToMain, { kind: 'blob' }>) => void>();

/** The runner builds: bundled as a resource when packaged, `runner/bin` (from `pnpm runner:build`) in development. */
function runnerDir(): string {
  // In development this file runs from apps/desktop/dist.
  return app.isPackaged ? join(process.resourcesPath, 'runner') : join(import.meta.dirname, '..', '..', '..', 'runner', 'bin');
}

function startBackend(): void {
  if (!connection) return;
  linkProblem = null;
  // Both find the runner: the local backend runs workspaces itself, the server relay lends it over the device link.
  const env = { ...process.env, PATH: path, ATELIER_RUNNER_DIR: runnerDir(), ATELIER_TRUSTED_FOLDERS: trustedFoldersFile() };
  const child =
    connection.mode === 'server'
      ? utilityProcess.fork(join(import.meta.dirname, 'remote.mjs'), [connection.serverUrl, JSON.stringify(device)], { serviceName: `${APP.name} Connection`, stdio: 'inherit', env })
      : utilityProcess.fork(join(import.meta.dirname, 'backend.mjs'), [], { serviceName: `${APP.name} Backend`, stdio: 'inherit', env });
  backend = child;
  backendReady = false;
  child.on('message', async (m: BackendToMain) => {
    if (m.kind === 'ready') {
      backendReady = true;
      post({ kind: 'token', token });
      for (const contents of waiting) link(contents);
      waiting.clear();
      void updates.checkAutomatically();
    } else if (m.kind === 'link') {
      linkProblem = m.problem;
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('connection:problem', linkProblem);
    } else if (m.kind === 'blob') {
      blobWaiters.get(m.id)?.(m);
      blobWaiters.delete(m.id);
    } else if (m.kind === 'req') {
      try {
        const value =
          m.op === 'chatgptChat' ? await chatgptChatBrowser.request(m.operation, m.value) : m.op === 'encrypt'
            ? (await safeStorage.encryptStringAsync(m.value)).toString('base64')
            : (await safeStorage.decryptStringAsync(Buffer.from(m.value, 'base64'))).result;
        child.postMessage({ kind: 'res', id: m.id, ok: true, value } satisfies MainToBackend);
      } catch (error) {
        child.postMessage({ kind: 'res', id: m.id, ok: false, error: error instanceof Error ? error.message : 'safeStorage failed' } satisfies MainToBackend);
      }
    }
  });
  child.on('exit', (code) => {
    // Blob reads it never answered fail instead of hanging.
    for (const [id, resolve] of blobWaiters) resolve({ kind: 'blob', id, found: false });
    blobWaiters.clear();
    if (backend !== child) return;
    backend = null;
    // Restart after an unexpected crash. Renderer ports close with the process, and renderers ask for new ones.
    if (code !== 0 && !quitting) setTimeout(startBackend, 500);
  });
}

function stopBackend(): Promise<void> {
  const child = backend;
  backend = null;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.postMessage({ kind: 'shutdown' } satisfies MainToBackend);
    setTimeout(() => child.kill(), 5000).unref();
  });
}

function post(message: MainToBackend, transfer: Electron.MessagePortMain[] = []): void {
  backend?.postMessage(message, transfer);
}

/** Hands a renderer a MessagePort to the backend, or in server mode to the relay. */
function link(contents: WebContents): void {
  if (contents.isDestroyed() || !backend) return;
  const { port1, port2 } = new MessageChannelMain();
  post({ kind: 'connect', ...(token ? { token } : {}) }, [port1]);
  contents.postMessage('backend-port', null, [port2]);
}

function connectRenderer(contents: WebContents): void {
  if (backend && backendReady) link(contents);
  else waiting.add(contents);
}

type BlobBody = { body: BodyInit; mime: string } | undefined;

function readLocalBlob(sha256: string): Promise<BlobBody> {
  if (!backend || !backendReady) return Promise.resolve(undefined);
  const id = blobSeq++;
  return new Promise((resolve) => {
    blobWaiters.set(id, (r) => resolve(r.found ? { body: r.bytes, mime: r.mime } : undefined));
    post({ kind: 'blob', id, sha256 });
  });
}

/** Server mode: main fetches blobs with the token, so the renderer never talks to the server itself. */
async function fetchServerBlob(serverUrl: string, sha256: string): Promise<BlobBody> {
  const response = await fetch(`${serverUrl}/api/blobs/${sha256}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
  if (!response?.ok || !response.body) return undefined;
  return { body: response.body, mime: response.headers.get('content-type') ?? 'application/octet-stream' };
}

// The web server's /api/blobs policy: only common image types render inline.
const INLINE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

function blobResponse({ body, mime }: NonNullable<BlobBody>): Response {
  const inline = INLINE_TYPES.test(mime);
  return new Response(body, {
    headers: {
      'Content-Type': inline ? mime : 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : 'attachment',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${APP.scheme}-blob:`,
  "font-src 'self' data:",
  `connect-src 'self' ${APP.scheme}-blob:`,
  `frame-src blob: ${APP.scheme}-artifact: ${APP.scheme}-blob:`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

const ARTIFACT_CSP = artifactRuntimeCsp(`${APP.scheme}-artifact:`);

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

function registerProtocols(): void {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(UI_DIR, safe);
    if (!file.startsWith(UI_DIR) || !extname(file)) file = join(UI_DIR, 'index.html');
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    return new Response(response.body, { status: response.status, headers });
  });
  // The artifact runtime gets its own origin. It is framed with sandbox="allow-scripts" (an opaque origin),
  // so its module scripts are CORS requests from "null".
  protocol.handle(`${APP.scheme}-artifact`, async (request) => {
    const { pathname } = new URL(request.url);
    const safe = normalize(decodeURIComponent(pathname));
    if (!/^[/\\](artifact-runtime[/\\]index\.html|inline-visual\.html|assets[/\\][^/\\]+)$/.test(safe)) return new Response('Not found', { status: 404 });
    const file = join(UI_DIR, safe);
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers({ 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    if (file.endsWith('.html')) headers.set('Content-Security-Policy', ARTIFACT_CSP);
    return new Response(response.body, { status: response.status, headers });
  });
  protocol.handle(`${APP.scheme}-blob`, async (request) => {
    const sha = new URL(request.url).hostname;
    if (!/^[0-9a-f]{64}$/.test(sha)) return new Response('Not found', { status: 404 });
    const blob = connection?.mode === 'server' ? await fetchServerBlob(connection.serverUrl, sha) : await readLocalBlob(sha);
    return blob ? blobResponse(blob) : new Response('Not found', { status: 404 });
  });
}

/**
 * Windows and Linux draw the window buttons over the top-right corner (the title bar overlay). They are 36px tall, a
 * normal caption-button height, not the 48px of the page's header; the page keeps its own controls clear of them with
 * `--at-window-controls` (packages/ui/src/styles.css).
 */
const THEME_OVERLAY = {
  light: { color: '#00000000', symbolColor: '#52514E', height: 36 },
  dark: { color: '#00000000', symbolColor: '#C3C2B7', height: 36 },
};

/** `hash` opens a window on a route of the app ("#/code/<id>"), for "Open in new window". */
function createWindow(hash = ''): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#FCFCFB',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 18 } } : { titleBarOverlay: THEME_OVERLAY.light }),
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // A hidden test window (ATELIER_HIDE_WINDOW) must keep running timers and frames like a shown one.
      ...(process.env.ATELIER_HIDE_WINDOW ? { backgroundThrottling: false } : {}),
      // The Code Browser pane; each page is hardened as it attaches (browser.ts).
      webviewTag: true,
      // Read synchronously by the preload as `atelierDesktop.device`.
      additionalArguments: [`--atelier-device=${JSON.stringify(device)}`],
    },
  });
  // End-to-end runs set ATELIER_HIDE_WINDOW: the page works the same unseen, and no test window takes the screen or focus.
  if (!process.env.ATELIER_HIDE_WINDOW) win.once('ready-to-show', () => win.show());
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!hardenWebview(webPreferences, params)) event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_event, guest) => attachGuest(guest, win.webContents, browserEvents));
  // A reload or a crash starts the page over: it says again what it keeps awake.
  const id = win.webContents.id;
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) keepAwake.release(id);
  });
  win.webContents.on('render-process-gone', () => keepAwake.release(id));
  win.webContents.once('destroyed', () => {
    keepAwake.release(id);
    workspacePages.forget(id);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('app://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  void win.loadURL((DEV_URL ?? 'app://ui/index.html') + hash);
  return win;
}

function sendMenu(command: MenuCommand): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu', command);
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-chat') },
        { label: 'New Temporary Chat', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenu('new-temporary-chat') },
        // Only the built-in backend has a screen lock; a server's sign-in is its own.
        ...(connection?.mode === 'local' ? [{ type: 'separator' as const }, { label: 'Lock Atelier', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendMenu('lock') }] : []),
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') }, { type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => sendMenu('toggle-sidebar') },
        { label: 'Search', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('command-palette') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }, { role: 'reload' as const }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const Theme = z.enum(['light', 'dark']);
const UpdateChannel = z.enum(['stable', 'beta']);
const ExternalUrl = z.string().regex(/^https?:\/\//);
const Token = z.string().min(1).max(512);
/** Permissions the renderer may get; everything else (camera, location, …) is denied. */
const SaveBlob = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), name: z.string().min(1).max(255) });

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications']);
const SessionIds = z.array(z.string().min(1).max(100)).max(1000);
const WorkspaceId = z.string().min(1).max(200);
// base64 of the backend's 16 MiB cap, with room for padding.
const FileAnswer = z.object({ id: z.number().int().positive(), dataBase64: z.string().max(23_000_000).nullable() });

function registerIpc(): void {
  ipcMain.on('connect-backend', (event) => connectRenderer(event.sender));
  ipcMain.on('theme', (event, input: unknown) => {
    const theme = Theme.safeParse(input);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!theme.success || !win) return;
    win.setBackgroundColor(theme.data === 'dark' ? '#151515' : '#FCFCFB');
    if (!isMac) win.setTitleBarOverlay(THEME_OVERLAY[theme.data]);
  });
  ipcMain.on('keep-awake:set', (event, input: unknown) => {
    const ids = SessionIds.safeParse(input);
    if (ids.success) keepAwake.set(event.sender.id, ids.data);
  });
  ipcMain.handle('browser:serve', (event, input: unknown) => {
    // Only the app's windows read workspaces; a page in the pane has no bridge, but never trust that alone.
    if (!BrowserWindow.fromWebContents(event.sender)) throw new Error('Not a window of the app');
    return workspacePages.origin(event.sender.id, WorkspaceId.parse(input));
  });
  ipcMain.on('browser:file', (event, input: unknown) => {
    const answer = FileAnswer.safeParse(input);
    if (answer.success) fileReads.answer(event.sender.id, answer.data.id, answer.data.dataBase64);
  });
  ipcMain.handle('browser:favicon', (_e, input: unknown) => fetchFavicon(session.fromPartition(BROWSER_PARTITION), z.string().max(2048).parse(input)));
  ipcMain.on('open-external', (_e, input: unknown) => {
    const url = ExternalUrl.safeParse(input);
    if (url.success) void shell.openExternal(url.data);
  });
  ipcMain.handle('connection:get', () => ({ mode: connection?.mode ?? null, serverUrl: connection?.mode === 'server' ? connection.serverUrl : null }));
  ipcMain.handle('connection:problem', () => linkProblem);
  // macOS asks once whether an app may reach the local network, and answers every later request with a silent failure
  // when it was refused; its switch for the app is the only way to change that.
  ipcMain.handle('connection:openNetworkSettings', async () => {
    if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork');
  });
  /** Resolves to an error message for the user, or switches backends and reloads the window. */
  ipcMain.handle('connection:set', async (event, input: unknown): Promise<string | null> => {
    let next: Connection;
    try {
      // A server must answer before the app switches to it; an address without a scheme tries https://, then http://.
      next = await resolveConnection(input, healthCheck());
    } catch (error) {
      return (error as Error).message;
    }
    await saveConnection(next);
    await clearToken();
    connection = next;
    token = null;
    followConnection();
    buildMenu();
    await stopBackend();
    // A second switch may have finished while this one waited; its backend already matches `connection`.
    if (!backend) startBackend();
    event.sender.reload();
    return null;
  });
  /** Settings › Account's "Sign out" / "Change setup…": back to the first-run choice. The built-in backend's data stays. */
  ipcMain.handle('connection:reset', async () => {
    await clearConnection();
    await clearToken();
    connection = null;
    token = null;
    linkProblem = null;
    followConnection();
    buildMenu();
    await stopBackend();
    for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
  });
  // The first-run choice's "Found on your network"; each server is sent to the page as it answers.
  ipcMain.handle('discovery:scan', (event) =>
    scanNetwork({
      interfaces: networkInterfaces(),
      fetch,
      onFound: (server) => {
        if (!event.sender.isDestroyed()) event.sender.send('discovery:found', server);
      },
    }),
  );
  ipcMain.handle('session:save', async (_e, input: unknown) => {
    const value = Token.parse(input);
    if (!connection) throw new Error('Choose a connection first.');
    // Where this computer has no secure storage (Windows without a usable user key, Linux without a keyring), the
    // sign-in still works for this run; it just isn't kept for the next start.
    let remembered = true;
    try {
      await saveToken(tokenTarget(connection), value);
    } catch (error) {
      remembered = false;
      console.warn('The sign-in could not be stored:', error instanceof Error ? error.message : error);
      await clearToken().catch(() => undefined);
    }
    // Ports handed out from now on carry it; the current one is already signed in.
    token = value;
    post({ kind: 'token', token });
    followConnection();
    // The check at start skipped a signed-out server.
    void updates.checkAutomatically();
    return { remembered };
  });
  ipcMain.handle('session:clear', async () => {
    await clearToken();
    token = null;
    post({ kind: 'token', token });
    followConnection();
  });
  // A forgotten screen lock PIN: macOS's Touch ID proves the person owns this OS account, who could delete the lock file anyway.
  ipcMain.handle('lock:canUseSystem', () => connection?.mode === 'local' && isMac && systemPreferences.canPromptTouchID());
  ipcMain.handle('lock:removeWithSystem', async (): Promise<'removed' | 'cancelled' | 'unavailable'> => {
    if (connection?.mode !== 'local' || !isMac || !systemPreferences.canPromptTouchID()) return 'unavailable';
    try {
      await systemPreferences.promptTouchID('remove the Atelier screen lock');
    } catch {
      return 'cancelled';
    }
    post({ kind: 'removeScreenLock' });
    return 'removed';
  });
  // Settings › System.
  ipcMain.handle('updates:status', () => updates.status());
  ipcMain.handle('updates:check', () => updates.check());
  ipcMain.handle('updates:setChannel', (_e, input: unknown) => updates.setChannel(UpdateChannel.parse(input)));
  ipcMain.handle('updates:setAutomatic', (_e, input: unknown) => updates.setAutomatic(z.boolean().parse(input)));
  ipcMain.handle('updates:download', () => updates.download());
  ipcMain.handle('updates:install', () => updates.install());
  ipcMain.handle('system:get', async () => ({ openAtLogin: await launchAtLogin.get(), dataFolder: dataFolder() }));
  ipcMain.handle('system:setOpenAtLogin', (_e, input: unknown) => launchAtLogin.set(z.boolean().parse(input)));
  ipcMain.handle('system:showDataFolder', async () => {
    const error = await shell.openPath(dataFolder());
    if (error) throw new Error(error);
  });
  // Work's output files: reveal one in the file manager, but only inside a folder the person trusted here or a scratch folder.
  // Saves a stored file (a privacy export) where the person chooses; `<a download>` can't reach the blob scheme.
  ipcMain.handle('files:saveBlob', async (event, input: unknown): Promise<boolean> => {
    const { sha256, name } = SaveBlob.parse(input);
    const win = BrowserWindow.fromWebContents(event.sender);
    const blob = connection?.mode === 'server' ? await fetchServerBlob(connection.serverUrl, sha256) : await readLocalBlob(sha256);
    if (!win || !blob) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: join(app.getPath('downloads'), basename(name)) });
    if (canceled || !filePath) return false;
    await writeFile(filePath, Buffer.from(await new Response(blob.body).arrayBuffer()));
    return true;
  });
  ipcMain.handle('files:reveal', async (_e, input: unknown): Promise<boolean> => {
    const path = await trustedPath(input, await revealableFolders());
    if (path) shell.showItemInFolder(path);
    return !!path;
  });
  // "Open in › Cursor / VS Code": the folder of a session, only when it lies in a folder trusted on this machine.
  ipcMain.handle('files:openIn', async (_e, input: unknown): Promise<boolean> => {
    const { editor, path } = z.object({ editor: z.enum(['cursor', 'vscode']), path: z.string().max(4096) }).parse(input);
    const folder = await trustedPath(path, await revealableFolders());
    if (!folder) return false;
    const [command, args]: [string, string[]] = isMac
      ? ['open', ['-a', editor === 'cursor' ? 'Cursor' : 'Visual Studio Code', folder]]
      : [editor === 'cursor' ? 'cursor' : 'code', [folder]];
    return new Promise((resolve) => execFile(command, args, { windowsHide: true, shell: process.platform === 'win32' }, (error) => resolve(!error)));
  });
  // "Open in › New window": a window with only that session in it (`?solo=1`: no sidebar).
  ipcMain.handle('window:open', (_e, input: unknown): boolean => {
    createWindow(z.string().regex(/^#\/(code|work|chat)\/[A-Za-z0-9_-]{1,64}(\?solo=1)?$/).parse(input));
    return true;
  });
  // A notification was clicked: bring its window to the front.
  ipcMain.on('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (isMac) app.focus({ steal: true });
  });
  // An SSH key: any file, starting in ~/.ssh (its dot-folder shown). Only the path comes back: the file isn't read here.
  ipcMain.handle('files:pickKey', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { title: 'Choose an SSH key', defaultPath: join(homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return null;
    const home = homedir();
    return picked.startsWith(`${home}/`) ? `~/${picked.slice(home.length + 1)}` : picked;
  });
  ipcMain.handle('folders:pick', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { title: 'Open a folder', properties: ['openDirectory', 'createDirectory'] });
    const picked = result.filePaths[0];
    // Not trusted yet: the app asks "Trust this workspace?" first, then calls `folders:trust`.
    return result.canceled || !picked ? null : workspaceRoot(picked);
  });
  ipcMain.handle('folders:trust', async (_event, path: unknown): Promise<string> => {
    if (typeof path !== 'string' || !path) throw new Error('No folder.');
    return trustFolder(path);
  });
}

let quitting = false;

app.whenReady().then(async () => {
  // A packaged app has its icon in the bundle; run from the bare Electron binary (development), the Dock would show
  // Electron's.
  if (process.env.ATELIER_HIDE_WINDOW) app.dock?.hide();
  if (!app.isPackaged) {
    try {
      app.dock?.setIcon(join(import.meta.dirname, '..', 'resources', 'icon.png'));
    } catch {
      // No icon file (a stripped build): keep Electron's.
    }
  }
  registerProtocols();
  buildMenu();
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  prepareBrowserSession(session.fromPartition(BROWSER_PARTITION), browserEvents);
  session.fromPartition(BROWSER_PARTITION).protocol.handle(PAGES_SCHEME, (request) => workspacePages.handle(request));
  [device, connection] = await Promise.all([loadDevice(), loadConnection(), shellPath.then((p) => void (path = mergePaths(p, process.env.PATH)))]);
  buildMenu();
  if (connection) token = await loadToken(tokenTarget(connection));
  const updateSettings = await loadUpdateSettings();
  updates = createUpdates({
    updater: loadUpdater(),
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    channel: updateSettings.channel,
    saveChannel: (channel) => saveUpdateSettings({ channel }),
    automatic: updateSettings.automatic,
    saveAutomatic: (automatic) => saveUpdateSettings({ automatic }),
    fetch: (url, init) => net.fetch(url, init),
    downloads: app.getPath('downloads'),
    reveal: (file) => shell.showItemInFolder(file),
    onStatus: (status) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('updates:status', status);
    },
    // `off` (end-to-end runs) keeps the app from asking the public feed anything.
    publicFeed: process.env.ATELIER_UPDATE_FEED === 'off' ? null : process.env.ATELIER_UPDATE_FEED || APP.updateFeed,
    publicKey: APP.updatePublicKey || null,
    // macOS replaces its own app bundle (bundle-swap.ts); a copy that isn't installed in a writable place offers the disk image.
    swap: process.platform === 'darwin' && app.isPackaged ? createBundleSwap(process.execPath, join(app.getPath('userData'), 'update-staging')) : null,
    quit: () => app.quit(),
  });
  followConnection();
  setInterval(() => void updates.checkAutomatically(), CHECK_EVERY_MS);
  startBackend();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

// An update that is ready replaces the app bundle as the app goes (macOS), so the next start is the new version.
app.on('will-quit', () => updates?.installOnQuit());

app.on('before-quit', () => {
  quitting = true;
  keepAwake.stop();
  post({ kind: 'shutdown' });
});
