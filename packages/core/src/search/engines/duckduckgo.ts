/** DuckDuckGo's HTML and Lite pages: the same backend and the same rate limit, hence one family. */
import { parseHTML } from 'linkedom';
import type { Attempt, Engine, Parsed, SearchRequest, SearchResult } from '../types.ts';
import { clean, operators, unwrapUrl } from '../text.ts';
import { BROWSER_HEADERS, limited, page } from './common.ts';

const BLOCK = '.anomaly-modal__mask, #challenge-form, form[action*="anomaly"]';
const DF = { day: 'd', week: 'w', month: 'm', year: 'y' } as const;

export function parseDuckDuckGoHtml(html: string): Parsed {
  const { document } = parseHTML(html);
  if (document.querySelector(BLOCK)) return { results: [], blocked: 'DuckDuckGo asked for a challenge' };
  const results: SearchResult[] = [];
  for (const el of document.querySelectorAll('div.result')) {
    if (el.classList.contains('result--ad')) continue;
    const a = el.querySelector('a.result__a');
    const url = unwrapUrl(a?.getAttribute('href'), 'https://duckduckgo.com/');
    if (!a || !url || /(^|\.)duckduckgo\.com$/.test(new URL(url).hostname)) continue;
    results.push({ title: clean(a.textContent, 200), url, snippet: clean(el.querySelector('.result__snippet')?.textContent, 500) });
  }
  return { results };
}

export function parseDuckDuckGoLite(html: string): Parsed {
  const { document } = parseHTML(html);
  if (document.querySelector(BLOCK)) return { results: [], blocked: 'DuckDuckGo asked for a challenge' };
  const results: SearchResult[] = [];
  let current: SearchResult | null = null;
  for (const row of document.querySelectorAll('tr')) {
    const link = row.querySelector('a.result-link');
    if (link) {
      const url = unwrapUrl(link.getAttribute('href'), 'https://duckduckgo.com/');
      current = url && !/(^|\.)duckduckgo\.com$/.test(new URL(url).hostname) ? { title: clean(link.textContent, 200), url, snippet: '' } : null;
      if (current) results.push(current);
      continue;
    }
    const snippet = row.querySelector('td.result-snippet');
    if (snippet && current && !current.snippet) current.snippet = clean(snippet.textContent, 500);
  }
  return { results };
}

function engine(id: string, name: string, endpoint: string, parse: (html: string) => Parsed): Engine {
  return {
    id,
    name,
    family: 'duckduckgo',
    // Six requests in a minute from one address earn a challenge; one per four seconds does not.
    gapMs: 4_000,
    kind: 'web',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const q = [req.query, operators(req.allowed, req.blocked)].filter(Boolean).join(' ');
      const body = new URLSearchParams({ q, kl: 'wt-wt', ...(req.freshness ? { df: DF[req.freshness] } : {}) });
      const got = await page(fetch, endpoint, { method: 'POST', headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, signal);
      if ('failed' in got) return got.failed;
      if (limited(got.status)) return { outcome: 'blocked', reason: `DuckDuckGo answered HTTP ${got.status}` };
      if (got.status >= 400) return { outcome: 'error', reason: `DuckDuckGo answered HTTP ${got.status}` };
      const parsed = parse(got.body);
      if (parsed.blocked) return { outcome: 'blocked', reason: parsed.blocked };
      return parsed.results.length ? { outcome: 'ok', results: parsed.results } : { outcome: 'empty' };
    },
  };
}

export const duckDuckGo = (endpoint = 'https://html.duckduckgo.com/html/') => engine('duckduckgo', 'DuckDuckGo', endpoint, parseDuckDuckGoHtml);
export const duckDuckGoLite = (endpoint = 'https://lite.duckduckgo.com/lite/') => engine('duckduckgo-lite', 'DuckDuckGo', endpoint, parseDuckDuckGoLite);
