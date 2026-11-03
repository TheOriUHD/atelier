import { describe, expect, it } from 'vitest';
import { buildDiagnostics, LOG_LINES, redactText, type DiagnosticsInput } from './diagnostics.ts';

const NOW = Date.UTC(2026, 10, 3, 9, 30, 0);
const PRIVATE = ['philippb', 'Philipps-MacBook-Pro', '/Users/philippb'];
const FOLDERS = ['/Users/philippb/Library/Application Support/Atelier'];

const base = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  now: NOW,
  appVersion: '0.3.1',
  packaged: true,
  channel: 'stable',
  platform: 'darwin',
  arch: 'arm64',
  mode: 'desktop-server',
  serverAddress: 'https://atelier.home.example.com:8443/path?x=1',
  serverVersion: '0.3.1',
  electron: '40.1.0',
  chrome: '144.0.7559.60',
  screen: { width: 1512, height: 982, ratio: 2 },
  theme: 'dark',
  features: { providers: 3, imageProviders: 1, connectors: 2, computerUse: false },
  providerTypes: ['ollama', 'anthropic', 'ollama'],
  imageProviderTypes: ['comfyui'],
  log: ['2026-11-03T09:00:00.000Z start 0.3.1 on darwin arm64'],
  lastError: null,
  privateStrings: PRIVATE,
  appFolders: FOLDERS,
  ...over,
});

