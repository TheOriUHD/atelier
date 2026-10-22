/** The providers someone points Atelier at themselves: SearXNG, the Brave Search API and Tavily. Used alone, never as a fallback. */
import type { Attempt, Engine, SearchRequest, SearchResult } from '../types.ts';
import { clean, operators } from '../text.ts';
import { page } from './common.ts';

export type CustomProvider = 'searxng' | 'brave' | 'tavily';

export interface CustomConfig {
  provider: CustomProvider;
  /** SearXNG base URL. */
  url?: string | undefined;
  /** Brave subscription token or Tavily key, already resolved from the secret store. */
  apiKey?: string | undefined;
}

const MAX = 20;

const pick = (items: { title?: string; url?: string; content?: string; description?: string }[] | undefined, strip = false): SearchResult[] =>
  (items ?? []).flatMap((r) => (r.url ? [{ title: clean(r.title ?? r.url, 200), url: r.url, snippet: clean(strip ? (r.description ?? r.content ?? '').replace(/<[^>]+>/g, '') : (r.content ?? r.description ?? ''), 500) }] : []));

/** Whether the provider has what it needs; a provider that lacks it is treated as the built-in search. */
export function isConfigured(c: CustomConfig): boolean {
  return c.provider === 'searxng' ? !!c.url?.trim() : !!c.apiKey?.trim();
}

export function custom(config: CustomConfig): Engine {
  const base = { family: config.provider, gapMs: 0, kind: 'api' as const };
  switch (config.provider) {
    case 'searxng':
      return {
        ...base,
        id: 'searxng',
        name: 'SearXNG',
        async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
          const root = config.url!.trim();
          const url = new URL('search', root.endsWith('/') ? root : `${root}/`);
          url.searchParams.set('q', [req.query, operators(req.allowed, req.blocked)].filter(Boolean).join(' '));
          url.searchParams.set('format', 'json');
          if (req.freshness) url.searchParams.set('time_range', req.freshness);
          const got = await page(fetch, url.href, { headers: { Accept: 'application/json' } }, signal);
          if ('failed' in got) return got.failed;
          if (got.status === 403) return { outcome: 'error', reason: 'SearXNG refused JSON output. Add `json` to `search.formats` in its settings.yml.' };
          if (got.status >= 400) return { outcome: 'error', reason: `SearXNG answered HTTP ${got.status}.` };
          const body = JSON.parse(got.body) as { results?: { title?: string; url?: string; content?: string }[] };
          const results = pick(body.results);
          return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
        },
      };
    case 'brave':
      return {
        ...base,
        id: 'brave-api',
        name: 'Brave Search',
        async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
          const url = new URL('https://api.search.brave.com/res/v1/web/search');
          url.searchParams.set('q', [req.query, operators(req.allowed, req.blocked)].filter(Boolean).join(' '));
          url.searchParams.set('count', String(MAX));
          if (req.freshness) url.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[req.freshness]);
          const got = await page(fetch, url.href, { headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey! } }, signal);
          if ('failed' in got) return got.failed;
          if (got.status === 401 || got.status === 403) return { outcome: 'error', reason: 'Brave Search rejected the API key.' };
          if (got.status >= 400) return { outcome: 'error', reason: `Brave Search answered HTTP ${got.status}.` };
          const body = JSON.parse(got.body) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
          const results = pick(body.web?.results, true);
          return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
        },
      };
    case 'tavily':
      return {
        ...base,
        id: 'tavily',
        name: 'Tavily',
        async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
          const got = await page(
            fetch,
            'https://api.tavily.com/search',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey!}` },
              body: JSON.stringify({
                query: req.query,
                max_results: MAX,
                ...(req.allowed.length ? { include_domains: req.allowed } : {}),
                ...(req.blocked.length ? { exclude_domains: req.blocked } : {}),
                ...(req.freshness ? { time_range: req.freshness } : {}),
              }),
            },
            signal,
          );
          if ('failed' in got) return got.failed;
          if (got.status === 401 || got.status === 403) return { outcome: 'error', reason: 'Tavily rejected the API key.' };
          if (got.status >= 400) return { outcome: 'error', reason: `Tavily answered HTTP ${got.status}.` };
          const body = JSON.parse(got.body) as { results?: { title?: string; url?: string; content?: string }[] };
          const results = pick(body.results);
          return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
        },
      };
  }
}
