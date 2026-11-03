import { APP } from '@atelier/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserName, copyDiagnostics, gatherDiagnostics, writeClipboard } from './copy-diagnostics.ts';
import { clearLastError, recordError } from './last-error.ts';
import { queryClient } from './queries.ts';

const platform = vi.hoisted(() => ({ desktop: undefined as unknown, os: 'darwin' }));
vi.mock('./platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
  get os() {
    return platform.os;
  },
}));

const backend = vi.hoisted(() => ({ handlers: {} as Record<string, () => unknown> }));
vi.mock('./rpc.ts', () => ({
  rpc: () => ({
    call: async (method: string) => {
      const handler = backend.handlers[method];
      if (!handler) throw new Error(`no ${method}`);
      return handler();
    },
  }),
}));

const SECRET_LOG = [
  '2026-11-03T08:00:00.000Z start 0.3.1 on darwin arm64',
  '2026-11-03T08:00:01.000Z provider failed: https://alice:pw123456@llm.home.example.com/v1 Bearer sk-ant-api03-LEAKLEAKLEAK',
  '2026-11-03T08:00:02.000Z open /Users/ada/Documents/Clients/acme.docx failed for ada@acme.com',
];

const settings = {
  effective: {
    providers: [
      { id: 'a', type: 'anthropic', name: 'Secret Name', enabled: true },
      { id: 'b', type: 'ollama', name: 'Home', enabled: true },
      { id: 'c', type: 'openai', name: 'Off', enabled: false },
    ],
    imageProviders: [{ id: 'i', type: 'comfyui', name: 'Comfy', enabled: true }],
  },
};

function desktopBridge(over: Record<string, unknown> = {}) {
  return {
    connection: { get: async () => ({ mode: 'server', serverUrl: 'https://atelier.family.example.com:8443' }) },
    updates: { status: async () => ({ version: '0.3.1', channel: 'beta' }) },
    computer: { status: async () => ({ available: true, settings: { enabled: true } }) },
    diagnostics: {
      get: vi.fn(async () => ({ arch: 'arm64', electron: '40.1.0', chrome: '144.0.1', packaged: true, log: SECRET_LOG, privateStrings: ['/Users/ada', 'ada', 'Adas-Mac'], appFolders: ['/Users/ada/Library/Application Support/Atelier'] })),
    },
    ...over,
  };
}

let clipboard: string[];
beforeEach(() => {
  queryClient.clear();
  clearLastError();
  clipboard = [];
  backend.handlers = { 'app.info': () => ({ version: '0.3.1' }), 'settings.get': () => settings, 'mcp.status': () => [{}, {}, {}] };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void clipboard.push(t) } });
  platform.desktop = undefined;
  platform.os = 'darwin';
});
afterEach(() => vi.useRealTimers());

describe('gathering diagnostics', () => {
  it('in a browser: no log, the browser’s name, the server’s version and counts from what the person may see', async () => {
    const input = await gatherDiagnostics(1);
    expect(input).toMatchObject({
      mode: 'web',
      log: null,
      appVersion: APP.version,
      serverVersion: '0.3.1',
      features: { providers: 2, imageProviders: 1, connectors: 3, computerUse: null },
      providerTypes: ['anthropic', 'ollama'],
      imageProviderTypes: ['comfyui'],
    });
    expect(input.screen.width).toBe(window.innerWidth);
  });

  it('on the desktop connected to a server: the log, versions, channel and computer use', async () => {
    platform.desktop = desktopBridge();
    const input = await gatherDiagnostics(1);
    expect(input).toMatchObject({ mode: 'desktop-server', packaged: true, channel: 'beta', arch: 'arm64', electron: '40.1.0', chrome: '144.0.1', features: { computerUse: true }, log: SECRET_LOG });
    expect(input.serverAddress).toBe('https://atelier.family.example.com:8443');
  });

  it('on the desktop’s own backend: no server', async () => {
    platform.desktop = desktopBridge({ connection: { get: async () => ({ mode: 'local', serverUrl: null }) } });
    const input = await gatherDiagnostics(1);
    expect(input.mode).toBe('desktop-local');
    expect(input.serverVersion).toBeNull();
  });

  it('still answers when the backend is the thing that broke, within a few seconds', async () => {
    vi.useFakeTimers();
    backend.handlers = { 'app.info': () => new Promise(() => undefined), 'settings.get': () => { throw new Error('down'); }, 'mcp.status': () => new Promise(() => undefined) };
    platform.desktop = desktopBridge();
    const pending = gatherDiagnostics(1);
    await vi.advanceTimersByTimeAsync(2000);
    const input = await pending;
    expect(input).toMatchObject({ features: { providers: 0, connectors: 0 }, mode: 'desktop-server', log: SECRET_LOG });
  });

  it('carries the last error the window hit', async () => {
    recordError(new Error('Cannot read properties of undefined'), 7);
    expect((await gatherDiagnostics(10)).lastError).toEqual({ message: 'Error: Cannot read properties of undefined', at: 7 });
  });
});

describe('copying diagnostics', () => {
  it('puts redacted text on the clipboard and returns it', async () => {
    platform.desktop = desktopBridge();
    recordError(new Error('request to https://atelier.family.example.com:8443/api failed with token=abcdef123456'));
    const text = await copyDiagnostics();
    expect(clipboard).toEqual([text]);
    for (const leaked of ['LEAKLEAK', 'pw123456', 'llm.home', 'example.com', 'acme', 'Clients', 'ada@', '/Users/ada', 'abcdef123456', 'family', '8443']) expect(text, leaked).not.toContain(leaked);
    expect(text).toContain('Server: https://server');
    expect(text).toContain('Providers: 2 (anthropic, ollama)');
    expect(text).toContain('Computer use: on');
    expect(text).toContain('start 0.3.1 on darwin arm64');
  });

  it('says so in the text when there is no log to give', async () => {
    expect(await copyDiagnostics()).toContain('a browser keeps none');
  });

  it('returns null when the clipboard refuses and so does the fallback', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => Promise.reject(new Error('denied')) } });
    document.execCommand = () => false;
    expect(await copyDiagnostics()).toBeNull();
  });

  it('falls back to a selection copy where the clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    expect(await writeClipboard('hello')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe('naming the browser', () => {
  it('takes the product and the major version only', () => {
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Safari/537.36')).toBe('Chrome 144');
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.2 Safari/605.1.15')).toBe('Safari 18');
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Firefox 130');
    expect(browserName('Mozilla/5.0 Chrome/144.0 Safari/537.36 Edg/144.0.1')).toBe('Edge 144');
    expect(browserName('curl/8')).toBeNull();
  });
});
