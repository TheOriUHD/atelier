/**
 * "Copy diagnostics": the plain text a tester pastes into a bug report instead of photographing a screen. Atelier
 * sends no crash reports or telemetry, so this is the other way round: nothing leaves until the person pastes it
 * themselves, and what they paste has been through `buildDiagnostics`, a pure function whose job is to leave things out.
 *
 * It never contains API keys or tokens, addresses (a server shows as `https://server`), file paths from anywhere but
 * the app's own folders, email addresses, usernames, secret ids, or prompts and message text. Everything free-form (the
 * log lines and the last error) goes through `redactText`, which errs towards hiding: a line that loses a word it could
 * have kept costs a developer a question; a line that keeps a token costs a person their account.
 */

import { ImageProviderType, ProviderType } from '@atelier/protocol';

export type DiagnosticsMode = 'desktop-local' | 'desktop-server' | 'web';

export interface DiagnosticsInput {
  now: number;
  appVersion: string;
  /** Desktop: whether this is an installed build (not a development run), and which update channel. */
  packaged?: boolean | null;
  channel?: string | null;
  platform: string;
  arch?: string | null;
  mode: DiagnosticsMode;
  /** The server's address in server mode; only its scheme is ever shown. */
  serverAddress?: string | null;
  serverVersion?: string | null;
  /** Desktop: the Electron and Chromium versions. Web: the browser's name and version. */
  electron?: string | null;
  chrome?: string | null;
  browser?: string | null;
  screen: { width: number; height: number; ratio: number };
  theme: 'light' | 'dark';
  features: { providers: number; imageProviders: number; connectors: number; computerUse: boolean | null };
  /** Provider types in use (`anthropic`, `ollama`): the closed set of types, never names or addresses. */
  providerTypes: readonly string[];
  imageProviderTypes: readonly string[];
  /** The last lines of the desktop's main log; null where there is none (a browser). */
  log: readonly string[] | null;
  lastError?: { message: string; at: number } | null;
  /** Words that identify this computer or person (home folder, account name, computer name): hidden wherever they appear. */
  privateStrings?: readonly string[];
  /** The app's own folders: the only places a path may be named, and then only as `<data folder>/…`. */
  appFolders?: readonly string[];
}

export const LOG_LINES = 100;
const LINE_MAX = 400;
const ERROR_MAX = 400;

// ------------------------------------------------------------------ redaction

/** File extensions that look like a top-level domain (`index.js`, `main.log`); never a host. */
const TLDS = new Set(
  'com net org io dev ai co me de uk eu us ca fr nl ch se no fi dk pl cz es it pt ru jp cn kr in br au nz local lan home internal intranet corp localdomain arpa xyz info biz cloud tech online site tv cc ts'.split(' '),
);

const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1?|localhost)$/i;

/** Hides every occurrence of `word` (whole words only, any case) in `text`. */
function hideWord(text: string, word: string, label: string): string {
  if (word.length < 3) return text;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi'), label);
}

/** `scheme://host/...` as `scheme://server`; the app's own schemes and loopback addresses stay. */
function hideUrl(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase() ?? '';
  if (scheme === 'app' || scheme.startsWith('atelier')) return url;
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@\s]*@)?(\[[^\]]*\]|[^/:?#\s]*)/i.exec(url)?.[1] ?? '';
  return LOOPBACK.test(host.replace(/^\[|\]$/g, '')) ? `${scheme}://${host}` : `${scheme}://server`;
}

/** The file and folder names of one path, reduced to what is safe to show. */
function hidePath(path: string): string {
  const tail = (marker: string) => {
    const at = path.lastIndexOf(marker);
    return at < 0 ? null : path.slice(at + 1);
  };
  const asar = tail('/app.asar/') ?? tail('\\app.asar\\');
  if (asar) return `…/${asar.replace(/^\/+/, '')}`;
  const modules = tail('/node_modules/');
  if (modules) return `…/${modules}`;
  return '<path>';
}

/**
 * Where a path ends. It runs to the first quote, bracket or line end; across spaces only while the name so far has no
 * file extension (so `My Documents/notes` is one path but `/tmp/a.txt is missing` stops after `a.txt`), and not past a
 * `:line:column` suffix.
 */
