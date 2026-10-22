import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Breakers } from './breaker.ts';
import { TtlCache } from './cache.ts';
import { parseBing } from './engines/bing.ts';
import { parseBrave } from './engines/brave.ts';
import { parseDuckDuckGoHtml, parseDuckDuckGoLite } from './engines/duckduckgo.ts';
import { parseWikipedia } from './engines/wikipedia.ts';
import { checkQuery } from './guard.ts';
import { Limiter, type Clock } from './limiter.ts';
import { diversify, fuse } from './merge.ts';
import { SearchService, SearchUnavailable, type SearchConfig } from './service.ts';
import { answersQuery, canonicalUrl, onDomain, operators, unwrapUrl } from './text.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');
const signal = new AbortController().signal;

describe('result pages', () => {
  it('reads DuckDuckGo HTML and Lite', () => {
    const html = parseDuckDuckGoHtml(fixture('ddg-html.html'));
    expect(html.results).toHaveLength(5);
    expect(html.results[0]).toMatchObject({ url: expect.stringMatching(/^https:\/\/tokio\.rs\//), snippet: expect.stringContaining('runtime') });
    const lite = parseDuckDuckGoLite(fixture('ddg-lite.html'));
    expect(lite.results).toHaveLength(4);
    expect(lite.results[0]!.snippet).toContain('runtime');
  });

  it('recognises a DuckDuckGo challenge', () => {
    expect(parseDuckDuckGoHtml(fixture('ddg-anomaly.html'))).toMatchObject({ results: [], blocked: expect.any(String) });
  });

  it('reads Brave and drops duplicate links', () => {
    const { results } = parseBrave(fixture('brave.html'));
    expect(results.length).toBeGreaterThanOrEqual(4);
    expect(new Set(results.map((r) => canonicalUrl(r.url))).size).toBe(results.length);
    expect(results[0]!.title).toContain('Tokio');
  });

  it("unwraps Bing's redirect links and strips tracking parameters", () => {
    const { results } = parseBing(fixture('bing.html'));
    expect(results.map((r) => r.url)).toEqual(['https://tokio.rs/', 'https://github.com/tokio-rs/tokio', 'https://tokio.rs/tokio/tutorial/async']);
    expect(results[0]!.snippet).toContain('reliable asynchronous');
  });

  it('finds no results on a page without any', () => {
    expect(parseBing(fixture('bing-none.html')).results).toEqual([]);
  });

  it('reads Wikipedia with plain-text snippets', () => {
    const results = parseWikipedia(fixture('wikipedia.json'));
    expect(results[0]).toMatchObject({ title: 'Tokio (software)', url: 'https://en.wikipedia.org/wiki/Tokio_(software)' });
    expect(results[0]!.snippet).not.toMatch(/[<>]|&quot;|&amp;/);
  });
});

describe('text', () => {
  it('unwraps engine redirects and refuses other schemes', () => {
    expect(unwrapUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dx%26id%3D2&rut=1')).toBe('https://example.com/a?id=2');
    expect(unwrapUrl('javascript:alert(1)')).toBeNull();
    expect(unwrapUrl('/relative', 'https://example.com/x')).toBe('https://example.com/relative');
  });

  it('treats www, fragments and trailing slashes as one page', () => {
    expect(canonicalUrl('https://www.Example.com/a/#top')).toBe(canonicalUrl('http://example.com/a'));
  });

  it('builds site operators for the domain filters', () => {
    expect(operators(['a.com', 'https://b.org/path'], ['spam.io'])).toBe('(site:a.com OR site:b.org) -site:spam.io');
    expect(onDomain('https://docs.a.com/x', ['a.com'])).toBe(true);
    expect(onDomain('https://nota.com/x', ['a.com'])).toBe(false);
  });

  it('tells results for the query from results for another one', () => {
    const good = parseBing(fixture('bing.html')).results;
    const decoy = parseBing(fixture('bing-decoy.html')).results;
    expect(decoy.length).toBeGreaterThan(0);
    expect(answersQuery('tokio async runtime', good)).toBe(true);
    expect(answersQuery('tokio async runtime', decoy)).toBe(false);
    expect(answersQuery('the', decoy)).toBe(true);
    // A query that names a company is answered with that company's own pages, which carry only the name.
    const company = [
      { title: 'Apple (Deutschland)', url: 'https://www.apple.com/de/', snippet: 'Entdecke die Welt von Apple.' },
      { title: 'iCloud', url: 'https://www.icloud.com/', snippet: 'Sign in' },
    ];
    expect(answersQuery('Apple event September 2026 keynote products announced', company)).toBe(true);
    // ...but a decoy that merely sits on some unrelated domain is still turned away.
    expect(answersQuery('Apple event September 2026 keynote products announced', decoy)).toBe(false);
    // The encyclopedia floor must be about it by name, not only share a word.
    const wiki = [{ title: 'The Day After Tomorrow', url: 'https://en.wikipedia.org/wiki/The_Day_After_Tomorrow', snippet: 'a film' }];
    expect(answersQuery('weather in berlin tomorrow', wiki)).toBe(false);
    expect(answersQuery('tomorrow film', wiki, true)).toBe(true);
  });
});

describe('guard', () => {
  it('refuses empty, long and credential-bearing queries', () => {
    expect(checkQuery('  ')).toMatchObject({ ok: false });
    expect(checkQuery('a'.repeat(401))).toMatchObject({ ok: false });
    expect(checkQuery('why does sk-ant-api03-abcdefghijklmnopqrstuvwxyz fail')).toMatchObject({ ok: false });
    expect(checkQuery('what is hunter2hunter2 in config', ['hunter2hunter2'])).toMatchObject({ ok: false });
    expect(checkQuery('  rust   async\nruntime ')).toEqual({ ok: true, query: 'rust async runtime' });
  });
});

describe('merge', () => {
  const r = (url: string, snippet = '') => ({ title: url, url, snippet });
  it('lifts what two lists agree on and keeps the longer snippet', () => {
    const fused = fuse([[r('https://a.com/1'), r('https://b.com/2', 'short')], [r('https://b.com/2', 'a longer snippet'), r('https://c.com/3')]]);
    expect(fused.map((x) => x.url)).toEqual(['https://b.com/2', 'https://a.com/1', 'https://c.com/3']);
    expect(fused[0]!.snippet).toBe('a longer snippet');
  });

  it('keeps at most three results per site', () => {
    const many = Array.from({ length: 6 }, (_, i) => r(`https://same.com/${i}`));
    expect(diversify([...many, r('https://other.com/x')], 10).map((x) => x.url)).toEqual(['https://same.com/0', 'https://same.com/1', 'https://same.com/2', 'https://other.com/x']);
  });
});

/** A clock that stands still: sleeping returns at once and notes how long it was asked to. */
function fakeClock() {
  const c = { t: 1_000_000, slept: [] as number[] };
  const clock: Clock = { now: () => c.t, random: () => 0, sleep: async (ms) => void c.slept.push(ms) };
  return { c, clock };
}

describe('limiter', () => {
  it('spaces one family and leaves others alone', async () => {
    const { c, clock } = fakeClock();
    const limiter = new Limiter(clock);
    const ran: string[] = [];
    const go = (family: string) => limiter.run(family, 4000, signal, async () => void ran.push(family));
    await Promise.all([go('ddg'), go('ddg'), go('brave'), go('ddg')]);
    // The second and third DuckDuckGo calls wait 4 and 8 seconds from now; Brave and the first call go at once.
    expect(c.slept).toEqual([4000, 8000]);
    expect(ran).toHaveLength(4);
  });

  it('lets a queued call leave when its signal aborts', async () => {
    const real = new Limiter({ now: () => Date.now(), random: () => 0, sleep: (ms, s) => new Promise((_, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true })) });
    const controller = new AbortController();
    await real.run('x', 60_000, signal, async () => 1);
    const waiting = real.run('x', 60_000, controller.signal, async () => 2);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
  });
});

describe('breakers', () => {
  it('opens on a block, probes once afterwards and closes on success', () => {
    const b = new Breakers();
    expect(b.allow('ddg', 0)).toBe(true);
    b.block('ddg', 0);
    expect(b.allow('ddg', 60_000)).toBe(false);
    expect(b.health('ddg', 60_000)).toMatchObject({ state: 'limited', retryAt: 120_000 });
    expect(b.allow('ddg', 120_000)).toBe(true);
    expect(b.allow('ddg', 120_001)).toBe(false); // the probe is out
    b.block('ddg', 121_000); // the probe failed: twice as long
    expect(b.health('ddg', 121_000)).toMatchObject({ retryAt: 121_000 + 240_000 });
    b.success('ddg', 500_000);
    expect(b.allow('ddg', 500_001)).toBe(true);
    expect(b.health('ddg', 500_001).state).toBe('ok');
  });

  it('opens after three strikes in a row', () => {
    const b = new Breakers();
    b.strike('bing', 0);
    b.strike('bing', 1);
    expect(b.allow('bing', 2)).toBe(true);
    b.strike('bing', 3);
    expect(b.allow('bing', 4)).toBe(false);
  });
});

describe('cache', () => {
  it('expires entries and evicts the least recently used', () => {
    const cache = new TtlCache<number>(2);
    cache.set('a', 1, 1000, 0);
    cache.set('b', 2, 1000, 0);
    expect(cache.get('a', 10)).toBe(1);
    cache.set('c', 3, 1000, 10);
    expect(cache.get('b', 10)).toBeUndefined();
    expect(cache.get('a', 2000)).toBeUndefined();
  });
});

describe('SearchService', () => {
  type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
  const html = (name: string, status = 200) => new Response(fixture(name), { status, headers: { 'content-type': 'text/html' } });
  const hosts = {
    ddg: (n: Handler) => ['html.duckduckgo.com', n] as const,
    brave: (n: Handler) => ['search.brave.com', n] as const,
    lite: (n: Handler) => ['lite.duckduckgo.com', n] as const,
    bing: (n: Handler) => ['www.bing.com', n] as const,
    wiki: (n: Handler) => ['en.wikipedia.org', n] as const,
  };

  function service(routes: (readonly [string, Handler])[], config: SearchConfig = { provider: 'auto' }, secrets: string[] = []) {
    const { c, clock } = fakeClock();
    const requests: { host: string; url: string; init: RequestInit }[] = [];
    const table = new Map(routes);
    const fetch = async (url: string, init: RequestInit) => {
      const host = new URL(url).hostname;
      requests.push({ host, url, init });
      const handler = table.get(host);
      if (!handler) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return handler(url, init);
    };
    return { s: new SearchService({ fetch, config: async () => config, secretValues: async () => secrets, clock }), requests, c };
  }
  // The ladder tests are about the general engines; routing by topic has its own tests (routing.test.ts).
  const q = (query: string, extra: object = {}) => ({ query, topic: 'general' as const, ...extra });

  it('answers from DuckDuckGo and caches the answer', async () => {
    const { s, requests } = service([hosts.ddg(() => html('ddg-html.html'))]);
    const first = await s.search(q('tokio async runtime'), signal);
    expect(first).toMatchObject({ engine: 'DuckDuckGo', cached: false });
    expect(first.results).toHaveLength(5);
    expect(await s.search(q('Tokio  async runtime'), signal)).toMatchObject({ cached: true });
    expect(requests).toHaveLength(1);
  });

  it('fails over to Brave when DuckDuckGo challenges, and leaves DuckDuckGo alone for a while', async () => {
    const { s, requests } = service([hosts.ddg(() => html('ddg-anomaly.html', 202)), hosts.brave(() => html('brave.html'))]);
    expect((await s.search(q('tokio async runtime'), signal)).engine).toBe('Brave');
    await s.search(q('tokio another query'), signal);
    expect(requests.filter((r) => r.host === 'html.duckduckgo.com')).toHaveLength(1);
    expect((await s.status()).engines.find((e) => e.id === 'duckduckgo')).toMatchObject({ state: 'limited' });
  });

  it('sends the next search to the engine that is ready while another waits its turn', async () => {
    const { s, requests } = service([hosts.ddg(() => html('ddg-html.html')), hosts.brave(() => html('brave.html'))]);
    await s.search(q('tokio async runtime'), signal);
    await s.search(q('tokio runtime tutorial'), signal);
    expect(requests.map((r) => r.host)).toEqual(['html.duckduckgo.com', 'search.brave.com']);
  });

  it('does not take the lite page for a second opinion after a block', async () => {
    const { s, requests } = service([hosts.ddg(() => html('ddg-anomaly.html', 202)), hosts.lite(() => html('ddg-lite.html')), hosts.brave(() => html('brave.html'))]);
    await s.search(q('tokio async runtime'), signal);
    expect(requests.some((r) => r.host === 'lite.duckduckgo.com')).toBe(false);
  });

  it('turns a page for another query away', async () => {
    const { s } = service([hosts.bing(() => html('bing-decoy.html')), hosts.wiki(() => new Response(fixture('wikipedia.json')))]);
    const answer = await s.search(q('tokio async runtime'), signal);
    expect(answer.engine).toBe('Wikipedia');
    expect(answer.note).toContain('Wikipedia only');
  });

  const bingPage = (items: [title: string, url: string, snippet: string][]) =>
    new Response(
      `<!doctype html><html><body><ol id="b_results">${items.map(([t, u, sn]) => `<li class="b_algo"><h2><a href="${u}">${t}</a></h2><div class="b_caption"><p>${sn}</p></div></li>`).join('')}</ol></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  const company: [string, string, string][] = [
    ['Apple (Deutschland)', 'https://www.apple.com/de/', 'Entdecke die Welt von Apple.'],
    ['Apple', 'https://www.apple.com/', 'Discover the innovative world of Apple.'],
    ['iCloud', 'https://www.icloud.com/', 'Sign in to iCloud.'],
    ['Apple Support', 'https://support.apple.com/', 'Get help.'],
  ];

  it('takes a company\'s own pages as the answer to a query that names the company, not Wikipedia', async () => {
    const { s, requests } = service([hosts.bing(() => bingPage(company)), hosts.wiki(() => new Response(fixture('wikipedia.json')))]);
    const answer = await s.search(q('Apple event September 2026 keynote products announced'), signal);
    expect(answer).toMatchObject({ engine: 'Bing' });
    expect(answer.note).toBeUndefined();
    expect(requests.some((r) => r.host === 'en.wikipedia.org')).toBe(false);
  });

  it('offers loosely matching pages with a warning instead of the encyclopedia, and never holds them against the engine', async () => {
    const loose: [string, string, string][] = [
      ['Keynote address announced', 'https://events.example.org/a', 'A conference.'],
      ['Conference schedule', 'https://events.example.org/b', 'Talks and workshops.'],
      ['Registration', 'https://events.example.org/c', 'Sign up.'],
    ];
    const { s, requests } = service([hosts.bing(() => bingPage(loose)), hosts.wiki(() => new Response(fixture('wikipedia.json')))]);
    for (const query of ['zorblax summit keynote lineup', 'zorblax summit keynote hotel', 'zorblax summit keynote parking', 'zorblax summit keynote catering']) {
      const answer = await s.search(q(query), signal);
      expect(answer).toMatchObject({ engine: 'Bing', note: expect.stringContaining('loosely') });
    }
    // Four loose answers in a row, and Bing was asked every time (no timeout), and the encyclopedia never.
    expect(requests.filter((r) => r.host === 'www.bing.com')).toHaveLength(4);
    expect(requests.some((r) => r.host === 'en.wikipedia.org')).toBe(false);
    expect((await s.status()).engines.find((e) => e.id === 'bing')).not.toMatchObject({ state: 'limited' });
  });

  it('believes "no results" only when two engines agree', async () => {
    const none = () => new Response('<html><body><div id="links"></div></body></html>');
    const { s } = service([hosts.ddg(none), hosts.brave(none)]);
    expect(await s.search(q('qzxvw lkjhgf zzqqxx'), signal)).toMatchObject({ results: [], empty: true });
    // One engine alone is not enough to say so.
    const one = service([hosts.ddg(none), hosts.brave(() => html('ddg-anomaly.html', 429))]);
    expect(await one.s.search(q('qzxvw lkjhgf zzqqxx'), signal)).toMatchObject({ empty: true, note: expect.stringContaining('one search engine') });
  });

  it('says it is offline rather than blocked', async () => {
    const { s } = service([]);
    await expect(s.search(q('tokio async runtime'), signal)).rejects.toMatchObject({ kind: 'offline' });
  });

  it('says when every engine is limiting requests', async () => {
    const limited = () => html('ddg-anomaly.html', 429);
    const { s } = service([hosts.ddg(limited), hosts.brave(limited), hosts.bing(limited), hosts.wiki(() => new Response('{}'))]);
    const error = await s.search(q('tokio async runtime'), signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchUnavailable);
    expect(error).toMatchObject({ kind: 'limited', retryAt: expect.any(Number) });
  });

  it('puts the domain filters in the query and filters what comes back', async () => {
    const { s, requests } = service([hosts.ddg(() => html('ddg-html.html'))]);
    const answer = await s.search(q('tokio async runtime', { allowed: ['tokio.rs'], blocked: ['spam.io'] }), signal);
    expect(String(requests[0]!.init.body)).toContain(encodeURIComponent('site:tokio.rs').replace(/%3A/g, '%3A'));
    expect(answer.results.every((r) => r.url.includes('tokio.rs'))).toBe(true);
  });

  it('refuses a query that carries a stored secret, without any request', async () => {
    const { s, requests } = service([hosts.ddg(() => html('ddg-html.html'))], { provider: 'auto' }, ['correct-horse-battery']);
    await expect(s.search(q('is correct-horse-battery valid'), signal)).rejects.toThrow('credential');
    expect(requests).toHaveLength(0);
  });

  it("uses a person's own provider alone", async () => {
    const down: Handler = () => new Response('', { status: 500 });
    const { s, requests } = service([['searx.lan', down], hosts.ddg(() => html('ddg-html.html'))], { provider: 'searxng', url: 'http://searx.lan' });
    await expect(s.search(q('tokio async runtime'), signal)).rejects.toThrow('SearXNG answered HTTP 500');
    expect(requests.map((r) => r.host)).toEqual(['searx.lan']);
  });

  it('tests a person’s own provider, not the built-in engines', async () => {
    const down: Handler = () => new Response('', { status: 500 });
    const { s, requests } = service([['searx.lan', down], hosts.ddg(() => html('ddg-html.html'))], { provider: 'searxng', url: 'http://searx.lan' });
    await expect(s.test(signal)).rejects.toThrow('SearXNG answered HTTP 500');
    expect(requests.map((r) => r.host)).toEqual(['searx.lan']);
  });

  it('treats a provider that lacks its key as the built-in search', async () => {
    const { s, requests } = service([hosts.ddg(() => html('ddg-html.html'))], { provider: 'tavily' });
    expect((await s.search(q('tokio async runtime'), signal)).engine).toBe('DuckDuckGo');
    expect(requests[0]!.host).toBe('html.duckduckgo.com');
    expect((await s.status()).mode).toBe('auto');
  });
});
