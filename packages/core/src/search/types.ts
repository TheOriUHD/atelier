/** Shapes shared by the search engines and the service that orders them (docs/ARCHITECTURE.md §9-A). */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Who published it: the news outlet, or the community a developer result comes from. */
  source?: string;
  /** When it was published (ISO), for news and discussions. */
  published?: string;
  /** The site the story is from, when `url` is only an engine's redirect to it (Google News). */
  site?: string;
  /** `url` is an engine redirect that opens in a browser but that WebFetch can't follow. */
  redirect?: boolean;
  /** The most relevant lines of the page itself, read for the first results (excerpt.ts). */
  extract?: string;
}

/** What a query is about decides which sources are asked first (topic.ts). */
export type Topic = 'news' | 'dev' | 'general';

export type Freshness = 'day' | 'week' | 'month' | 'year';

export interface SearchRequest {
  query: string;
  freshness?: Freshness;
  /** Domains results must come from; subdomains count. */
  allowed: readonly string[];
  /** Domains results must not come from. */
  blocked: readonly string[];
}

/** What one engine made of one request. `empty` is a page without results: honest, or a soft block (see service.ts). */
export type Attempt =
  | { outcome: 'ok'; results: SearchResult[] }
  | { outcome: 'empty' }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'offline' }
  | { outcome: 'error'; reason: string };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface Engine {
  id: string;
  name: string;
  /** Engines of one family share a rate limit and a breaker (DuckDuckGo's HTML and Lite pages are one backend). */
  family: string;
  /** Minimum gap between this family's requests. */
  gapMs: number;
  /** Open-web engines are fetched like a browser would; API engines (keyed or official) use the plain fetch. */
  kind: 'web' | 'api';
  search(req: SearchRequest, fetch: Fetcher, signal: AbortSignal): Promise<Attempt>;
}

/** What a parser found in one page. */
export interface Parsed {
  results: SearchResult[];
  /** The page is a challenge or a block, not a results page. */
  blocked?: string;
}
