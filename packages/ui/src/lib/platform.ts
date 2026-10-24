/**
 * Surface-specific plumbing: how the UI reaches the backend and how blobs are addressed.
 * Desktop talks over a MessagePort brokered by the preload; web uses a reconnecting WebSocket.
 */
import { APP, type RpcMessage, type Transport } from '@atelier/protocol';

export type MenuCommand = 'new-chat' | 'new-temporary-chat' | 'settings' | 'toggle-sidebar' | 'command-palette' | 'lock';

export interface ConnectionChoice {
  mode: 'local' | 'server';
  /** Base URL of the Atelier server, for `server` mode. */
  serverUrl?: string;
}

/** Why the Atelier server can't be reached right now (the desktop relay's diagnosis). */
export interface ConnectionProblem {
  code: string;
  message: string;
  /** macOS's Local Network switch for this app would fix it; `openNetworkSettings` opens it. */
  localNetwork?: boolean;
}

/** An Atelier server that answered on the local network (apps/desktop/src/discovery.ts). */
export interface FoundServer {
  url: string;
  host: string;
  version: string | null;
  name: string | null;
}

export type UpdateChannel = 'stable' | 'beta';

/** The desktop app's update status (apps/desktop/src/updater.ts). */
export interface UpdateStatus {
  version: string;
  channel: UpdateChannel;
  /** Whether the app looks for updates by itself; off, only "Check now" does. */
  automatic: boolean;
  state:
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available'; version: string; manual?: boolean }
    /** `version`: the one being downloaded; older apps don't send it. */
    | { kind: 'downloading'; percent: number; version?: string }
    | { kind: 'downloaded'; version: string }
    | { kind: 'saved'; version: string }
    | { kind: 'error'; message: string }
    | { kind: 'unsupported'; reason: string };
  /** When a check last found nothing newer. */
  checkedAt: number | null;
}