function pathEnd(text: string, start: number): number {
  let i = start;
  let lastSegmentStart = start;
  while (i < text.length) {
    const c = text[i]!;
    if (/["'`<>|)\]}\n\r\t]/.test(c)) break;
    if (c === ':' && /^:\d+(?::\d+)?(?![\w/])/.test(text.slice(i)) && i > start + 1) break;
    if (c === '/' || c === '\\') lastSegmentStart = i + 1;
    if (c === ' ') {
      const segment = text.slice(lastSegmentStart, i);
      const rest = text.slice(i + 1);
      // A file name with an extension ends the path; so does a space before something that isn't a name.
      if (/\.[A-Za-z0-9]{1,8}$/.test(segment) || segment === '' || /^(?:[-–([{]|at\s|in\s|is\s|was\s|not\s|and\s|from\s|to\s|for\s)/i.test(rest)) break;
    }
    i++;
  }
  // Sentence punctuation after the last name is not part of it.
  while (i > start && /[.,;!?]/.test(text[i - 1]!)) i--;
  return i;
}

const PATH_START = /(?<![\w.~>)\]}:/-])(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|~[\\/]|\/(?=[\w.~@$-]))/g;

function hidePaths(text: string): string {
  let out = '';
  let from = 0;
  PATH_START.lastIndex = 0;
  for (let m = PATH_START.exec(text); m; m = PATH_START.exec(text)) {
    if (m.index < from) continue;
    const end = pathEnd(text, m.index + m[0].length);
    // `a/b` inside a word-like token (a date, a fraction, "and/or") is not a path: a path starts with `/` and has a name.
    out += text.slice(from, m.index) + hidePath(text.slice(m.index, end));
    from = end;
    PATH_START.lastIndex = end;
  }
  return out + text.slice(from);
}

/** Hides what identifies a person, a computer or an account in free text, line by line. Exported for the tests. */
export function redactText(input: string, options: { privateStrings?: readonly string[]; appFolders?: readonly string[] } = {}): string {
  // Control characters and ANSI colour codes first: they hide words from the patterns below.
  // (\p{Cc} is every control character, the escape that starts a colour code among them.)
  let text = input.replace(/\p{Cc}\[[0-9;]*[A-Za-z]/gu, '').replace(/\p{Cc}+/gu, ' ');

  // The app's own folders are named, not hidden: `<app folder>/atelier.db`. One more name below them at most.
  for (const folder of [...(options.appFolders ?? [])].filter((f) => f.length > 3).sort((a, b) => b.length - a.length)) {
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\\/]/g, '[\\\\/]');
    const prefix = new RegExp(escaped, 'gi');
    let out = '';
    let from = 0;
    for (let m = prefix.exec(text); m; m = prefix.exec(text)) {
      if (m.index < from) continue;
      const after = m.index + m[0].length;
      const first = /^[\\/]+([\w.-]{1,40})(?![\w.-])/.exec(text.slice(after));
      // Whatever lies below the first name is the person's (a scratch folder is named for their project).
      const end = first ? pathEnd(text, after + first[0].length) : after;
      out += `${text.slice(from, m.index)}<app folder>${first ? `/${first[1]}${end > after + first[0].length ? '/…' : ''}` : ''}`;
      from = end;
      prefix.lastIndex = end;
    }
    text = out + text.slice(from);
  }

  // Credentials first, wherever they sit.
  text = text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']*@/gi, '$1')
    .replace(/\$\{secret:[^}]*\}/gi, '<secret id>')
    .replace(/\bsecrets?[:=/]\s*["']?[\w.-]+/gi, '<secret id>')
    .replace(/\bsecrets?\s+ids?\s+[\w.-]+/gi, 'secret <secret id>')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, '<token>')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza|ya29\.)[A-Za-z0-9_.-]{6,}/g, '<token>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer <token>')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic <token>')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){1,2}/g, '<token>')
    .replace(/([?&;#](?:[\w-]*(?:key|token|secret|password|passwd|pwd|auth|sig|signature|code|session)[\w-]*)=)[^\s&;"']*/gi, '$1<token>')
    .replace(/((?:["']?)(?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|cookie|credential|session[_-]?id|invite|setup[_-]?token)[\w-]*)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1<token>')
    .replace(/\b((?:user(?:name)?|login|account|owner|actor|by user|signed in as)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1<name>')
    .replace(/\b[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}\b/g, '<token>')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, '<token>');

  // Where on this computer: nothing but the app's own folders. Before this computer's own words, which sit in the paths.
  text = hidePaths(text.replace(/\bfile:\/\/\/?/gi, '/'));

  // Who and where: this computer's words, mail addresses, hosts, addresses.
  // Mail addresses before this computer's own words: the account name is often the start of one.
  text = text.replace(/[\w.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>');
  for (const word of [...(options.privateStrings ?? [])].sort((a, b) => b.length - a.length)) text = hideWord(text, word, '<private>');
  text = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi, hideUrl)
    .replace(/\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)(\s+)(?:\w+\s+)?([^\s:,'"()]+)/g, (_m, code: string, gap: string, host: string) => (LOOPBACK.test(host) ? _m : `${code}${gap}<host>`))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, (ip) => (LOOPBACK.test(ip.split(':')[0]!) ? ip : '<address>'))
    .replace(/(?<![\w:])\[?(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\]?(?::\d{1,5})?(?![\w:])/gi, (ip) => (/[a-f]|::/i.test(ip) && !LOOPBACK.test(ip.replace(/^\[|\](:\d+)?$/g, '')) ? '<address>' : ip))
    .replace(/(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?::\d{1,5})?(?![\w(.-])/gi, (host, tld: string) => (TLDS.has(tld.toLowerCase()) ? '<host>' : host));


  // Text people wrote or models answered with is not for a bug report: long quoted passages are replaced by their length.
  text = text.replace(/"([^"]{60,})"|'([^']{60,})'|`([^`]{60,})`/g, (_m, a?: string, b?: string, c?: string) => `"<${(a ?? b ?? c ?? '').length} characters omitted>"`);

  // So is a stretch of plain prose: an error that quotes what a person typed need not say it twice.
  text = text.replace(/(?:[A-Za-z][A-Za-z'’,.-]*\s+){13,}[A-Za-z][A-Za-z'’,.-]*/g, (run) => `<${run.trim().split(/\s+/).length} words omitted>`);

  text = text.replace(/\s+/g, ' ').trim();
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text;
}

// ------------------------------------------------------------------ the report

/** A word that is safe to print: letters, digits and a few separators, short. Anything else is "unknown". */
function plain(value: string | null | undefined, max = 40): string {
  return value && new RegExp(`^[A-Za-z0-9._+() -]{1,${max}}$`).test(value) && !/(?:key|token|secret|pass)/i.test(value) ? value : 'unknown';
}

/** A version number: digits and dots, maybe a suffix like `-beta.2`. Nothing else is printed as one. */
function version(value: string | null | undefined): string {
  return value && /^\d{1,4}(?:\.\d{1,6}){0,3}(?:[-+][A-Za-z0-9.]{1,16})?$/.test(value) ? value : 'unknown';
}

const count = (n: number) => (Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 9999) : 0);

/** Provider types are a closed set; a name that isn't one (a typo, an old version, something hostile) is not printed. */
const KNOWN_TYPES: ReadonlySet<string> = new Set<string>([...ProviderType.options, ...ImageProviderType.options]);

function typeNames(types: readonly string[]): string {
  const clean = [...new Set(types.filter((t) => KNOWN_TYPES.has(t)))].sort();
  return clean.length ? ` (${clean.join(', ')})` : '';
}

const MODE_TEXT: Record<DiagnosticsMode, string> = {
  'desktop-local': 'desktop app, running on this computer',
  'desktop-server': 'desktop app, connected to a server',
  web: 'web browser, connected to a server',
};

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function ago(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/** The text that goes on the clipboard. Pure: everything it reports is in `input`. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const redact = (s: string) => redactText(s, { ...(input.privateStrings ? { privateStrings: input.privateStrings } : {}), ...(input.appFolders ? { appFolders: input.appFolders } : {}) });
  const platform = plain(input.platform, 16);
  const lines: string[] = [
    'Atelier diagnostics',
    `Copied ${new Date(input.now).toISOString().replace(/\.\d+Z$/, 'Z')}. Atelier sent this nowhere; it is only on your clipboard. Read it before you share it.`,
    '',
    `App: Atelier ${version(input.appVersion)}${input.packaged === undefined || input.packaged === null ? '' : input.packaged ? ' (installed build' : ' (development build'}${input.packaged === undefined || input.packaged === null ? '' : input.channel ? `, ${plain(input.channel, 12)} channel)` : ')'}`,
    `System: ${PLATFORM_NAMES[platform] ?? platform}${input.arch ? ` ${plain(input.arch, 12)}` : ''}`,
    `Mode: ${MODE_TEXT[input.mode]}`,
  ];
  if (input.mode !== 'desktop-local') {
    const scheme = /^(https?):/i.exec(input.serverAddress ?? '')?.[1]?.toLowerCase();
    lines.push(`Server: ${scheme ? `${scheme}://server` : 'server'}${input.serverVersion ? `, version ${version(input.serverVersion)}` : ''}`);
  }
  if (input.electron || input.chrome) lines.push(`Electron ${version(input.electron)}, Chrome ${version(input.chrome)}`);
  else if (input.browser) lines.push(`Browser: ${plain(input.browser)}`);
  lines.push(`Screen: ${count(input.screen.width)}x${count(input.screen.height)} at ${Number.isFinite(input.screen.ratio) ? Math.min(Math.max(Math.round(input.screen.ratio * 100) / 100, 0), 16) : 1}x, ${input.theme === 'dark' ? 'dark' : 'light'} theme`);
  lines.push(
    `Providers: ${count(input.features.providers)}${typeNames(input.providerTypes)}`,
    `Image providers: ${count(input.features.imageProviders)}${typeNames(input.imageProviderTypes)}`,
    `Connectors: ${count(input.features.connectors)}`,
    `Computer use: ${input.features.computerUse === null ? 'not available here' : input.features.computerUse ? 'on' : 'off'}`,
  );

  lines.push('', input.lastError ? `Last error (${ago(input.lastError.at, input.now)}):` : 'Last error: none since this window opened');
  if (input.lastError) lines.push(`  ${redact(input.lastError.message).slice(0, ERROR_MAX) || '(empty)'}`);

  lines.push('');
  if (input.log === null) {
    lines.push('Log: a browser keeps none. For a server, the operator can run `docker compose logs atelier` and share the lines around the time it happened.');
  } else {
    const shown = input.log.slice(-LOG_LINES).map(redact).filter(Boolean);
    lines.push(shown.length ? `Main log (last ${shown.length} lines):` : 'Main log: empty', ...shown.map((l) => `  ${l}`));
  }
  return `${lines.join('\n')}\n`;
}
