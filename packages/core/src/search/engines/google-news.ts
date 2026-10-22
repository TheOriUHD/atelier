/**
 * Google News as an RSS feed: a second, wider view of the news than Bing's, with the outlet, the time and a `when:`
 * window for freshness. Its links are redirects (they open the story in a browser, but a script is needed to follow
 * them), so each result is marked as one and the service prefers the same story from a feed with the real link.
 */
import type { Attempt, Engine, Freshness, SearchRequest, SearchResult } from '../types.ts';
import { clean, isoDate, operators } from '../text.ts';
import { rssItems } from '../rss.ts';
import { BROWSER_HEADERS, limited, page } from './common.ts';

const WINDOW: Record<Freshness, string> = { day: '1d', week: '7d', month: '30d', year: '1y' };

export function parseGoogleNews(xml: string): SearchResult[] {
  return rssItems(xml).flatMap((item) => {
    if (!item.title || !/^https?:\/\//.test(item.link)) return [];
    // "Headline - Outlet": the outlet is its own field.
    const headline = item.source && item.title.endsWith(` - ${item.source}`) ? item.title.slice(0, -(item.source.length + 3)) : item.title;
    const published = isoDate(item.pubDate);
    return [
      {
        title: clean(headline, 200),
        url: item.link,
        snippet: '',
        redirect: true,
        ...(item.source ? { source: clean(item.source, 80) } : {}),
        ...(item.sourceUrl ? { site: item.sourceUrl } : {}),
        ...(published ? { published } : {}),
      },
    ];
  });
}

export function googleNews(endpoint = 'https://news.google.com/rss/search'): Engine {
  return {
    id: 'google-news',
    name: 'Google News',
    family: 'google-news',
    gapMs: 1_500,
    kind: 'api',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      url.searchParams.set('q', [req.query, operators(req.allowed, req.blocked), req.freshness ? `when:${WINDOW[req.freshness]}` : ''].filter(Boolean).join(' '));
      url.searchParams.set('hl', 'en-US');
      url.searchParams.set('gl', 'US');
      url.searchParams.set('ceid', 'US:en');
      const got = await page(fetch, url.href, { headers: BROWSER_HEADERS }, signal);
      if ('failed' in got) return got.failed;
      if (limited(got.status)) return { outcome: 'blocked', reason: `Google News answered HTTP ${got.status}` };
      if (got.status >= 400) return { outcome: 'error', reason: `Google News answered HTTP ${got.status}` };
      const results = parseGoogleNews(got.body).slice(0, 12);
      return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
    },
  };
}