interface DesktopBridge {
  platform: string;
  connect(): void;
  /**
   * How this app reaches a backend (ARCHITECTURE §21): its built-in one ("Run on this computer") or an
   * Atelier server. `mode` is null until the first-run choice. `set` saves the choice and reloads; a server address
   * without a scheme is tried over https://, then http://.
   */
  connection: {
    get(): Promise<{ mode: 'local' | 'server' | null; serverUrl: string | null }>;
    set(choice: ConnectionChoice): Promise<void>;
    /** Server mode: what is wrong with the way to the server right now, null while it works (or hasn't failed twice yet). */
    problem(): Promise<ConnectionProblem | null>;
    onProblem(handler: (problem: ConnectionProblem | null) => void): () => void;
    /** macOS: opens System Settings › Privacy & Security › Local Network. */
    openNetworkSettings(): Promise<void>;
    /** Back to the first-run choice; the built-in backend's data stays. Absent in desktop shells older than the UI bundle. */
    reset?(): Promise<void>;
  };
  /** Atelier servers on the local network, each reported as it answers; resolves with all of them within about 3 s. */
  discovery?: { scan(onFound: (server: FoundServer) => void): Promise<FoundServer[]> };
  /** The sign-in token for the current connection, kept in the OS keychain by the main process. */
  session: {
    /** `remembered` is false when this computer has no secure storage to keep it in: signed in for this run only. */
    save(token: string): Promise<{ remembered: boolean } | undefined>;
    clear(): Promise<void>;
  };
  /**
   * A forgotten screen lock PIN ("Run on this computer"): macOS's Touch ID removes the lock. `canUseSystem` is false
   * elsewhere, where the lock file in the data folder is deleted instead.
   */
  lock: {
    canUseSystem(): Promise<boolean>;
    removeWithSystem(): Promise<'removed' | 'cancelled' | 'unavailable'>;
  };
  /** This machine, registered as a device of the signed-in user (`devices.register`). */
  device: { id: string; name: string; platform: string };
  /**
   * The computer's clock ("h12" 2:25 PM, "h23" 14:25), which the app's language doesn't tell: null when the desktop
   * couldn't read it, absent in desktop shells older than the UI bundle.
   */
  hourCycle?: 'h12' | 'h23' | null;
  /**
   * Native folder picker. Resolves to the folder's git top level (or the folder), not yet trusted; null when
   * cancelled. `trust` records it as trusted on this machine (after the person agreed), ready for `workspaces.addLocal`.
   */
  folders: { pick(): Promise<string | null>; trust(path: string): Promise<string> };
  /** Shows a file in Finder / Explorer; false unless it lies in a folder trusted on this machine. */
  files: {
    reveal(path: string): Promise<boolean>;
    /** Opens a trusted folder in Cursor or VS Code; false when it isn't trusted or the editor didn't start. */
    openIn(editor: 'cursor' | 'vscode', path: string): Promise<boolean>;
    saveBlob(sha256: string, name: string): Promise<boolean>;
    /** A native picker starting in ~/.ssh, for an SSH key; the path chosen (with ~ for the home folder), null when cancelled. */
    pickKey(): Promise<string | null>;
  };
  /**
   * Updates from the Atelier server this app is signed in to (none in "Run on this computer" mode). `download`
   * is macOS's: it saves the new disk image to Downloads. `install` restarts into a downloaded update on
   * Windows and Linux.
   */
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<void>;
    setChannel(channel: UpdateChannel): Promise<void>;
    setAutomatic(automatic: boolean): Promise<void>;
    download(): Promise<void>;
    install(): Promise<void>;
    onStatus(handler: (status: UpdateStatus) => void): () => void;
  };
  /** Settings › System: launch at login (answers what the system says after a change) and this computer's data folder. */
  system: {
    get(): Promise<{ openAtLogin: boolean; dataFolder: string }>;
    setOpenAtLogin(open: boolean): Promise<boolean>;
    showDataFolder(): Promise<void>;
  };
  /**
   * Keeps the computer from sleeping while any of these sessions runs ("Keep computer awake" in a Code session's More
   * menu); an empty list lets it sleep again.
   */
  keepAwake: { set(sessionIds: string[]): void };
  /** The Code Browser pane's pages (`<webview>`s the main process hardens; apps/desktop/src/browser.ts). */
  browser: {
    /** A page asked for a new window; the pane showing it opens `url` as a tab. */
    onOpen(handler: (event: { webContentsId: number; url: string }) => void): () => void;
    /** A page started a download, which was refused. */
    onDownloadBlocked(handler: (event: { webContentsId: number; filename: string }) => void): () => void;
    /** A page's icon as a data URL, fetched in the pane's own session; null if it isn't a small image. */
    favicon(url: string): Promise<string | null>;
    /**
     * The origin a workspace's files are served under to the pane in this window (`atelier-files://<grant>/`). Absent
     * in desktop shells older than the UI bundle.
     */
    serve?(workspaceId: string): Promise<string>;
    /** Who reads those files when a page asks: base64 bytes, or null when the file can't be read. */
    setFileReader?(reader: (request: { workspaceId: string; path: string }) => Promise<string | null>): void;
  };
  /** Brings this window to the front (after a notification was clicked). */
  focusWindow(): void;
  /** Another window of the app on a route ("#/code/<id>"). */
  openWindow(hash: string): Promise<boolean>;
  onMenu(handler: (command: MenuCommand) => void): () => void;
  setTheme(theme: 'light' | 'dark'): void;
  openExternal(url: string): void;
}

