/**
 * The app's half of a report (ARCHITECTURE §26): which app this is and its window, the computer it runs on (from the
 * desktop app, or what a browser tells), computer use, and the end of the desktop's main log. The backend adds its own
 * half (`reports.prepare`). Every source is bounded in time: a report is often sent because something is broken.
 */
import { APP, type ReportApp, type ReportDiagnostics, type ReportSystem } from '@atelier/protocol';
import { browserName } from '../../lib/copy-diagnostics.ts';
import { redactText } from '../../lib/diagnostics.ts';
import { lastError } from '../../lib/last-error.ts';
import { desktop, os } from '../../lib/platform.ts';
import { keys, queryClient } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';

const WAIT_MS = 4000;

async function soon<T>(work: () => Promise<T>, fallback: T, ms = WAIT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** The graphics card a browser draws with, as WebGL names it ("ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max…)"). */
function webglRenderer(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    return typeof name === 'string' && name ? name.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** What a browser says about its computer: little, and nothing that names it. */
function browserSystem(): ReportSystem {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const gpu = webglRenderer();
  const browser = browserName(navigator.userAgent);
  return {
    os: { platform: os, ...(navigator.language ? { locale: navigator.language.slice(0, 40) } : {}) },
    hardware: {
      ...(navigator.hardwareConcurrency ? { cpu: { model: 'unknown', cores: navigator.hardwareConcurrency } } : {}),
      // Browsers round this to a power of two and cap it at 8 GB.
      ...(nav.deviceMemory ? { memory: { totalBytes: nav.deviceMemory * 1e9 } } : {}),
      ...(gpu ? { gpus: [{ name: gpu, source: 'webgl' }] } : {}),
      displays: [{ width: screen.width, height: screen.height, scale: window.devicePixelRatio || 1 }],
    },
    runtime: browser ? { browser } : {},
  };
}

export interface ClientHalf {
  app: ReportApp;
  /** Added to the backend's diagnostics when they are attached. */
  diagnostics: Partial<ReportDiagnostics>;
}

export async function clientHalf(): Promise<ClientHalf> {
  const connection = desktop ? await soon(() => desktop!.connection.get(), null, 1500) : null;
  const mode: ReportApp['mode'] = !desktop ? 'web' : connection?.mode === 'server' ? 'desktop-server' : 'desktop-local';
  const [info, updates, native, system, computer] = await Promise.all([
    soon(() => queryClient.fetchQuery({ queryKey: keys.appInfo, queryFn: () => rpc().call('app.info', {}) }), null),
    soon(async () => (desktop ? await desktop.updates.status() : null), null),
    soon(async () => (desktop?.diagnostics ? await desktop.diagnostics.get(200) : null), null),
    soon(async () => (desktop?.reports ? await desktop.reports.system() : browserSystem()), browserSystem(), 10_000),
    soon(async () => (desktop?.computer ? await desktop.computer.status() : null), null),
  ]);
  const words = { privateStrings: native?.privateStrings ?? [], appFolders: native?.appFolders ?? [] };
  const error = lastError();
  const app: ReportApp = {
    version: APP.version,
    surface: desktop ? 'desktop' : 'web',
    mode,
    ...(updates?.channel ? { channel: updates.channel } : {}),
    ...(native ? { packaged: native.packaged } : {}),
    ...(mode !== 'desktop-local' && info?.version ? { serverVersion: info.version } : {}),
    window: { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio || 1 },
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    ...(navigator.language ? { language: navigator.language.slice(0, 40) } : {}),
  };
  const diagnostics: Partial<ReportDiagnostics> = {
    client: system,
    ...(computer ? { computerUse: { available: computer.available, ...(computer.available ? { enabled: computer.settings.enabled } : {}), ...(computer.unavailableReason ? { notes: { 'not available': computer.unavailableReason.slice(0, 200) } } : {}) } } : {}),
    ...(native?.log.length ? { log: native.log.slice(-200).map((l) => redactText(l, words)).filter(Boolean) } : {}),
    ...(error ? { lastError: { message: redactText(error.message, words).slice(0, 2000), at: error.at } } : {}),
  };
  return { app, diagnostics };
}
