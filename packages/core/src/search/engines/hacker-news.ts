/** Hacker News through Algolia's public API: what developers are reading and arguing about, with the discussion link. */
import type { Attempt, Engine, SearchRequest, SearchResult } from '../types.ts';
import { FRESHNESS_DAYS, aboutQuery, clean, isoDate } from '../text.ts';
import { limited, page } from './common.ts';

interface Body {
  hits?: { objectID?: string; title?: string | null; url?: string | null; points?: number | null; num_comments?: number | null; created_at?: string }[];
}

/** Stories nobody upvoted are noise, not signal. */
const MIN_POINTS = 5;

export function parseHackerNews(body: string): SearchResult[] {
  let json: Body;
  try {
    json = JSON.parse(body) as Body;
  } catch {
    return [];
  }
  return (json.hits ?? []).flatMap((hit) => {
    if (!hit.objectID || !hit.title || (hit.points ?? 0) < MIN_POINTS) return [];
    const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`;
    const published = isoDate(hit.created_at);
    const comments = hit.num_comments ?? 0;
    return [
      {
        title: clean(hit.title, 200),
        url: hit.url && /^https?:\/\//.test(hit.url) ? hit.url : discussion,
        snippet: `${hit.points} points and ${comments} comment${comments === 1 ? '' : 's'} on Hacker News. Discussion: ${discussion}`,
        source: 'Hacker News',
        ...(published ? { published } : {}),
      },
    ];
  });
}

export function hackerNews(endpoint = 'https://hn.algolia.com/api/v1/search'): Engine {
  return {
    id: 'hacker-news',
    name: 'Hacker News',
    family: 'hacker-news',
    gapMs: 800,
    kind: 'api',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      url.searchParams.set('query', req.query);
      url.searchParams.set('tags', 'story');
      url.searchParams.set('hitsPerPage', '10');
      // A sentence rarely matches a title word for word: Algolia drops words from the end until something does.
      url.searchParams.set('removeWordsIfNoResults', 'lastWords');
      if (req.freshness) url.searchParams.set('numericFilters', `created_at_i>${Math.floor(Date.now() / 1000 - FRESHNESS_DAYS[req.freshness] * 86_400)}`);
      const got = await page(fetch, url.href, { headers: { 'User-Agent': 'Atelier (self-hosted assistant)', Accept: 'application/json' } }, signal);
      if ('failed' in got) return got.failed;
      if (limited(got.status)) return { outcome: 'blocked', reason: `Hacker News search answered HTTP ${got.status}` };
      if (got.status >= 400) return { outcome: 'error', reason: `Hacker News search answered HTTP ${got.status}` };
      // Algolia drops words to find something: keep the stories that still share the query's subject.
      const results = parseHackerNews(got.body).filter((r) => aboutQuery(req.query, r, 0.3));
      return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
    },
  };
}
