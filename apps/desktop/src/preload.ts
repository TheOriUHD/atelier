/**
 * Preload: forwards the backend MessagePort to the page and exposes a minimal, typed desktop API.
 * The renderer never gets Node, ipcRenderer or Electron objects.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { MenuCommand } from './bridge.ts';
import type { UpdateStatus } from './updater.ts';

/** Ports this page asked for and hasn't received. One arriving unasked (a request from before a reload) is closed. */
let requested = 0;

ipcRenderer.on('backend-port', (event) => {
  if (requested === 0) return event.ports[0]?.close();
  requested--;
  // MessagePorts cannot cross contextBridge; hand them over via window.postMessage.
  window.postMessage({ type: 'atelier:backend-port' }, '*', event.ports);
});

/** Reads a workspace file for a page in the Browser pane; base64, or null when it can't be read. */
type PageReader = (request: { workspaceId: string; path: string }) => Promise<string | null>;
let fileReader: PageReader | null = null;

ipcRenderer.on('browser:read-file', (_e, request: { id: number; workspaceId: string; path: string }) => {
  const answer = (dataBase64: string | null) => ipcRenderer.send('browser:file', { id: request.id, dataBase64 });
  if (!fileReader) return answer(null);
  fileReader({ workspaceId: request.workspaceId, path: request.path }).then(answer, () => answer(null));
});

// Main passes this machine's device in argv, so the bridge can expose it synchronously.
const DEVICE_ARG = '--atelier-device=';
const device: unknown = JSON.parse(process.argv.find((arg) => arg.startsWith(DEVICE_ARG))!.slice(DEVICE_ARG.length));
// And this computer's clock, when main could tell it.
const CLOCK_ARG = '--atelier-clock=';
const hourCycle = process.argv.find((arg) => arg.startsWith(CLOCK_ARG))?.slice(CLOCK_ARG.length) ?? null;

contextBridge.exposeInMainWorld('atelierDesktop', {
  platform: process.platform,
  connect: () => {
    requested++;
    ipcRenderer.send('connect-backend');
  },
  connection: {
    get: () => ipcRenderer.invoke('connection:get'),
    problem: () => ipcRenderer.invoke('connection:problem'),
    onProblem: (handler: (problem: unknown) => void) => {
      const listener = (_e: unknown, problem: unknown) => handler(problem);
      ipcRenderer.on('connection:problem', listener);
      return () => ipcRenderer.off('connection:problem', listener);
    },
    openNetworkSettings: () => ipcRenderer.invoke('connection:openNetworkSettings'),
    set: async (choice: unknown) => {
      const error = (await ipcRenderer.invoke('connection:set', choice)) as string | null;
      if (error) throw new Error(error);
    },
    reset: () => ipcRenderer.invoke('connection:reset'),
  },
  discovery: {
    scan: async (onFound: (server: unknown) => void) => {
      const listener = (_e: unknown, server: unknown) => onFound(server);
      ipcRenderer.on('discovery:found', listener);
      try {
        return await ipcRenderer.invoke('discovery:scan');
      } finally {
        ipcRenderer.off('discovery:found', listener);
      }
    },
  },
  session: {
    save: (token: string) => ipcRenderer.invoke('session:save', token),
    relink: () => ipcRenderer.invoke('session:relink'),
    clear: () => ipcRenderer.invoke('session:clear'),
  },
  device,
  hourCycle,
  lock: {
    canUseSystem: () => ipcRenderer.invoke('lock:canUseSystem'),
    removeWithSystem: () => ipcRenderer.invoke('lock:removeWithSystem'),
  },
  folders: { pick: () => ipcRenderer.invoke('folders:pick'), trust: (path: string) => ipcRenderer.invoke('folders:trust', path) },
  files: {
    reveal: (path: string) => ipcRenderer.invoke('files:reveal', path),
    openIn: (editor: 'cursor' | 'vscode', path: string) => ipcRenderer.invoke('files:openIn', { editor, path }),
    pickKey: () => ipcRenderer.invoke('files:pickKey'),
    saveBlob: (sha256: string, name: string) => ipcRenderer.invoke('files:saveBlob', { sha256, name }),
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    setChannel: (channel: string) => ipcRenderer.invoke('updates:setChannel', channel),
    setAutomatic: (automatic: boolean) => ipcRenderer.invoke('updates:setAutomatic', automatic),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (handler: (status: UpdateStatus) => void) => {
      const listener = (_e: unknown, status: UpdateStatus) => handler(status);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.off('updates:status', listener);
    },
  },
  system: {
    get: () => ipcRenderer.invoke('system:get'),
    setOpenAtLogin: (open: boolean) => ipcRenderer.invoke('system:setOpenAtLogin', open),
    showDataFolder: () => ipcRenderer.invoke('system:showDataFolder'),
  },
  keepAwake: { set: (sessionIds: string[]) => ipcRenderer.send('keep-awake:set', sessionIds) },
  browser: {
    onOpen: (handler: (event: { webContentsId: number; url: string }) => void) => {
      const listener = (_e: unknown, event: { webContentsId: number; url: string }) => handler(event);
      ipcRenderer.on('browser:open', listener);
      return () => ipcRenderer.off('browser:open', listener);
    },
    onDownloadBlocked: (handler: (event: { webContentsId: number; filename: string }) => void) => {
      const listener = (_e: unknown, event: { webContentsId: number; filename: string }) => handler(event);
      ipcRenderer.on('browser:download-blocked', listener);
      return () => ipcRenderer.off('browser:download-blocked', listener);
    },
    favicon: (url: string) => ipcRenderer.invoke('browser:favicon', url),
    serve: (workspaceId: string) => ipcRenderer.invoke('browser:serve', workspaceId),
    setFileReader: (reader: PageReader) => void (fileReader = reader),
  },
  focusWindow: () => ipcRenderer.send('window:focus'),
  openWindow: (hash: string) => ipcRenderer.invoke('window:open', hash),
  onMenu: (handler: (command: MenuCommand) => void) => {
    const listener = (_e: unknown, command: MenuCommand) => handler(command);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.off('menu', listener);
  },
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.send('theme', theme),
  lending: {
    get: () => ipcRenderer.invoke('lending:get'),
    change: (change: unknown) => ipcRenderer.invoke('lending:change', change),
    allowImport: () => ipcRenderer.invoke('lending:allowImport'),
  },
  setShortcuts: (bindings: Record<string, string | null>) => ipcRenderer.send('menu:shortcuts', bindings),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
});