declare global {
  interface Window {
    atelierDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.atelierDesktop : undefined;
export const surface: 'desktop' | 'web' = desktop ? 'desktop' : 'web';
export const os: string = desktop?.platform ?? (navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Win') ? 'win32' : 'linux');
export const isMac = os === 'darwin';

export function blobUrl(sha256: string): string {
  return surface === 'desktop' ? `${APP.scheme}-blob://${sha256}` : new URL(`api/blobs/${sha256}`, document.baseURI).toString();
}

/** Saves a stored file under `name`: a Save dialog on the desktop, a download in the browser. */
export async function saveBlob(sha256: string, name: string): Promise<void> {
  if (desktop) {
    await desktop.files.saveBlob(sha256, name);
    return;
  }
  const link = document.createElement('a');
  link.href = blobUrl(sha256);
  link.download = name;
  link.click();
}

/** The sandboxed artifact page. Packaged desktop builds serve it from its own scheme; dev and web use a sibling path. */
export function artifactRuntimeUrl(): string {
  return location.protocol === 'app:'
    ? `${APP.scheme}-artifact://ui/artifact-runtime/index.html`
    : new URL('artifact-runtime/index.html', document.baseURI).toString();
}

export interface ReconnectingTransport extends Transport {
  /** Fires after the connection is re-established (not on the first connect). */
  onReconnect(handler: () => void): () => void;
  onStatus(handler: (connected: boolean) => void): () => void;
}

function hub() {
  const messageHandlers = new Set<(m: RpcMessage) => void>();
  const closeHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();
  const statusHandlers = new Set<(c: boolean) => void>();
  const add = <T>(set: Set<T>, h: T) => (set.add(h), () => void set.delete(h));
  return {
    messageHandlers,
    closeHandlers,
    reconnectHandlers,
    statusHandlers,
    api: {
      onMessage: (h: (m: RpcMessage) => void) => add(messageHandlers, h),
      onClose: (h: () => void) => add(closeHandlers, h),
      onReconnect: (h: () => void) => add(reconnectHandlers, h),
      onStatus: (h: (c: boolean) => void) => add(statusHandlers, h),
    },
  };
}

/** Exported for tests. */
export function desktopTransport(bridge: Pick<DesktopBridge, 'connect'>): ReconnectingTransport {
  const h = hub();
  let port: MessagePort | null = null;
  const queue: RpcMessage[] = [];
  let connectedOnce = false;
  let attempt = 0;
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || (event.data as { type?: string } | null)?.type !== 'atelier:backend-port' || !event.ports[0]) return;
    const current = (port = event.ports[0]);
    current.onmessage = (e: MessageEvent<RpcMessage>) => {
      // A port counts as healthy once the backend answers on it; until then each retry waits longer.
      attempt = 0;
      h.messageHandlers.forEach((fn) => fn(e.data));
    };
    // The backend process restarted, or in server mode the relay's socket dropped: ask for a new port.
    current.addEventListener('close', () => {
      if (port !== current) return;
      port = null;
      h.closeHandlers.forEach((fn) => fn());
      h.statusHandlers.forEach((fn) => fn(false));
      setTimeout(() => bridge.connect(), Math.min(10_000, 250 * 2 ** attempt++));
    });
    for (const m of queue.splice(0)) current.postMessage(m);
    h.statusHandlers.forEach((fn) => fn(true));
    if (connectedOnce) h.reconnectHandlers.forEach((fn) => fn());
    connectedOnce = true;
  });
  bridge.connect();
  return {
    send: (m) => (port ? port.postMessage(m) : queue.push(m)),
    ...h.api,
  };
}

function webSocketTransport(): ReconnectingTransport {
  const h = hub();
  const url = new URL('api/ws', document.baseURI);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | null = null;
  let open = false;
  let connectedOnce = false;
  let attempt = 0;
  const queue: string[] = [];

  const connect = () => {
    socket = new WebSocket(url);
    socket.onopen = () => {
      open = true;
      attempt = 0;
      for (const m of queue.splice(0)) socket!.send(m);
      h.statusHandlers.forEach((fn) => fn(true));
      if (connectedOnce) h.reconnectHandlers.forEach((fn) => fn());
      connectedOnce = true;
    };
    socket.onmessage = (e: MessageEvent<string>) => {
      try {
        const m = JSON.parse(e.data) as RpcMessage;
        h.messageHandlers.forEach((fn) => fn(m));
      } catch {
        // Ignore malformed frames.
      }
    };
    socket.onclose = () => {
      if (open) h.closeHandlers.forEach((fn) => fn());
      open = false;
      h.statusHandlers.forEach((fn) => fn(false));
      setTimeout(connect, Math.min(10_000, 250 * 2 ** attempt++));
    };
  };
  connect();
  return {
    send: (m) => {
      const text = JSON.stringify(m);
      if (open && socket) socket.send(text);
      else queue.push(text);
    },
    ...h.api,
  };
}

let transport: ReconnectingTransport | null = null;
export function getTransport(): ReconnectingTransport {
  transport ??= desktop ? desktopTransport(desktop) : webSocketTransport();
  return transport;
}

export function openExternal(url: string): void {
  if (desktop) desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
