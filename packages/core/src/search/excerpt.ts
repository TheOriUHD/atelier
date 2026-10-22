/**
 * Reading the first results. A search result is a title and two lines; the answer is usually in the page. For the top
 * few results the service fetches the page (with WebFetch's own guard against private addresses), takes its main
 * content, and keeps the passages that say the most about the query, so a model that never calls WebFetch still gets
 * substance. Everything is bounded: a few pages, a few seconds, a few hundred characters each.
 */
import { assertPublicHost, type Lookup } from '../tools/address-guard.ts';
import { htmlToMarkdown, readCapped } from '../tools/web-fetch.ts';
import { BROWSER_UA } from './engines/common.ts';
import type { Fetcher } from './types.ts';
import { clean, queryWords } from './text.ts';

const PAGE_BYTES = 1_500_000;
const PAGE_MS = 4_500;
const MAX_HOPS = 3;

/** Sites that answer a script with a wall, a login or a consent page rather than the story. */
const UNREADABLE = /(?:^|\.)(?:reddit\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|youtu\.be|pinterest\.com|news\.google\.com)$/i;

export function worthReading(url: string): boolean {
  const parsed = URL.parse(url);
  return !!parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !UNREADABLE.test(parsed.hostname) && !/\.(?:pdf|zip|png|jpe?g|gif|webp|mp4|mp3)$/i.test(parsed.pathname);
}

/** The text of a page's main content, as Markdown, or null when it can't be had quickly and safely. */
export interface ExcerptDeps {
  fetch: Fetcher;
  allowPrivateNetworks(): boolean;
  lookup?: Lookup | undefined;
}

export type ExcerptReader = (url: string, query: string, signal: AbortSignal) => Promise<string | null>;

export function createExcerptReader(deps: ExcerptDeps): ExcerptReader {
  return async (href, query, outer) => {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(PAGE_MS)]);
    try {
      let url = URL.parse(href);
      if (!url || url.username || url.password || !worthReading(href)) return null;
      let res: Response | undefined;
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        await assertPublicHost(url.hostname, deps.allowPrivateNetworks(), deps.lookup);
        res = await deps.fetch(url.href, { redirect: 'manual', signal, headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) break;
        const next = new URL(location, url);
        // Another host is another permission decision (WebFetch asks for it); a quiet reader doesn't follow.
        if (next.host !== url.host) return null;
        url = next;
        res = undefined;
      }
      if (!res?.ok) return null;
      if (!/^(?:text\/html|application\/xhtml\+xml)/i.test(res.headers.get('content-type') ?? 'text/html')) return null;
      const bytes = await readCapped(res, PAGE_BYTES);
      if (!bytes) return null;
      return relevantExcerpt(htmlToMarkdown(new TextDecoder().decode(bytes), url.href), query);
    } catch {
      return null;
    }
  };
}

const BOILERPLATE = /\b(?:cookies?|subscribe|sign (?:in|up)|log ?in|newsletter|all rights reserved|privacy policy|terms of (?:use|service)|advertisement|skip to (?:main )?content|javascript is (?:disabled|required)|enable javascript|accept all)\b/i;

/** Plain text of one Markdown paragraph: links, images and emphasis reduced to their words. */
function plain(paragraph: string): string {
  return paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*\-+\s]+/, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The passages of a page that say the most about the query: whole sentences' worth of text from the paragraphs that
 * share the most of its words (the lede when none does), in page order, within `max` characters.
 */
export function relevantExcerpt(markdown: string, query: string, max = 700): string | null {
  const words = queryWords(query);
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((p, index) => ({ raw: p, text: plain(p), index }))
    .filter(({ raw, text }) => {
      if (text.length < 70) return false;
      // A paragraph that is mostly links is a menu or a list of related stories.
      const links = (raw.match(/\]\(/g) ?? []).length;
      if (links > 3 && links * 40 > text.length) return false;
      return !(text.length < 220 && BOILERPLATE.test(text));
    });
  if (paragraphs.length === 0) return null;
  const scored = paragraphs.map((p) => {
    const lower = p.text.toLowerCase();
    return { ...p, score: words.filter((w) => lower.includes(w)).length * 3 + (p.index < 6 ? 1 : 0) };
  });
  const best = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = (best[0]!.score > 1 ? best.filter((p) => p.score > 1) : scored).slice(0, 2).sort((a, b) => a.index - b.index);
  const text = picked.map((p) => clean(p.text, 420)).join(' … ');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
