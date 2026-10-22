/** Text and URL hygiene for search results: everything an engine sends is untrusted data. */

/** Control characters, zero-width marks and bidi overrides: none belong in a result. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROLS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');

/** One line of plain text: markup is gone (the parsers give textContent), controls and runs of space collapse. */
export function clean(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|igshid|yclid|_hsenc|_hsmi|ref_src|ocid)$/i;

/** The page an engine's redirect link leads to, or the link itself when it is direct. Null for anything but http(s). */
export function unwrapUrl(href: string | null | undefined, base?: string): string | null {
  if (!href) return null;
  let url = URL.parse(href, base ?? 'https://example.invalid/');
  if (!url) return null;
  // DuckDuckGo: //duckduckgo.com/l/?uddg=<encoded url>
  if (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.pathname === '/l/') {
    const target = url.searchParams.get('uddg');
    url = target ? URL.parse(target) : null;
  }
  // Bing News: https://www.bing.com/news/apiclick.aspx?…&url=<encoded url>
  else if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname.startsWith('/news/apiclick')) {
    const target = url.searchParams.get('url');
    url = target ? URL.parse(target) : null;
  }
  // Bing: https://www.bing.com/ck/a?…&u=a1<base64url of the url>
  else if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname.startsWith('/ck/')) {
    const u = url.searchParams.get('u');
    url = u?.startsWith('a1') ? URL.parse(Buffer.from(u.slice(2), 'base64url').toString('utf8')) : null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url.href;
}

/** The key two links to the same page share: no scheme, `www.`, fragment, trailing slash or tracking parameters. */
export function canonicalUrl(href: string): string {
  const url = URL.parse(href);
  if (!url) return href;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.hostname.replace(/^www\./, '')}${path}${url.search}`.toLowerCase();
}

export function hostOf(href: string): string {
  return (URL.parse(href)?.hostname ?? '').replace(/^www\./, '').toLowerCase();
}

/** Whether `href` is on one of `domains` (or a subdomain of it). */
export function onDomain(href: string, domains: readonly string[]): boolean {
  const host = hostOf(href);
  return domains.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./, '');
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/** `site:` operators for the domain filters, as every open-web engine reads them. */
export function operators(allowed: readonly string[], blocked: readonly string[]): string {
  const clean = (d: string) => d.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const yes = allowed.map(clean).filter(Boolean).slice(0, 4);
  const no = blocked.map(clean).filter(Boolean).slice(0, 5);
  const parts: string[] = [];
  if (yes.length === 1) parts.push(`site:${yes[0]}`);
  else if (yes.length > 1) parts.push(`(${yes.map((d) => `site:${d}`).join(' OR ')})`);
  for (const d of no) parts.push(`-site:${d}`);
  return parts.join(' ');
}

const STOP = new Set(
  'a an and are as at be but by can do does for from how i if in is it its me my of on or our so than that the their then there these they this to was we were what when where which who why will with you your about into over under'.split(' '),
);

/** The query's meaningful words: lowercase, without operators, stop words and repeats. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().replace(/\b(?:site|-site|intitle|inurl|filetype):\S+/g, ' ').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w)))];
}

const FILLER = new Set(['did', 'has', 'have', 'had', 'tell', 'please', 'give', 'show']);

/**
 * The query as keywords for engines that match every word (Bing News, GitHub): operators, question and filler words
 * are dropped and the rest keeps its spelling ("Next.js" stays one word). The query itself when nothing is left.
 */
export function keywords(query: string, max = 12): string[] {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/^["'([]+|["')\]?!,;:]+$/g, '').replace(/\.$/, ''))
    .filter((t) => t && !/^-?(?:site|intitle|inurl|filetype):/i.test(t) && !STOP.has(t.toLowerCase()) && !FILLER.has(t.toLowerCase()));
  return (tokens.length ? tokens : query.split(/\s+/).filter(Boolean)).slice(0, max);
}

/** Whether one result shares enough of the query's words (by default half of them, at least one) to be about it. */
export function aboutQuery(query: string, result: { title: string; url: string; snippet: string }, share = 0.5): boolean {
  const { words, found } = queryOverlap(query, [result]);
  return words.length === 0 || found >= Math.max(1, Math.ceil(words.length * share));
}

/** The query's meaningful words, and how many of them show up in the titles, snippets and links of the first results. */
export function queryOverlap(query: string, results: readonly { title: string; url: string; snippet: string }[]): { words: string[]; found: number; haystack: string } {
  const words = queryWords(query);
  const haystack = results
    .slice(0, 8)
    .map((r) => `${r.title} ${r.snippet} ${r.url}`)
    .join(' ')
    .toLowerCase();
  return { words, found: words.filter((w) => haystack.includes(w)).length, haystack };
}

/**
 * Whether a page of results answers the query at all. Some engines hand a request they distrust a page of results for
 * another query (a decoy), which looks exactly like a good one; at least half of the query's meaningful words must
 * show up in the titles, snippets and links of the first results. A query that names a company or a site ("Apple event
 * September 2026") is answered with that site's own pages, which carry only the name: the first result being on a
 * domain the query names counts too.
 */
export function answersQuery(query: string, results: readonly { title: string; url: string; snippet: string }[], strict = false): boolean {
  const { words, found } = queryOverlap(query, results);
  if (words.length === 0) return true;
  if (found < Math.max(1, Math.ceil(words.length * (strict ? 0.6 : 0.5)))) return !strict && namesFirstResult(words, results);
  // Strict (the encyclopedia floor, which has a result for almost anything): the first result must be about it by name.
  return !strict || (results[0] !== undefined && words.some((w) => results[0]!.title.toLowerCase().includes(w)));
}

/** The first result is on a domain a word of the query names (apple.com for "apple ..."). */
function namesFirstResult(words: readonly string[], results: readonly { url: string }[]): boolean {
  const first = results[0];
  if (!first) return false;
  try {
    const host = new URL(first.url).hostname.toLowerCase().replace(/^www\./, '');
    const name = host.split('.')[0] ?? '';
    return words.some((w) => w.length >= 4 && (name === w || name.startsWith(w) || w.startsWith(name)) && name.length >= 4);
  } catch {
    return false;
  }
}

/** A page with nothing in common with the query: the decoy kind of wrong, as opposed to a loose match. */
export function sharesNothing(query: string, results: readonly { title: string; url: string; snippet: string }[]): boolean {
  const { words, found } = queryOverlap(query, results);
  return words.length > 0 && found === 0;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', trade: '™', times: '×', laquo: '«', raquo: '»' };

/** Text with its HTML/XML entities decoded, in one pass (`&amp;lt;` is `&lt;`, not `<`). */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]{2,6}));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** How far back each freshness window reaches, in days. */
export const FRESHNESS_DAYS = { day: 1, week: 7, month: 31, year: 366 } as const;

/** A date as ISO text, or undefined when it isn't one (feeds send RFC 822, APIs send ISO or epoch seconds). */
export function isoDate(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** The headline without the publisher feeds append to it ("Apple event set - MacRumors"), so one story reads alike everywhere. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s[-–—|]\s[^-–—|]{2,40}$/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
