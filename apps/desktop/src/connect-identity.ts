/**
 * Connecting an identity provider from the desktop app (ARCHITECTURE §21). A window with throwaway cookies, signed in
 * with this app's token, does what a browser does: the server starts and finishes the flow by the same rules, and it
 * comes back to this app's server address, so that address's redirect URI has to be listed at the provider.
 */
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import { APP, OIDC_PATH } from '@atelier/protocol';
import { windowIconOption } from './app-icon.ts';

/** How it went: `code` is the server's `?signIn=` code, `message` its words when the flow never started. */
export type ConnectOutcome = { status: 'connected' } | { status: 'cancelled' } | { status: 'failed'; code?: string; message?: string };

export interface ConnectOptions {
  serverUrl: string;
  token: string;
  provider: { id: string; name: string };
  parent?: BrowserWindow;
  /** Keeps the window from showing, for test runs. */
  hidden?: boolean;
}

/** The server ends a flow on its home page, with `?signIn=<code>` when it went wrong; anything else is on its way. */
export function connectOutcome(url: string, serverUrl: string): ConnectOutcome | null {
  if (!URL.canParse(url)) return null;
  const at = new URL(url);
  if (at.origin !== new URL(serverUrl).origin || at.pathname !== '/') return null;
  const code = at.searchParams.get('signIn');
  return code ? { status: 'failed', code } : { status: 'connected' };
}

let open: { win: BrowserWindow; done: Promise<ConnectOutcome> } | null = null;

/** Resolves when the window has closed, whoever closed it. One at a time: a second call brings the first back. */
export function connectIdentity(options: ConnectOptions): Promise<ConnectOutcome> {
  if (open && !open.win.isDestroyed()) {
    open.win.focus();
    return open.done;
  }
  return signIn(options);
}

async function signIn({ serverUrl, token, provider, parent, hidden }: ConnectOptions): Promise<ConnectOutcome> {
  const browserSession = session.fromPartition(`connect-identity-${randomUUID()}`);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await browserSession.cookies.set({ url: serverUrl, name: APP.cookie, value: token, path: '/', httpOnly: true, secure: serverUrl.startsWith('https:'), sameSite: 'lax' });
  const started = await browserSession.fetch(`${serverUrl}${OIDC_PATH}/${encodeURIComponent(provider.id)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ link: true }),
    credentials: 'include',
  });
  const answer = (await started.json().catch(() => ({}))) as { url?: string; code?: string; message?: string };
  if (!started.ok || !answer.url) {
    await browserSession.clearStorageData();
    return { status: 'failed', ...(answer.code ? { code: answer.code } : {}), ...(answer.message ? { message: answer.message } : {}) };
  }

  const win = new BrowserWindow({
    title: `Connect ${provider.name}`,
    width: 520,
    height: 720,
    show: false,
    ...windowIconOption(),
    ...(parent ? { parent } : {}),
    webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The window has no address bar, so its title says whose page this is.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.on('did-navigate', (_event, url) => {
    if (URL.canParse(url)) win.setTitle(`Connect ${provider.name} — ${new URL(url).host}`);
  });
  if (!hidden) win.once('ready-to-show', () => win.show());

  const done = new Promise<ConnectOutcome>((resolve) => {
    let outcome: ConnectOutcome = { status: 'cancelled' };
    win.webContents.on('will-redirect', (event) => {
      const ended = connectOutcome(event.url, serverUrl);
      if (!ended) return;
      event.preventDefault();
      outcome = ended;
      win.destroy();
    });
    win.once('closed', () => {
      open = null;
      void browserSession.clearStorageData();
      resolve(outcome);
    });
    win.loadURL(answer.url!).catch((error: unknown) => {
      if (win.isDestroyed()) return;
      outcome = { status: 'failed', message: `Couldn’t open ${provider.name}: ${error instanceof Error ? error.message : String(error)}` };
      win.destroy();
    });
  });
  open = { win, done };
  return done;
}
