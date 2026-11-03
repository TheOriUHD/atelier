/**
 * Gathers what "Copy diagnostics" reports and puts the text on the clipboard. Every source is best effort and bounded
 * in time: this runs from the error screen too, where the backend may be the very thing that broke.
 */
import { type DiagnosticsInput, type DiagnosticsMode, buildDiagnostics } from './diagnostics.ts';
import { lastError } from './last-error.ts';
import { desktop, os } from './platform.ts';
import { keys, queryClient } from './queries.ts';
import { rpc } from './rpc.ts';

const WAIT_MS = 1500;

/** The answer, or `fallback` when it fails or takes longer than the wait. */
async function soon<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), WAIT_MS)))]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** "Chrome 144" from a user agent: the product and its major version, nothing else of it. */
export function browserName(userAgent: string): string | null {
  // Edge and Opera say "Chrome" too, so the more specific name is looked for first.
  const match = /(Edg)\/(\d+)/.exec(userAgent) ?? /(Firefox|Chrome|Version)\/(\d+)/.exec(userAgent);
  if (!match) return null;
  const name = match[1] === 'Edg' ? 'Edge' : match[1] === 'Version' ? 'Safari' : match[1];
  return `${name} ${match[2]}`;
}

export async function gatherDiagnostics(now = Date.now()): Promise<DiagnosticsInput> {
  const connection = desktop ? await soon(() => desktop!.connection.get(), null) : null;
  const mode: DiagnosticsMode = !desktop ? 'web' : connection?.mode === 'server' ? 'desktop-server' : 'desktop-local';
  const [info, snapshot, connectors, computer, updates, native] = await Promise.all([
    soon(() => queryClient.fetchQuery({ queryKey: keys.appInfo, queryFn: () => rpc().call('app.info', {}) }), null),
    soon(() => queryClient.fetchQuery({ queryKey: keys.settings, queryFn: () => rpc().call('settings.get', {}) }), null),
    soon(() => queryClient.fetchQuery({ queryKey: keys.mcp, queryFn: () => rpc().call('mcp.status', {}), staleTime: 0 }), null),
    soon(async () => (desktop?.computer ? await desktop.computer.status() : null), null),
    soon(async () => (desktop ? await desktop.updates.status() : null), null),
    soon(async () => (desktop?.diagnostics ? await desktop.diagnostics.get(100) : null), null),
  ]);
  const settings = snapshot?.effective as { providers?: { type: string; enabled: boolean }[]; imageProviders?: { type: string; enabled: boolean }[] } | undefined;
  const providers = (settings?.providers ?? []).filter((p) => p.enabled);
  const imageProviders = (settings?.imageProviders ?? []).filter((p) => p.enabled);
  const error = lastError();
  return {
    now,
    appVersion: updates?.version ?? info?.version ?? '',
    packaged: native?.packaged ?? null,
    channel: updates?.channel ?? null,
    platform: os,
    arch: native?.arch ?? null,
    mode,
    serverAddress: connection?.serverUrl ?? null,
    serverVersion: mode === 'desktop-local' ? null : (info?.version ?? null),
    electron: native?.electron || null,
    chrome: native?.chrome || null,
    browser: desktop ? null : browserName(navigator.userAgent),
    screen: { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio || 1 },
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    features: {
      providers: providers.length,
      imageProviders: imageProviders.length,
      connectors: connectors?.length ?? 0,
      computerUse: computer?.available ? computer.settings.enabled : null,
    },
    providerTypes: providers.map((p) => p.type),
    imageProviderTypes: imageProviders.map((p) => p.type),
    // A browser has no main process, so no log; a desktop whose shell predates this has none to give either.
    log: desktop ? (native?.log ?? []) : null,
    lastError: error,
    privateStrings: native?.privateStrings ?? [],
    appFolders: native?.appFolders ?? [],
  };
}

/** Writes text to the clipboard; false when the browser or window refuses. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // An older webview or an insecure page: the selection-based way still works on a click.
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Builds the diagnostics and copies them. Resolves to the text on success, null when nothing could be copied. */
export async function copyDiagnostics(): Promise<string | null> {
  const text = buildDiagnostics(await gatherDiagnostics());
  return (await writeClipboard(text)) ? text : null;
}
