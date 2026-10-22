/** Wikipedia's search API: official, keyless and never blocked. The floor under the open-web engines. */
import type { Attempt, Engine, SearchRequest, SearchResult } from '../types.ts';
import { clean } from '../text.ts';
import { page } from './common.ts';

interface Body {
  query?: { search?: { title?: string; snippet?: string }[] };
}

const ENTITIES: Record<string, string> = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#039;': "'", '&nbsp;': ' ' };

export function parseWikipedia(body: string, origin = 'https://en.wikipedia.org'): SearchResult[] {
  let json: Body;
  try {
    json = JSON.parse(body) as Body;
  } catch {
    return [];
  }
  return (json.query?.search ?? []).flatMap((r) =>
    r.title
      ? [
          {
            title: clean(r.title, 200),
            url: `${origin}/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
            snippet: clean((r.snippet ?? '').replace(/<[^>]+>/g, '').replace(/&(?:quot|amp|lt|gt|#039|nbsp);/g, (m) => ENTITIES[m] ?? m), 500),
          },
        ]
      : [],
  );
}

export function wikipedia(endpoint = 'https://en.wikipedia.org/w/api.php'): Engine {
  return {
    id: 'wikipedia',
    name: 'Wikipedia',
    family: 'wikipedia',
    gapMs: 500,
    kind: 'api',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      for (const [k, v] of Object.entries({ action: 'query', list: 'search', srsearch: req.query, srlimit: '8', format: 'json', origin: '*' })) url.searchParams.set(k, v);
      const got = await page(fetch, url.href, { headers: { 'User-Agent': 'Atelier (self-hosted assistant)', Accept: 'application/json' } }, signal);
      if ('failed' in got) return got.failed;
      if (got.status >= 400) return { outcome: 'error', reason: `Wikipedia answered HTTP ${got.status}` };
      const results = parseWikipedia(got.body, new URL(endpoint).origin);
      return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
    },
  };
}