/** Things that must never reach the clipboard, with the part of each that is the secret. */
const HOSTILE: [string, string][] = [
  ['Authorization: Bearer sk-ant-api03-AbCdEf0123456789xyz', 'AbCdEf0123456789'],
  ['request failed with key sk-proj-ABCDEFGHIJKLMNOP1234', 'ABCDEFGHIJKLMNOP1234'],
  ['apiKey="hunter2-hunter2" in settings', 'hunter2'],
  ['{"password":"correct horse battery staple","user":"x"}', 'correct horse'],
  ['token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'abcdefghijklmnopqrstuvwxyz'],
  ['GET https://api.example.com/v1/models?api_key=SECRETVALUE123&x=1 failed', 'SECRETVALUE123'],
  ['connect to https://alice:s3cr3tpw@nas.home.arpa:11434/v1 refused', 's3cr3tpw'],
  ['fetch http://192.168.1.50:11434/api/tags failed', '192.168.1.50'],
  ['connect ECONNREFUSED 10.0.0.7:7340', '10.0.0.7'],
  ['getaddrinfo ENOTFOUND my-nas', 'my-nas'],
  ['getaddrinfo ENOTFOUND atelier.family.example.org', 'family'],
  ['server at fd12:3456:789a::1 did not answer', 'fd12:3456'],
  ['server [2001:db8::5]:7340 did not answer', '2001:db8'],
  ['Write to /Users/philippb/Documents/Taxes 2025/return.pdf failed', 'Taxes'],
  ['open C:\\Users\\Philipp\\Desktop\\private notes\\a.txt failed', 'private notes'],
  ['at readFile (/Users/philippb/Developer/secret-client/src/x.ts:12:5)', 'secret-client'],
  ['EACCES: permission denied, open \'/home/bob/My Folder/clients.csv\'', 'clients'],
  ['file:///Users/philippb/Pictures/holiday.png not found', 'holiday'],
  ['mail sent to ada.lovelace@example.com', 'lovelace'],
  ['invite code ABCD-EFGH-JKMN-PQRS used', 'ABCD-EFGH'],
  ['secret id openai-prod-key used', 'openai-prod'],
  ['using ${secret:my-company-openai} for the call', 'my-company'],
  ['username=philippb logged in', 'philippb'],
  ['login: ada password: swordfish', 'swordfish'],
  ['host Philipps-MacBook-Pro refused', 'Philipps-MacBook'],
  ['cookie: atelier_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa'],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123 expired', 'eyJhbGci'],
  ['body: "Please summarise my confidential merger plans with Acme Corp and list every risk in detail now"', 'merger'],
  ['\u001b[31mBearer abcdefghijklmnop1234\u001b[0m', 'abcdefghijklmnop'],
];

describe('redactText', () => {
  it.each(HOSTILE)('hides the secret in %j', (line, secret) => {
    const out = redactText(line, { privateStrings: PRIVATE, appFolders: FOLDERS });
    expect(out).not.toContain(secret);
    expect(out).not.toMatch(/\p{Cc}/u);
  });

  it('hides the secret whatever surrounds it and however many times it repeats', () => {
    for (const [line, secret] of HOSTILE) {
      const wrapped = `2026-11-03T09:00:00.000Z [x] before ${line} middle ${line} after`;
      expect(redactText(wrapped, { privateStrings: PRIVATE, appFolders: FOLDERS })).not.toContain(secret);
    }
  });

  it('keeps what a developer needs: the message, the error code, the app code frames', () => {
    expect(redactText('2026-11-03T09:00:00.000Z start 0.3.1 on darwin arm64')).toBe('2026-11-03T09:00:00.000Z start 0.3.1 on darwin arm64');
    expect(redactText("TypeError: Cannot read properties of undefined (reading 'enabled')")).toBe("TypeError: Cannot read properties of undefined (reading 'enabled')");
    expect(redactText('page gone: crashed (11)')).toBe('page gone: crashed (11)');
    expect(redactText('at Session.fetch (/Applications/Atelier.app/Contents/Resources/app.asar/out/main.js:123:45)')).toBe('at Session.fetch (…/app.asar/out/main.js:123:45)');
    expect(redactText('at x (/Users/philippb/dev/app/node_modules/zod/lib/index.js:1:2)', { privateStrings: PRIVATE })).toBe('at x (…/node_modules/zod/lib/index.js:1:2)');
    expect(redactText('arr.at(0) and process.env and index.js and main.log and 3/4')).toBe('arr.at(0) and process.env and index.js and main.log and 3/4');
    expect(redactText('connect ECONNREFUSED 127.0.0.1:11434')).toBe('connect ECONNREFUSED 127.0.0.1:11434');
    expect(redactText('app://./index.html loaded; atelier-blob://abc ok')).toBe('app://./index.html loaded; atelier-blob://abc ok');
  });

  it('names the app’s own folders and nothing else on disk', () => {
    const out = redactText("open '/Users/philippb/Library/Application Support/Atelier/atelier.db' failed", { privateStrings: PRIVATE, appFolders: FOLDERS });
    expect(out).toBe("open '<app folder>/atelier.db' failed");
    const scratch = redactText('using /Users/philippb/Library/Application Support/Atelier/scratch-workspaces/u1/My Client Project', { privateStrings: PRIVATE, appFolders: FOLDERS });
    expect(scratch).toContain('<app folder>/scratch-workspaces');
    expect(scratch).not.toMatch(/Client|u1/);
  });

  it('shows a server only as a scheme and the word server', () => {
    expect(redactText('GET https://atelier.example.com:8443/api/health -> 502')).toBe('GET https://server -> 502');
    expect(redactText('wss://10.1.2.3/api/ws closed')).toBe('wss://server closed');
  });

  it('shortens long quoted text to its length', () => {
    const out = redactText(`provider said "${'word '.repeat(30)}"`);
    expect(out).toMatch(/^provider said "<\d+ characters omitted>"$/);
  });

  it('bounds a line', () => {
    expect(redactText('x '.repeat(1000)).length).toBeLessThanOrEqual(400);
  });
});

describe('buildDiagnostics', () => {
  it('reports version, system, mode, versions, screen, features and the provider types', () => {
    const text = buildDiagnostics(base());
    expect(text).toContain('App: Atelier 0.3.1 (installed build, stable channel)');
    expect(text).toContain('System: macOS arm64');
    expect(text).toContain('Mode: desktop app, connected to a server');
    expect(text).toContain('Server: https://server, version 0.3.1');
    expect(text).toContain('Electron 40.1.0, Chrome 144.0.7559.60');
    expect(text).toContain('Screen: 1512x982 at 2x, dark theme');
    expect(text).toContain('Providers: 3 (anthropic, ollama)');
    expect(text).toContain('Image providers: 1 (comfyui)');
    expect(text).toContain('Connectors: 2');
    expect(text).toContain('Computer use: off');
    expect(text).toContain('Main log (last 1 lines):');
    expect(text).toContain('2026-11-03T09:00:00.000Z start 0.3.1 on darwin arm64');
    expect(text).toContain('Last error: none');
    expect(text.startsWith('Atelier diagnostics\nCopied 2026-11-03T09:30:00Z.')).toBe(true);
  });

  it('never prints the server address, only its scheme', () => {
    const text = buildDiagnostics(base());
    expect(text).not.toMatch(/example|8443|home/);
    expect(buildDiagnostics(base({ serverAddress: 'not a url' }))).toContain('Server: server,');
  });

  it('leaves the server and versions out on this computer, and says a browser has no log', () => {
    const local = buildDiagnostics(base({ mode: 'desktop-local' }));
    expect(local).not.toContain('Server:');
    const web = buildDiagnostics(base({ mode: 'web', electron: null, chrome: null, browser: 'Chrome 144', log: null, packaged: null, features: { providers: 0, imageProviders: 0, connectors: 0, computerUse: null } }));
    expect(web).toContain('Mode: web browser');
    expect(web).toContain('Browser: Chrome 144');
    expect(web).toContain('a browser keeps none');
    expect(web).toContain('Computer use: not available here');
    expect(web).toContain('App: Atelier 0.3.1\n');
  });

  it('keeps the last 100 log lines only', () => {
    const log = Array.from({ length: 250 }, (_, i) => `2026-11-03T09:00:00.000Z line ${i}`);
    const text = buildDiagnostics(base({ log }));
    expect(text).toContain(`last ${LOG_LINES} lines`);
    expect(text).toContain('line 249');
    expect(text).toContain('line 150');
    expect(text).not.toContain('line 149');
  });

  it('redacts the last error and every log line, however hostile', () => {
    const text = buildDiagnostics(base({ log: HOSTILE.map(([line]) => line), lastError: { message: HOSTILE.map(([l]) => l).join(' | '), at: NOW - 120_000 } }));
    for (const [, secret] of HOSTILE) expect(text, secret).not.toContain(secret);
    expect(text).toContain('Last error (2 min ago):');
  });

  it('refuses hostile values in the plain fields rather than printing them', () => {
    const text = buildDiagnostics(
      base({
        appVersion: '1.0 token=abcdef',
        platform: 'darwin; rm -rf /',
        arch: 'arm64\nsecret: x',
        serverVersion: 'https://evil.example/?k=1',
        electron: 'sk-ant-api03-ZZZZZZZZZZ',
        chrome: '1\n2',
        channel: 'password123',
        providerTypes: ['anthropic', 'https://my-llm.example.com', 'my private provider', 'sk-ant-xxxxxxxx'],
        imageProviderTypes: ['comfyui; DROP'],
        features: { providers: Number.NaN, imageProviders: -5, connectors: 1e12, computerUse: true },
        screen: { width: Number.POSITIVE_INFINITY, height: 5, ratio: Number.NaN },
      }),
    );
    for (const bad of ['abcdef', 'rm -rf', 'secret: x', 'evil', 'ZZZZ', 'password123', 'my-llm', 'private provider', 'xxxxxxxx', 'DROP']) expect(text, bad).not.toContain(bad);
    expect(text).toContain('Providers: 0 (anthropic)');
    expect(text).toContain('Image providers: 0\n');
    expect(text).toContain('Connectors: 9999');
    expect(text).toContain('Computer use: on');
  });

  it('never contains the computer’s own words, wherever they were in the input', () => {
    const text = buildDiagnostics(base({ log: ['hello philippb from Philipps-MacBook-Pro', 'PHILIPPB again'], lastError: { message: 'philippb broke it', at: NOW } }));
    expect(text.toLowerCase()).not.toContain('philippb');
    expect(text).not.toContain('MacBook');
  });

  it('is one plain text block with no control characters but newlines', () => {
    const text = buildDiagnostics(base({ log: ['a\u0000b\u001b[31mred\u001b[0m\rc'] }));
    expect(text.replace(/\n/g, '')).not.toMatch(/\p{Cc}/u);
  });
});
