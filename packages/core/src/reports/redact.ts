/**
 * What an issue report may say about settings, preferences and chats (ARCHITECTURE §26). Diagnostics are attached by
 * default, so they must be safe without the person reading them: secrets, headers, addresses, paths and free text are
 * left out of settings and preferences. A chat is attached only when the person picks it, so its text stays, but
 * credentials and the words that name this computer and its account are taken out of it all the same.
 *
 * Errs towards hiding: a value that is hidden but could have been shown costs a developer a question; a token that is
 * shown costs a person their account.
 */
import { isIP } from 'node:net';

/** Words that name this computer or person (home folder, account name, computer name): hidden wherever they appear. */
export interface PrivateWords {
  home?: string;
  words?: readonly string[];
}

const SECRET_NAMES = new Set(['key', 'auth', 'token', 'secret', 'password', 'passwd', 'pwd', 'cookie', 'bearer', 'signature', 'credential', 'credentials', 'passphrase']);
const SECRET_ENDINGS = ['apikey', 'api_key', 'api-key', 'accesskey', 'access_key', 'privatekey', 'private_key', 'secretkey', 'secret_key', 'token', 'secret', 'password', 'passwd', 'passphrase', 'authorization', 'credential', 'credentials', 'cookie', 'sessionid', 'session_id', 'webhookurl', 'webhook_url'];
/** A field that holds a credential: `apiKey`, `authToken`, `clientSecret`, `password` (not `maxTokens`). */
const isSecretKey = (key: string): boolean => {
  const k = key.toLowerCase();
  return SECRET_NAMES.has(k) || SECRET_ENDINGS.some((e) => k.endsWith(e));
};

