/**
 * Web search without anything to configure (docs/ARCHITECTURE.md §9-A). With the default `auto` provider a query goes
 * to the open-web engines in turn (DuckDuckGo, Brave, DuckDuckGo Lite, Bing), each through its family's rate limit and
 * breaker; a block fails over to the next engine, a page without results is confirmed by another engine before it
 * counts as "no results", and Wikipedia's API is the floor when the engines push back. What a query is about decides
 * more (topic.ts): the news go to the news feeds (Bing News, Google News), programming questions to Stack Overflow,
 * Hacker News and GitHub, with the general engines alongside, and the first few pages of an answer are read for the
 * passages that matter (excerpt.ts). A provider someone configured (SearXNG, Brave Search API, Tavily) is used alone:
 * their queries never go anywhere else.
 */
import type { Attempt, Engine, Fetcher, Freshness, SearchRequest, SearchResult, Topic } from './types.ts';
import { Breakers, type Health } from './breaker.ts';
import { TtlCache } from './cache.ts';
import { bing } from './engines/bing.ts';
import { bingNews } from './engines/bing-news.ts';
import { brave } from './engines/brave.ts';
import { custom, isConfigured, type CustomProvider } from './engines/custom.ts';
import { duckDuckGo, duckDuckGoLite } from './engines/duckduckgo.ts';
import { gitHub } from './engines/github.ts';
import { googleNews } from './engines/google-news.ts';
import { hackerNews } from './engines/hacker-news.ts';
import { stackExchange } from './engines/stack-exchange.ts';
import { wikipedia } from './engines/wikipedia.ts';
import { worthReading, type ExcerptReader } from './excerpt.ts';
import { checkQuery } from './guard.ts';
import { Limiter, systemClock, type Clock } from './limiter.ts';
import { diversify, fuse } from './merge.ts';
import { aboutQuery, answersQuery, FRESHNESS_DAYS, onDomain, sharesNothing } from './text.ts';
import { detectTopic, leansNews } from './topic.ts';

export interface SearchConfig {
  provider: 'auto' | CustomProvider;
  url?: string | undefined;
  apiKey?: string | undefined;
}

/** The configured provider with its key resolved from the secret store, as the service uses it. */
export async function resolveSearchConfig(
  setting: { provider: SearchConfig['provider']; url?: string | undefined; apiKey?: string | undefined },
  resolve: (value: string) => Promise<string>,
): Promise<SearchConfig> {
  return { provider: setting.provider, ...(setting.url ? { url: setting.url } : {}), ...(setting.apiKey ? { apiKey: await resolve(setting.apiKey) } : {}) };
}

export interface SearchDeps {
  /** Plain network access: the API providers and Wikipedia. */
  fetch: Fetcher;
  /** Browser-grade network access for result pages (Chromium's stack on the desktop); `fetch` when absent. */
  webFetch?: Fetcher | undefined;
  config(): Promise<SearchConfig>;
  /** Values that must never appear in a query (the stored secrets). */
  secretValues?(): Promise<readonly string[]>;
  /** Reads the relevant passages of a result page; without it results carry their snippets only. */
  excerpt?: ExcerptReader | undefined;
  /** Replacement result-page URLs, for tests that must not reach the internet. */
  endpoints?: Partial<Record<'duckduckgo' | 'duckduckgo-lite' | 'brave' | 'bing' | 'wikipedia' | 'bing-news' | 'google-news' | 'hacker-news' | 'stack-exchange' | 'github', string>> | undefined;
  clock?: Clock;
}

export interface SearchAnswer {
  results: SearchResult[];
  /** Who answered, as people know it ("DuckDuckGo", "SearXNG"). */
  engine: string;
  cached: boolean;
  /** Something the reader should know about these results (a floor answered, one engine only). */
  note?: string;
  /** The engines agree there is nothing. */
  empty?: boolean;
}

