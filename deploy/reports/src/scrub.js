/**
 * The collector's own secret scrubber: a second line behind the app's redaction (packages/core/src/reports/redact.ts),
 * run over every string of a report and its chat before anything is stored. The app should have taken everything out
 * already; whatever this still finds is replaced and counted (D1 `reports.scrubbed`), so a non-zero count points at a
 * hole in the app's redaction.
 *
 * It errs towards hiding, but not in plain prose: "the password: field is empty" keeps its words.
 */

export const REDACTED = '<redacted>';

/** A value the app (or this scrubber) already replaced: `<redacted>`, `<token>`, `<private key>`, `<secret ref>`. */
const isMarker = (s) => /^<[a-z][a-z ]{0,30}>$/i.test(s);

/** Names of fields and keys that hold a credential: `apiKey`, `authToken`, `client_secret`, `password` (not `maxTokens`). */
const SECRET_ENDINGS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'sessionid',
];
export const isSecretName = (name) => {
  const k = name.toLowerCase().replace(/[_.-]/g, '');
  return k === 'auth' || SECRET_ENDINGS.some((e) => k.endsWith(e));
};

/** Credentials by their shape, wherever they are. Each entry: [pattern, replacement]. */
const SHAPES = [
  // PEM private keys, with or without their end line (a log line may cut one off).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '<private key>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <token>'],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/g, 'Basic <token>'],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<token>'],
  // OpenAI, Anthropic and the many keys shaped like theirs (sk-…, sk-ant-…, sk-proj-…), Stripe's sk_live_…
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, '<token>'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '<token>'],
  // GitHub, GitLab, Slack, Hugging Face, Groq, Google, AWS access key ids.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{30,})/g,
    '<token>',
  ],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '<token>'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<token>'],
  // A password in an address: https://user:password@host/. The scheme's length is bounded: unbounded, every word of a
  // long dotted text would be read to its end again ("a.a.a.a…" takes minutes).
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@"'<>]{1,200}):[^\s@/"'<>]{1,200}@/gi, '$1:<redacted>@'],
];

/**
 * `password=hunter2`, `"api_key": "…"`, `token: abc123`, `--client-secret=…`, `?access_token=…`. The name may have a
 * short prefix (`config.password`, `OPENAI_API_KEY`); it must end at the separator, so `max_tokens: 4096` is left.
 */
const KEY_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]{0,40}?(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret[_-]?key|authorization|auth|credentials?|cookie|session[_-]?id))\1(\s*[=:]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"'&,;)}\]]+)`,
  'gi',
);

function keyValue(text, count) {
  return text.replace(KEY_VALUE, (match, quote, name, sep, value) => {
    const quoted = value.startsWith('"') || value.startsWith("'");
    const inner = quoted ? value.slice(1, -1) : value;
    if (!inner || isMarker(inner) || /^(?:true|false|null|undefined|none|bearer|basic)$/i.test(inner)) return match;
    // After a colon, a short lowercase word is prose or a setting's name ("password: field", "auth: none").
    if (!quoted && !sep.includes('=') && /^[a-z]{1,12}$/.test(inner)) return match;
    // Counts of tokens and the like: `token: 12`.
    if (/^\d{1,6}$/.test(inner)) return match;
    count.n++;
    return `${quote}${name}${quote}${sep}${quoted ? `${value[0]}${REDACTED}${value[0]}` : REDACTED}`;
  });
}

/** One string, with what was replaced added to `count.n`. */
export function scrubText(text, count = { n: 0 }) {
  if (typeof text !== 'string' || text.length < 8) return text;
  let out = text;
  for (const [pattern, replacement] of SHAPES) {
    out = out.replace(pattern, (...args) => {
      count.n++;
      return typeof replacement === 'string' ? replacement.replace('$1', args[1] ?? '') : replacement;
    });
  }
  return keyValue(out, count);
}

export class TooDeep extends Error {}

/**
 * A parsed JSON value with every string scrubbed, and a string under a secret-looking name (`"apiKey": "…"`) replaced
 * whatever it looks like. Returns `{ value, count }`; throws `TooDeep` for nesting past `maxDepth`.
 */
export function scrubJson(value, { maxDepth = 64 } = {}) {
  const count = { n: 0 };
  const walk = (v, depth, name) => {
    if (depth > maxDepth) throw new TooDeep('The report is nested too deeply.');
    if (typeof v === 'string') {
      if (name !== null && isSecretName(name) && v && !isMarker(v)) {
        count.n++;
        return REDACTED;
      }
      return scrubText(v, count);
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1, null));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, item] of Object.entries(v)) out[k] = walk(item, depth + 1, k);
      return out;
    }
    return v;
  };
  return { value: walk(value, 0, null), count: count.n };
}