/** Credentials wherever they sit in a text: keys, tokens, passwords in addresses, private keys. */
export function scrubSecrets(input: string, words: PrivateWords = {}): string {
  let text = input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<private key>')
    .replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@"'<>:]{0,256}:[^\s/@"'<>]{0,256}@/gi, '$1<credentials>@')
    .replace(/\$\{secret:[^}]*\}/gi, '<secret ref>')
    .replace(/\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}/g, '<token>')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza|ya29\.|hf_|gsk_|xai-|r8_|fal_|nvapi-)[A-Za-z0-9_.-]{8,}/g, '<token>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <token>')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/g, 'Basic <token>')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, '<token>')
    .replace(/([?&;](?:[\w-]{0,40}(?:key|token|secret|password|passwd|pwd|auth|sig|signature|session)[\w-]{0,40})=)[^\s&;"'<>]+/gi, '$1<token>')
    // `API_KEY=…`, `"password": "…"`, `token: …` (as in .env files, JSON and YAML), but not `token: 12` counts.
    .replace(
      /((?:^|[\s,{(["'])(?:[\w.-]{0,40}(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|cookie|authorization|private[_-]?key|client[_-]?secret|access[_-]?key)[\w.-]{0,40})["']?\s{0,8}[:=]\s{0,8})(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([^\s,;}&"'\n]{6,}))/gim,
      (_m, lead: string, a?: string, b?: string, c?: string) => {
        const value = a ?? b ?? c ?? '';
        if (/^\d+$/.test(value) || /^<[^>]+>$/.test(value) || /^\$\{[A-Z0-9_]+\}$/.test(value)) return _m;
        return `${lead}${a !== undefined ? '"<redacted>"' : b !== undefined ? "'<redacted>'" : '<redacted>'}`;
      },
    );
  if (words.home && words.home.length > 2) text = text.split(words.home).join('~');
  for (const word of [...(words.words ?? [])].filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi'), '<private>');
  }
  return text;
}

// ------------------------------------------------------------------ addresses

/** Hosts of public AI services: named as they are, since which one a person uses is the point of the report. */
const PUBLIC_HOSTS = [
  'openai.com',
  'anthropic.com',
  'mistral.ai',
  'openrouter.ai',
  'groq.com',
  'googleapis.com',
  'deepseek.com',
  'x.ai',
  'together.xyz',
  'together.ai',
  'fireworks.ai',
  'perplexity.ai',
  'cerebras.ai',
  'githubcopilot.com',
  'github.com',
  'chatgpt.com',
  'replicate.com',
  'fal.run',
  'fal.ai',
  'stability.ai',
  'elevenlabs.io',
  'bfl.ai',
  'ideogram.ai',
  'nvidia.com',
  'cohere.com',
  'cohere.ai',
  'novita.ai',
  'hyperbolic.xyz',
  'deepinfra.com',
  'ollama.com',
  'huggingface.co',
  'azure.com',
  'amazonaws.com',
  'z.ai',
  'moonshot.ai',
  'minimax.io',
  'atelierhq.dev',
];

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^169\.254\./];

/**
 * Where an address points, without naming a private one: `localhost:11434`, `api.openai.com`, `private network`,
 * `other host`. A known public AI service is named; anything else is only described.
 */
export function hostLabel(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'invalid address';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port ? `:${url.port}` : '';
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127\./.test(host) || host.endsWith('.localhost')) return `localhost${port}`;
  if (host === 'host.docker.internal') return `host.docker.internal${port}`;
  if (isIP(host)) {
    if (isIP(host) === 4 && PRIVATE_V4.some((r) => r.test(host))) return 'private network';
    if (isIP(host) === 6 && /^(?:f[cd]|fe[89ab])/i.test(host)) return 'private network';
    return 'other host';
  }
  if (!host.includes('.') || /\.(local|lan|home|internal|home\.arpa|ts\.net|corp|intranet)$/.test(host)) return 'private network';
  return PUBLIC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? host : 'other host';
}

// ------------------------------------------------------------------ settings and preferences

const URLISH = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const PATHISH = /^(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/;
const MAX_DEPTH = 12;
const MAX_ITEMS = 100;

/** Settings fields that are someone's own words: only their length is told. */
const FREE_TEXT = new Set(['organizationInstructions', 'crisisResources', 'instructions', 'atelierMd', 'description', 'systemPrompt', 'prompt', 'callMe', 'about']);
/** Fields whose keys are worth seeing but whose values never are. */
const VALUES_HIDDEN = new Set(['headers', 'env', 'environment', 'variables']);
/** Fields left out of the person's preferences: who they are and what they told Atelier about themselves. */
const PERSONAL_PREFS = new Set(['callMe', 'personalization', 'git', 'ssh', 'avatar', 'name', 'email']);

function redactString(key: string, value: string, words: PrivateWords): string {
  if (isSecretKey(key)) return /^\$\{secret:/i.test(value) ? '<secret ref>' : /^\$\{[A-Z0-9_]+\}$/.test(value) ? '<env ref>' : value ? '<redacted>' : '';
  if (FREE_TEXT.has(key)) return value ? `<${value.length} characters>` : '';
  if (/^[\w.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)) return '<email>';
  if (URLISH.test(value)) {
    try {
      return `${new URL(value).protocol}//${hostLabel(value)}`;
    } catch {
      return '<address>';
    }
  }
  if (PATHISH.test(value)) return '<path>';
  if (value.length > 120 || value.split(/\s+/).length > 12) return `<${value.length} characters>`;
  return scrubSecrets(value, words);
}

/** A copy of settings (or preferences) that is safe to send: see the comment at the top. */
export function redactValue(value: unknown, words: PrivateWords = {}, key = '', depth = 0): unknown {
  if (depth > MAX_DEPTH) return '<too deep>';
  if (typeof value === 'string') return redactString(key, value, words);
  // Numbers and switches are never secrets (`maxTokens: 4096`).
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redactValue(v, words, key, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `<${value.length - MAX_ITEMS} more>`] : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS * 2)) {
      if (VALUES_HIDDEN.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = Object.fromEntries(Object.keys(v as object).slice(0, MAX_ITEMS).map((name) => [scrubSecrets(name, words), '<redacted>']));
      } else if (k === 'command' || k === 'commands') {
        // Hook and connector commands: the program's name tells enough; its arguments may carry anything.
        out[k] = typeof v === 'string' ? commandName(v) : Array.isArray(v) ? v.slice(0, MAX_ITEMS).map((c) => (typeof c === 'string' ? commandName(c) : redactValue(c, words, k, depth + 1))) : redactValue(v, words, k, depth + 1);
      } else if (k === 'args' && Array.isArray(v)) {
        out[k] = redactArgs(v.slice(0, MAX_ITEMS), words);
      } else {
        out[scrubSecrets(k, words)] = redactValue(v, words, k, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/** A command's arguments: a flag's name stays, the value after a flag that names a credential doesn't. */
function redactArgs(args: unknown[], words: PrivateWords): unknown[] {
  let hideNext = false;
  return args.map((a) => {
    if (typeof a !== 'string') return a;
    const hide = hideNext;
    hideNext = /^--?[\w-]*(?:key|token|secret|passw|auth|credential|cookie)[\w-]*$/i.test(a);
    if (hide) return '<redacted>';
    const flag = /^(--?[\w-]+)=(.*)$/.exec(a);
    if (flag) return /(?:key|token|secret|passw|auth|credential|cookie)/i.test(flag[1]!) ? `${flag[1]}=<redacted>` : `${flag[1]}=${redactString('', flag[2]!, words)}`;
    if (PATHISH.test(a)) return '<path>';
    if (URLISH.test(a)) return redactString('', a, words);
    return a.length > 60 || /(?=.*\d)(?=.*[A-Za-z])^[A-Za-z0-9_-]{24,}$/.test(a) ? '<redacted>' : scrubSecrets(a, words);
  });
}

function commandName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? '';
  const rest = command.trim().length - first.length;
  return `${/^[\w.+-]{1,60}$/.test(base) ? base : 'command'}${rest > 0 ? ` <${rest} characters of arguments>` : ''}`;
}

/** The person's preferences, without what says who they are. */
export function redactPrefs(prefs: unknown, words: PrivateWords = {}): unknown {
  if (!prefs || typeof prefs !== 'object') return undefined;
  const kept = Object.fromEntries(Object.entries(prefs as Record<string, unknown>).filter(([k]) => !PERSONAL_PREFS.has(k)));
  return redactValue(kept, words);
}
