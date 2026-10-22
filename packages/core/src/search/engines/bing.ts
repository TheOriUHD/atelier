/**
 * Bing's results page. Of all the engines it is the most erratic without a browser's history: it answers many requests
 * with a page that says "no results", or with results for another query altogether. The service validates what comes
 * back (text.ts answersQuery) and keeps Bing last among the open-web engines.
 */
import { parseHTML } from 'linkedom';
import type { Attempt, Engine, Parsed, SearchRequest, SearchResult } from '../types.ts';
import { clean, operators, unwrapUrl } from '../text.ts';
import { BROWSER_HEADERS, limited, page } from './common.ts';

/** `filters=ex1:"ez1"` is "past 24 hours", ez2 the week, ez3 the month; Bing has no plain year filter. */
const FILTER = { day: 'ez1', week: 'ez2', month: 'ez3' } as const;

export function parseBing(html: string): Parsed {
  const { document } = parseHTML(html);
  if (document.querySelector('#b_captcha, .captcha, #captcha')) return { results: [], blocked: 'Bing asked for a challenge' };
  const results: SearchResult[] = [];
  for (const el of document.querySelectorAll('li.b_algo')) {
    const a = el.querySelector('h2 a');
    const url = unwrapUrl(a?.getAttribute('href'), 'https://www.bing.com/');
    if (!a || !url) continue;
    const snippet = el.querySelector('.b_caption p, p.b_lineclamp2, .b_algoSlug');
    results.push({ title: clean(a.textContent, 200), url, snippet: clean(snippet?.textContent, 500) });
  }
  return { results };
}

export function bing(endpoint = 'https://www.bing.com/search'): Engine {
  return {
    id: 'bing',
    name: 'Bing',
    family: 'bing',
    gapMs: 2_500,
    kind: 'web',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      url.searchParams.set('q', [req.query, operators(req.allowed, req.blocked)].filter(Boolean).join(' '));
      url.searchParams.set('setlang', 'en');
      const filter = req.freshness && req.freshness !== 'year' ? FILTER[req.freshness] : null;
      if (filter) url.searchParams.set('filters', `ex1:"${filter}"`);
      const got = await page(fetch, url.href, { headers: BROWSER_HEADERS }, signal);
      if ('failed' in got) return got.failed;
      if (limited(got.status)) return { outcome: 'blocked', reason: `Bing answered HTTP ${got.status}` };
      if (got.status >= 400) return { outcome: 'error', reason: `Bing answered HTTP ${got.status}` };
      const parsed = parseBing(got.body);
      if (parsed.blocked) return { outcome: 'blocked', reason: parsed.blocked };
      return parsed.results.length ? { outcome: 'ok', results: parsed.results } : { outcome: 'empty' };
    },
  };
}
