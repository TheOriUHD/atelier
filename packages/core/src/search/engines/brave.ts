/** Brave's own index through its public results page (the Brave Search API is the separate `brave-api` provider). */
import { parseHTML } from 'linkedom';
import type { Attempt, Engine, Parsed, SearchRequest, SearchResult } from '../types.ts';
import { canonicalUrl, clean, operators, unwrapUrl } from '../text.ts';
import { BROWSER_HEADERS, limited, page } from './common.ts';

const TF = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;

export function parseBrave(html: string): Parsed {
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll('div.snippet[data-type="web"]')) {
    const a = el.querySelector('a.l1') ?? el.querySelector('a[href^="http"]');
    const url = unwrapUrl(a?.getAttribute('href'));
    if (!url || seen.has(canonicalUrl(url))) continue;
    seen.add(canonicalUrl(url));
    const title = clean(el.querySelector('.title')?.textContent ?? a?.textContent, 200);
    const snippet = clean(el.querySelector('.content, .snippet-description')?.textContent, 500);
    if (title) results.push({ title, url, snippet });
  }
  if (results.length === 0 && /captcha|verify you are human|unusual traffic/i.test(`${document.title} ${document.querySelector('body')?.textContent?.slice(0, 600) ?? ''}`)) {
    return { results, blocked: 'Brave asked for a challenge' };
  }
  return { results };
}

export function brave(endpoint = 'https://search.brave.com/search'): Engine {
  return {
    id: 'brave',
    name: 'Brave',
    family: 'brave',
    gapMs: 2_000,
    kind: 'web',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      url.searchParams.set('q', [req.query, operators(req.allowed, req.blocked)].filter(Boolean).join(' '));
      url.searchParams.set('source', 'web');
      if (req.freshness) url.searchParams.set('tf', TF[req.freshness]);
      const got = await page(fetch, url.href, { headers: BROWSER_HEADERS }, signal);
      if ('failed' in got) return got.failed;
      if (limited(got.status)) return { outcome: 'blocked', reason: `Brave answered HTTP ${got.status}` };
      if (got.status >= 400) return { outcome: 'error', reason: `Brave answered HTTP ${got.status}` };
      const parsed = parseBrave(got.body);
      if (parsed.blocked) return { outcome: 'blocked', reason: parsed.blocked };
      return parsed.results.length ? { outcome: 'ok', results: parsed.results } : { outcome: 'empty' };
    },
  };
}