export class SearchUnavailable extends Error {
  constructor(
    message: string,
    readonly kind: 'limited' | 'offline' | 'failed',
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

export interface EngineStatus {
  id: string;
  name: string;
  /** What it answers: every query (the general engines), the news, or programming questions. */
  kind: 'web' | 'news' | 'dev';
  state: Health['state'];
  retryAt?: number;
  lastOkAt?: number;
}

export interface SearchStatus {
  mode: 'auto' | CustomProvider;
  engines: EngineStatus[];
}

const RESULTS = 10;
/** An engine that has to wait longer than this for its turn yields to one that doesn't. */
const READY_MS = 1_500;
/// Few results are worth a second engine's opinion; more are not worth the extra request and the extra leak.
const ENOUGH = 4;
/// Fewer stories than this from the feeds: the general engines are asked as well.
const MIN_NEWS = 5;
/// Developer communities that answered this well need no long wait for the general engines.
const DEV_ENOUGH = 5;
const GRACE_MS = 3_000;
/// Pages read for their passages, from the top of the list.
const READ_PAGES = 3;
/// "Latest", "today": the person wants the newest stories first.
const NEWEST = /\b(?:latest|newest|today|tonight|yesterday|breaking|recent(?:ly)?|this (?:week|weekend|morning)|just)\b/i;
const TTL_MS = 10 * 60_000;
const TTL_FRESH_MS = 2 * 60_000;

export class SearchService {
  private readonly clock: Clock;
  private readonly limiter: Limiter;
  private readonly breakers = new Breakers();
  private readonly cache = new TtlCache<SearchAnswer>();
  private readonly web: Engine[];
  private readonly news: Engine[];
  private readonly dev: Engine[];
  private readonly floor: Engine;

  constructor(private readonly deps: SearchDeps) {
    this.clock = deps.clock ?? systemClock;
    // The families keep their own gaps; a few more in flight lets the feeds and the APIs answer together.
    this.limiter = new Limiter(this.clock, 4);
    const at = deps.endpoints ?? {};
    // Preference order; Bing is last because it is the least reliable without a browser's history.
    this.web = [duckDuckGo(at.duckduckgo), brave(at.brave), duckDuckGoLite(at['duckduckgo-lite']), bing(at.bing)];
    this.news = [bingNews(at['bing-news']), googleNews(at['google-news'])];
    this.dev = [stackExchange(at['stack-exchange']), hackerNews(at['hacker-news']), gitHub(at.github)];
    this.floor = wikipedia(at.wikipedia);
  }

  async search(input: { query: string; freshness?: Freshness | undefined; topic?: Topic | undefined; allowed?: readonly string[] | undefined; blocked?: readonly string[] | undefined }, signal: AbortSignal): Promise<SearchAnswer> {
    const checked = checkQuery(input.query, (await this.deps.secretValues?.()) ?? []);
    if (!checked.ok) throw new SearchUnavailable(checked.message, 'failed');
    const req: SearchRequest = { query: checked.query, ...(input.freshness ? { freshness: input.freshness } : {}), allowed: input.allowed ?? [], blocked: input.blocked ?? [] };
    const config = await this.deps.config();
    const own = config.provider !== 'auto' && isConfigured({ provider: config.provider, url: config.url, apiKey: config.apiKey }) ? config.provider : null;
    const when = new Date(this.clock.now());
    const topic: Topic = input.topic ?? detectTopic(req.query, when);
    // One hint of news and no more: the feeds join the general engines instead of replacing them.
    const lean = !input.topic && topic === 'general' && leansNews(req.query, when);
    const key = [own ?? `auto:${topic}${lean ? '+news' : ''}`, req.freshness ?? '', req.allowed.join(','), req.blocked.join(','), req.query.toLowerCase()].join('|');
    const hit = this.cache.get(key, this.clock.now());
    if (hit) return { ...hit, cached: true };
    const answer = own ? await this.ownProvider({ ...config, provider: own }, req, signal) : await this.read(await this.route(topic, lean, req, signal), req, signal);
    if (answer.results.length) this.cache.set(key, answer, req.freshness ? TTL_FRESH_MS : TTL_MS, this.clock.now());
    return answer;
  }

  /** One real query, uncached and unfiltered: what Settings › Test search shows. */
  async test(signal: AbortSignal): Promise<{ engine: string; ms: number; results: SearchResult[] }> {
    const started = this.clock.now();
    const req: SearchRequest = { query: 'wikipedia', allowed: [], blocked: [] };
    // A person's own provider is tested as it is: it is the only thing their searches use.
    const config = await this.deps.config();
    const own = config.provider !== 'auto' && isConfigured({ provider: config.provider, url: config.url, apiKey: config.apiKey }) ? config.provider : null;
    const answer = own ? await this.ownProvider({ ...config, provider: own }, req, signal) : await this.ladder(req, signal);
    return { engine: answer.engine, ms: this.clock.now() - started, results: answer.results.slice(0, 3) };
  }

  async status(): Promise<SearchStatus> {
    const config = await this.deps.config();
    const now = this.clock.now();
    const own = config.provider !== 'auto' && isConfigured({ provider: config.provider, url: config.url, apiKey: config.apiKey });
    if (own) return { mode: config.provider, engines: [] };
    const seen = new Set<string>();
    const engines: EngineStatus[] = [];
    const groups = [['web', this.web], ['news', this.news], ['dev', this.dev]] as const;
    for (const [kind, list] of groups)
      for (const e of list) {
        if (seen.has(e.family)) continue;
        seen.add(e.family);
        const health = this.breakers.health(e.family, now);
        const lastOkAt = this.breakers.lastOkAt(e.family);
        engines.push({ id: e.family, name: e.name, kind, state: health.state, ...(health.state === 'limited' ? { retryAt: health.retryAt } : {}), ...(lastOkAt ? { lastOkAt } : {}) });
      }
    return { mode: 'auto', engines };
  }

  private async ownProvider(config: SearchConfig & { provider: CustomProvider }, req: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
    const engine = custom({ provider: config.provider, url: config.url, apiKey: config.apiKey });
    const attempt = await this.attempt(engine, req, signal, false);
    switch (attempt.outcome) {
      case 'ok':
        return { results: this.finish(attempt.results, req), engine: engine.name, cached: false };
      case 'empty':
        return { results: [], engine: engine.name, cached: false, empty: true };
      case 'offline':
        throw new SearchUnavailable("Web search can't reach the internet from this computer.", 'offline');
      case 'blocked':
      case 'error':
        throw new SearchUnavailable(attempt.reason, 'failed');
    }
  }

  /** Which sources a query goes to first, by what it is about. */
  private async route(topic: Topic, lean: boolean, req: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
    if (topic === 'general' && !lean) return this.ladder(req, signal);
    const now = this.clock.now();
    // Both feeds already weigh freshness; recency only decides among their picks when the person asked for the newest.
    // A story with a link that opens is worth a little more than the same rank behind a redirect nobody can read.
    const newest = topic === 'news' && (req.freshness || NEWEST.test(req.query));
    const boost = (r: SearchResult) => (r.redirect ? 0.92 : 1) * (newest ? recency(r, now) : 1);
    type Outcome = { answer: SearchAnswer } | { error: unknown };
    const settle = (run: Promise<SearchAnswer>): Promise<Outcome> => run.then((answer) => ({ answer }), (error: unknown) => ({ error }));

    // Programming questions are also answered by documentation and blogs, and a query with a hint of news by the
    // company's own pages, so the general engines run alongside the specialists; the news feeds of a query that is
    // surely about the news are asked alone first, and the general engines only when they came up short.
    const webStop = new AbortController();
    const forward = () => webStop.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    const alongside = topic !== 'news' ? settle(this.ladder(req, webStop.signal)) : null;
    let gathered: { engine: Engine; results: SearchResult[] }[];
    try {
      gathered = await this.gather(topic === 'dev' ? this.dev : this.news, req, signal);
    } catch (error) {
      webStop.abort();
      signal.removeEventListener('abort', forward);
      throw error;
    }
    const lists = gathered.map((g) => g.results);
    const stories = this.within(fuse(lists, boost), req.freshness, now);

    let web: Outcome | null = null;
    if (alongside) {
      const timer = stories.length >= DEV_ENOUGH ? setTimeout(() => webStop.abort(), GRACE_MS) : null;
      web = await alongside;
      if (timer) clearTimeout(timer);
    } else if (stories.length < MIN_NEWS) {
      web = await settle(this.ladder(req, signal));
    }
    signal.removeEventListener('abort', forward);
    if (signal.aborted) throw signal.reason;

    const webAnswer = web && 'answer' in web ? web.answer : null;
    if (!stories.length) {
      if (webAnswer) return webAnswer;
      if (web && 'error' in web) throw web.error;
      return { results: [], engine: gathered.map((g) => g.engine.name).join(' and ') || this.news[0]!.name, cached: false, empty: true };
    }
    // A general answer that carries a warning (the encyclopedia floor, loose matches) would only dilute real stories.
    // And next to real stories only the general results that are about the query themselves earn a place ("Next.js"
    // is not a clothing shop): the engines' own idea of relevance is exactly what the specialists were added for.
    const general = webAnswer && !webAnswer.note ? webAnswer.results.filter((r) => aboutQuery(req.query, r)) : [];
    const names = [...gathered.map((g) => g.engine.name), ...(general.length && webAnswer ? [webAnswer.engine] : [])];
    const merged = this.within(fuse([...lists, general], boost), req.freshness, now);
    return { results: this.finish(merged, req), engine: sentence(names), cached: false };
  }

  /** The specialists in parallel, each through its family's limit and breaker; what they found, engine by engine. */
  private async gather(engines: readonly Engine[], req: SearchRequest, signal: AbortSignal): Promise<{ engine: Engine; results: SearchResult[] }[]> {
    const found = await Promise.all(
      engines.map(async (engine) => {
        if (!this.breakers.allow(engine.family, this.clock.now())) return null;
        const attempt = await this.attempt(engine, req, signal, true);
        const now = this.clock.now();
        // Results that share nothing with the query are an index's guess, not an answer.
        if (attempt.outcome === 'ok' && !sharesNothing(req.query, attempt.results)) {
          this.breakers.success(engine.family, now);
          return { engine, results: attempt.results };
        }
        if (attempt.outcome === 'blocked') this.breakers.block(engine.family, now);
        else this.breakers.release(engine.family);
        return null;
      }),
    );
    return found.filter((f): f is { engine: Engine; results: SearchResult[] } => f !== null);
  }

  /** Results inside the freshness window; those without a date (most web pages) stay. */
  private within(results: readonly SearchResult[], freshness: Freshness | undefined, now: number): SearchResult[] {
    if (!freshness) return [...results];
    const from = now - FRESHNESS_DAYS[freshness] * 86_400_000;
    return results.filter((r) => !r.published || Date.parse(r.published) >= from);
  }

  /** The most relevant passages of the first few pages, so the answer has substance and not only links. */
  private async read(answer: SearchAnswer, req: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
    const reader = this.deps.excerpt;
    if (!reader || answer.results.length === 0) return answer;
    // A Stack Overflow snippet already is the passage; links that only redirect can't be read without a browser.
    const targets = answer.results.filter((r) => !r.redirect && r.source !== 'Stack Overflow' && worthReading(r.url)).slice(0, READ_PAGES);
    const passages = await Promise.all(targets.map((r) => reader(r.url, req.query, signal).catch(() => null)));
    if (signal.aborted) throw signal.reason;
    const byUrl = new Map(targets.map((r, i) => [r.url, passages[i]] as const));
    return { ...answer, results: answer.results.map((r) => { const extract = byUrl.get(r.url); return extract ? { ...r, extract } : r; }) };
  }

  private async ladder(req: SearchRequest, signal: AbortSignal): Promise<SearchAnswer> {
    const outcomes = new Map<string, Attempt>();
    const answered: { engine: Engine; results: SearchResult[] }[] = [];
    const emptied = new Map<string, Engine>();
    let doubtful: { engine: Engine; results: SearchResult[] } | null = null;
    let offline = 0;

    for (let pass = 0; pass < 2 && answered.length === 0; pass++) {
      // The engine that can go now before one that would have to wait its turn: bursts of searches use both indexes.
      const order = [...this.web].sort((a, b) => Number(this.limiter.waitFor(a.family) > READY_MS) - Number(this.limiter.waitFor(b.family) > READY_MS));
      for (const engine of order) {
        if (pass === 1 && !emptied.has(engine.id)) continue;
        // DuckDuckGo's Lite page is only another way into the backend that just refused.
        const siblingBlocked = this.web.some((e) => e !== engine && e.family === engine.family && outcomes.get(e.id)?.outcome === 'blocked');
        if (siblingBlocked || !this.breakers.allow(engine.family, this.clock.now())) continue;
        const attempt = await this.attempt(engine, req, signal, true);
        outcomes.set(engine.id, attempt);
        const now = this.clock.now();
        if (attempt.outcome === 'ok') {
          if (answersQuery(req.query, attempt.results)) {
            this.breakers.success(engine.family, now);
            answered.push({ engine, results: attempt.results });
            if (attempt.results.length >= ENOUGH) break;
          } else if (sharesNothing(req.query, attempt.results)) {
            // Results with nothing to do with the query: a decoy, no better than an empty page.
            this.breakers.strike(engine.family, now);
            outcomes.set(engine.id, { outcome: 'empty' });
            emptied.set(engine.id, engine);
          } else {
            // A loose match (an engine's own idea of a name or a brand): real pages, not a block. Kept in case nothing
            // answers better, and never held against the engine.
            if (!doubtful || attempt.results.length > doubtful.results.length) doubtful = { engine, results: attempt.results };
            this.breakers.release(engine.family);
          }
        } else if (attempt.outcome === 'empty') {
          emptied.set(engine.id, engine);
          this.breakers.release(engine.family);
        } else if (attempt.outcome === 'blocked') {
          this.breakers.block(engine.family, now);
        } else {
          if (attempt.outcome === 'offline') offline++;
          this.breakers.release(engine.family);
        }
      }
    }

    if (answered.length) {
      // An engine that returned nothing while another had results is being soft-blocked.
      for (const e of emptied.values()) this.breakers.strike(e.family, this.clock.now());
      const first = answered[0]!;
      const merged = answered.length > 1 ? fuse(answered.map((a) => a.results)) : first.results;
      return { results: this.finish(merged, req), engine: answered.map((a) => a.engine.name).filter((n, i, all) => all.indexOf(n) === i).join(' and '), cached: false };
    }
    const reached = new Set([...emptied.values()].map((e) => e.family));
    if (offline > 0 && outcomes.size === offline) throw new SearchUnavailable("Web search can't reach the internet from this computer.", 'offline');
    // No engine answered it well, but one gave real pages that match loosely: better than the encyclopedia, which has
    // nothing on a current event. The reader is told they may not fit.
    if (doubtful && doubtful.results.length >= 3) {
      return {
        results: this.finish(doubtful.results, req),
        engine: doubtful.engine.name,
        cached: false,
        note: 'These results only loosely match the query (the engine answered with general pages, such as a company\'s own site). Say so if they do not help.',
      };
    }
    if (reached.size >= 2) return { results: [], engine: [...emptied.values()].map((e) => e.name).join(' and '), cached: false, empty: true };

    // Everything open-web said no: Wikipedia answers factual queries whatever the engines think of this address.
    const wiki = await this.attempt(this.floor, req, signal, false);
    if (wiki.outcome === 'ok' && answersQuery(req.query, wiki.results, true)) {
      const note = 'General web search is unavailable right now (the search engines are limiting requests), so these results come from Wikipedia only. Say so if the question needs current or non-encyclopedic information.';
      return { results: this.finish(wiki.results, req), engine: this.floor.name, cached: false, note };
    }
    if (reached.size === 1) {
      return { results: [], engine: [...emptied.values()][0]!.name, cached: false, empty: true, note: 'Only one search engine could be reached, so this may be incomplete.' };
    }
    const now = this.clock.now();
    const waits = this.web.flatMap((e) => {
      const h = this.breakers.health(e.family, now);
      return h.state === 'limited' ? [h.retryAt] : [];
    });
    throw new SearchUnavailable('The search engines are limiting requests from this computer.', 'limited', waits.length ? Math.min(...waits) : undefined);
  }

  private async attempt(engine: Engine, req: SearchRequest, signal: AbortSignal, spaced: boolean): Promise<Attempt> {
    const fetch = engine.kind === 'web' ? (this.deps.webFetch ?? this.deps.fetch) : this.deps.fetch;
    const run = () => engine.search(req, fetch, signal);
    try {
      return spaced ? await this.limiter.run(engine.family, engine.gapMs, signal, run) : await run();
    } catch (error) {
      if (signal.aborted) {
        // Stopped part-way: the probe a half-open breaker allowed told nothing, so the next request may probe again.
        this.breakers.release(engine.family);
        throw error;
      }
      return { outcome: 'error', reason: error instanceof Error ? error.message : 'the request failed' };
    }
  }

  private finish(results: readonly SearchResult[], req: SearchRequest): SearchResult[] {
    // A redirect link says nothing about the site: the outlet's own address does.
    const allowed = req.allowed.length ? results.filter((r) => onDomain(r.site ?? r.url, req.allowed)) : results;
    const kept = req.blocked.length ? allowed.filter((r) => !onDomain(r.site ?? r.url, req.blocked)) : allowed;
    return diversify(kept, RESULTS);
  }
}

/** Stories from the last days count for more than the same match from last year: up to +80%, fading over about ten days. */
function recency(result: SearchResult, now: number): number {
  const at = result.published ? Date.parse(result.published) : NaN;
  return Number.isFinite(at) ? 1 + 0.8 * Math.exp(-Math.max(0, now - at) / (10 * 86_400_000)) : 1;
}

/** "A", "A and B", "A, B and C". */
function sentence(names: readonly string[]): string {
  const unique = names.filter((n, i) => names.indexOf(n) === i);
  return unique.length > 1 ? `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}` : (unique[0] ?? '');
}
