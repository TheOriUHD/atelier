/**
 * What the activity log may keep of a value. The log is read by every admin and exported as a file, so the rule is
 * the opposite of a debug log: a value is stored only when it is small and plainly not a credential, and anything
 * else is recorded as "changed" without it. These helpers are the one place that decides; the rules table and the
 * log's writer both pass text through them.
 */

/** A path segment that names something secret or that tends to hold one (a header, a command's environment, an address with a token in it). */
const SECRET_SEGMENT = /key|token|secret|password|passwd|credential|auth|cookie|header|env|url|uri|dsn|webhook|bearer|salt|signature|command|args|cert|private/i;

/** Whether a settings path names something that may hold a secret. Numbers (array positions) are ignored. */
export function secretPath(path: readonly (string | number)[]): boolean {
  return path.some((s) => typeof s === 'string' && SECRET_SEGMENT.test(s));
}

/** Text that looks like a credential, wherever it sits: provider keys, bearer tokens, JWTs, long opaque strings. */
const SECRET_TEXT: readonly (readonly [RegExp, string])[] = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[hidden]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}/g, '[hidden]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [hidden]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, '[hidden]'],
  // Credentials inside an address: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[hidden]@'],
  // ?token=… and friends
  [/([?&;](?:[a-z_-]*(?:key|token|secret|password|auth|sig|signature)[a-z_-]*)=)[^\s&;]+/gi, '$1[hidden]'],
  // key = value / "key": "value"
  [/((?:api[_-]?key|token|secret|password|passwd|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[hidden]'],
  // A long run of base64-ish or hex characters is a token, a hash or a key more often than a word.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, '[hidden]'],
];

/** Replaces anything in `text` that looks like a credential with `[hidden]`. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_TEXT) out = out.replace(pattern, replacement);
  return out;
}

/** One line of plain text: no control characters, bounded. */
export function oneLine(text: string, max = 300): string {
  // \s covers the Unicode line separators too.
  const clean = text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * A value worth keeping beside a settings path: a boolean, a number, or a short single-line string with nothing
 * credential-like in it. Anything else (objects, long text, secrets) is not kept.
 */
export function smallValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (value.length > 60 || /[\n\r]/.test(value)) return undefined;
  if (scrubText(value) !== value) return undefined;
  // `${secret:id}` references and file paths are not values worth showing.
  if (/\$\{|^[/~]|^[A-Za-z]:\\/.test(value)) return undefined;
  return value;
}

/** An address reduced to scheme and host: no credentials, port, path or query. Null for text that isn't an address. */
export function hostOf(address: string): string | null {
  try {
    const url = new URL(address);
    return url.hostname || null;
  } catch {
    return null;
  }
}
