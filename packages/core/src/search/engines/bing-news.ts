/**
 * Bing News as an RSS feed: current stories from real outlets, with the outlet and the time. Unlike the web results page
 * it isn't tied to a browser's history or answered with brand pages, which makes it the first stop for anything that
 * happened lately. The links go through Bing's click tracker; the outlet's own URL is in them.
 */
import type { Attempt, Engine, SearchRequest, SearchResult } from '../types.ts';
import { clean, isoDate, keywords, operators, unwrapUrl } from '../text.ts';
import { rssItems } from '../rss.ts';
import { BROWSER_HEADERS, limited, page } from './common.ts';

export function parseBingNews(xml: string): SearchResult[] {
  return rssItems(xml).flatMap((item) => {
    const url = unwrapUrl(item.link, 'https://www.bing.com/');
    if (!url || !item.title) return [];
    const published = isoDate(item.pubDate);
    return [
      {
        title: clean(item.title, 200),
        url,
        snippet: clean(item.description, 500),
        ...(item.source ? { source: clean(item.source, 80) } : {}),
        ...(published ? { published } : {}),
      },
    ];
  });
}

export function bingNews(endpoint = 'https://www.bing.com/news/search'): Engine {
  return {
    id: 'bing-news',
    name: 'Bing News',
    family: 'bing-news',
    gapMs: 1_500,
    kind: 'api',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      // Bing News matches every word: a question ("what did X announce this week") finds one story, its keywords many.
      url.searchParams.set('q', [keywords(req.query).join(' '), operators(req.allowed, req.blocked)].filter(Boolean).join(' '));
      url.searchParams.set('format', 'rss');
      // English-language, US edition: the feed otherwise follows the address it is asked from.
      url.searchParams.set('setlang', 'en-US');
      url.searchParams.set('mkt', 'en-US');
      url.searchParams.set('cc', 'US');
      // Newest first when the person wants the last day or week; otherwise Bing's own relevance.
      if (req.freshness === 'day' || req.freshness === 'week') url.searchParams.set('qft', 'sortbydate="1"');
      const got = await page(fetch, url.href, { headers: BROWSER_HEADERS }, signal);
      if ('failed' in got) return got.failed;
      if (limited(got.status)) return { outcome: 'blocked', reason: `Bing News answered HTTP ${got.status}` };
      if (got.status >= 400) return { outcome: 'error', reason: `Bing News answered HTTP ${got.status}` };
      const results = parseBingNews(got.body);
      return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
    },
  };
}
