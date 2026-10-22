import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBingNews } from './engines/bing-news.ts';
import { parseGitHub } from './engines/github.ts';
import { parseGoogleNews } from './engines/google-news.ts';
import { parseHackerNews } from './engines/hacker-news.ts';
import { parseStackExchange } from './engines/stack-exchange.ts';
import { createExcerptReader, relevantExcerpt } from './excerpt.ts';
import type { Clock } from './limiter.ts';
import { fuse } from './merge.ts';
import { rssItems } from './rss.ts';
import { SearchService } from './service.ts';
import { aboutQuery, decodeEntities, keywords, titleKey, unwrapUrl } from './text.ts';
import { detectTopic, leansNews } from './topic.ts';
import { formatAnswer, whenText } from '../tools/web-search.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8');
const signal = new AbortController().signal;
const NOW = Date.parse('2026-10-17T12:00:00Z');

describe('the feeds', () => {
  it('reads RSS items with entities, CDATA and the outlet', () => {
    const items = rssItems(
      '<rss><channel><title>Feed</title><item><title>A &amp; B &#39;quoted&#39;</title><link>https://x.test/a?b=1&amp;c=2</link><description><![CDATA[<b>bold</b> text]]></description><pubDate>Tue, 13 Oct 2026 11:50:00 GMT</pubDate><News:Source>PCMag</News:Source></item></channel></rss>',
    );
    expect(items).toEqual([{ title: "A & B 'quoted'", link: 'https://x.test/a?b=1&c=2', description: '<b>bold</b> text', pubDate: 'Tue, 13 Oct 2026 11:50:00 GMT', source: 'PCMag', sourceUrl: '' }]);
    expect(decodeEntities('&amp;lt; &#x41; &unknown;')).toBe('&lt; A &unknown;');
  });

  it("reads Bing News: the outlet's own link, the outlet and the time", () => {
    const results = parseBingNews(fixture('bing-news.xml'));
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({ url: 'https://www.example-daily.test/news/nimbus-welcome-home-event', source: 'Example Daily', published: '2026-10-13T11:50:00.000Z' });
    expect(results.every((r) => !r.url.includes('bing.com'))).toBe(true);
    expect(unwrapUrl('http://www.bing.com/news/apiclick.aspx?ref=x&url=https%3a%2f%2fa.test%2fp%3futm_source%3dz&c=1')).toBe('https://a.test/p');
  });

  it('reads Google News: headline and outlet apart, the link marked as a redirect', () => {
    const results = parseGoogleNews(fixture('google-news.xml'));
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({ title: 'In the Loop: Welcome home', source: 'Nimbus', site: 'https://www.nimbus.test', redirect: true, published: '2026-10-08T07:00:00.000Z' });
    expect(results[1]!.title).toBe('Nimbus Event Reportedly Planned for October 13');
    expect(results[1]!.url).toMatch(/^https:\/\/news\.google\.com\/rss\/articles\//);
  });

  it('reads Hacker News with the discussion link, and drops stories nobody upvoted', () => {
    const results = parseHackerNews(fixture('hn.json'));
    expect(results[0]).toMatchObject({ title: expect.stringContaining('Tokio'), url: 'https://github.com/tokio-rs/tokio', source: 'Hacker News' });
    expect(results[0]!.snippet).toContain('https://news.ycombinator.com/item?id=22986516');
    expect(parseHackerNews(JSON.stringify({ hits: [{ objectID: '1', title: 'x', points: 1 }, { objectID: '2', title: 'No link', points: 9, num_comments: 1 }] }))).toMatchObject([{ url: 'https://news.ycombinator.com/item?id=2' }]);
  });

  it('reads Stack Overflow excerpts as plain text, and sees a pause request or an empty quota', () => {
    const { results } = parseStackExchange(fixture('stackexchange.json'));
    expect(results[0]).toMatchObject({ url: 'https://stackoverflow.com/questions/70000001', source: 'Stack Overflow', title: expect.stringContaining('"Cannot drop a runtime') });
    expect(results[0]!.snippet).not.toMatch(/<span|&#39;|&hellip;/);
    expect(results[0]!.snippet).toContain("I'm dropping a tokio runtime");
    expect(results[1]!.url).toBe('https://stackoverflow.com/a/70000002');
    expect(results[3]!.title).toBe("Tokio panics with 'there is no reactor running'");
    expect(parseStackExchange('{"items":[],"backoff":10}').blocked).toBeDefined();
    expect(parseStackExchange('{"items":[],"quota_remaining":0}').blocked).toBeDefined();
    expect(parseStackExchange('{"items":[{"title":"T","item_type":"answer","question_id":5,"answer_id":9,"excerpt":"x"}]}').results[0]!.url).toBe('https://stackoverflow.com/a/9');
  });

  it('reads GitHub repositories with their facts', () => {
    const results = parseGitHub(fixture('github.json'));
    expect(results[0]).toMatchObject({ title: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio', source: 'GitHub' });
    expect(results[0]!.snippet).toMatch(/33,444 stars, Rust/);
  });
});

describe('keywords', () => {
  it('drops questions, filler and operators, and keeps the spelling of what is left', () => {
    expect(keywords('what did Apple announce this week?')).toEqual(['Apple', 'announce', 'week']);
    expect(keywords('Next.js 16 release notes site:nextjs.org')).toEqual(['Next.js', '16', 'release', 'notes']);
    expect(keywords('the of and')).toEqual(['the', 'of', 'and']);
  });
  it('tells a result about the query from one that only shares a name', () => {
    const r = (title: string) => ({ title, url: 'https://x.test/', snippet: '' });
    expect(aboutQuery('Next.js 16 release notes', r('Next Deutschland: Online-Mode'))).toBe(false);
    expect(aboutQuery('Next.js 16 release notes', r('Next.js 16 release notes and upgrade guide'))).toBe(true);
    expect(aboutQuery('', r('anything'))).toBe(true);
  });
});

describe('topic', () => {
  const now = new Date(NOW);
  it.each([
    ['Apple event September 2026', 'news'],
    ['what did Apple announce at the keynote', 'news'],
    ['Taylor Swift tour announcement', 'news'],
    ['openai latest news', 'news'],
    ['Rust 1.90 release announced', 'news'],
    ['who won the Formula 1 race last weekend', 'news'],
    ['tokio runtime panic cannot drop a runtime', 'dev'],
    ['TypeError: x is not a function', 'dev'],
    ['how to use useEffect cleanup in react', 'dev'],
    ['latest react version', 'dev'],
    ['docker compose network_mode host', 'dev'],
    ['weather in Berlin today', 'general'],
    ['what is the capital of Australia', 'general'],
    ['best pasta recipe', 'general'],
    ['Windows 11 24H2 release notes', 'general'],
  ])('%s is %s', (query, topic) => {
    expect(detectTopic(query, now)).toBe(topic);
  });
});

describe('a hint of news', () => {
  const now = new Date(NOW);
  it('is told from a clear case and from no news at all', () => {
    expect(leansNews('Nimbus event', now)).toBe(true);
    expect(leansNews('new iPhone', now)).toBe(true);
    expect(leansNews('Nimbus event September 2026', now)).toBe(false);
    expect(leansNews('what is the capital of Australia', now)).toBe(false);
    expect(leansNews('react release', now)).toBe(false);
    expect(leansNews('weather latest', now)).toBe(false);
  });
});

describe('fusing stories', () => {
  const story = (title: string, url: string, extra: object = {}) => ({ title, url, snippet: '', ...extra });
  it('takes one story from two feeds once, with the link that opens and what both knew', () => {
    const fused = fuse([
      [story('Apple Event Reportedly Planned for October 13 - MacRumors', 'https://news.google.com/rss/articles/abc', { redirect: true, source: 'MacRumors', published: '2026-10-04T07:00:00.000Z' })],
      [story('Apple Event Reportedly Planned for October 13', 'https://www.macrumors.com/2026/10/04/apple-event/', { snippet: 'Apple is planning an event.' })],
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({ url: 'https://www.macrumors.com/2026/10/04/apple-event/', source: 'MacRumors', published: '2026-10-04T07:00:00.000Z', snippet: 'Apple is planning an event.' });
    expect(fused[0]!.redirect).toBeUndefined();
    expect(titleKey('Headline here - Outlet')).toBe('headline here');
  });

  it('does not merge short titles that unrelated pages share', () => {
    expect(fuse([[story('Home', 'https://a.test/')], [story('Home', 'https://b.test/')]])).toHaveLength(2);
  });

  it('lets a boost lift the newer story', () => {
    const fused = fuse([[story('Older story about the thing', 'https://a.test/1'), story('Newer story about the thing', 'https://a.test/2', { published: 'new' })]], (r) => (r.published ? 3 : 1));
    expect(fused[0]!.url).toBe('https://a.test/2');
  });
});

describe('SearchService by topic', () => {
  type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
  const text = (body: string, type = 'text/xml', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
  const html = (name: string) => text(fixture(name), 'text/html');

  function service(routes: Record<string, Handler>, excerpt?: (url: string, query: string, signal: AbortSignal) => Promise<string | null>) {
    const c = { t: NOW };
    const clock: Clock = { now: () => c.t, random: () => 0, sleep: async () => {} };
    const requests: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      requests.push(url);
      const handler = routes[new URL(url).hostname];
      if (!handler) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return handler(url, init);
    };
    const s = new SearchService({ fetch, config: async () => ({ provider: 'auto' }), clock, ...(excerpt ? { excerpt } : {}) });
    return { s, requests, c };
  }
  const news = (url: string) => (url.includes('/news/search') ? text(fixture('bing-news.xml')) : html('bing.html'));
  const feeds = { 'www.bing.com': news, 'news.google.com': () => text(fixture('google-news.xml')) };

  afterEach(() => vi.useRealTimers());

  it('answers news from the feeds alone when they have enough, newest first', async () => {
    const { s, requests } = service(feeds);
    const answer = await s.search({ query: 'Nimbus event October 2026' }, signal);
    expect(answer.engine).toBe('Bing News and Google News');
    expect(requests.some((u) => u.includes('duckduckgo'))).toBe(false);
    expect(answer.results.length).toBeGreaterThanOrEqual(5);
    // The story both feeds carry comes first (and once); the clock does not decide.
    expect(answer.results[0]).toMatchObject({ title: 'Nimbus invites media to October 28 launch experience', url: 'https://www.mac-rumours.test/2026/10/15/nimbus-october-28-launch' });
    const keys = answer.results.map((r) => titleKey(r.title));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lifts the newest stories when the person asks for the latest', async () => {
    const { s } = service(feeds);
    const rank = (a: Awaited<ReturnType<typeof s.search>>) => a.results.findIndex((r) => r.published?.startsWith('2026-10-16'));
    const plain = await s.search({ query: 'Nimbus event news' }, signal);
    const latest = await s.search({ query: 'latest Nimbus event news' }, signal);
    expect(rank(latest)).toBeLessThan(rank(plain));
  });

  it('keeps to the freshness window and filters redirected stories by the outlet’s site', async () => {
    const { s } = service(feeds);
    const week = await s.search({ query: 'Nimbus event October 2026', freshness: 'week' }, signal);
    expect(week.results.every((r) => !r.published || Date.parse(r.published) >= NOW - 7 * 86_400_000)).toBe(true);
    const only = await s.search({ query: 'Nimbus event October 2026', allowed: ['nimbus.test'] }, signal);
    expect(only.results.length).toBeGreaterThan(0);
    expect(only.results.every((r) => (r.site ?? r.url).includes('nimbus.test'))).toBe(true);
  });

  it('asks the general engines as well when the feeds come up short', async () => {
    const thin = '<rss><channel><item><title>Tokio runtime summit announced for spring</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fa.test%2fz</link></item></channel></rss>';
    const { s, requests } = service({
      'www.bing.com': (url) => (url.includes('/news/search') ? text(thin) : html('bing.html')),
      'news.google.com': () => text('<rss><channel></channel></rss>'),
      'html.duckduckgo.com': () => html('ddg-html.html'),
    });
    const answer = await s.search({ query: 'tokio runtime summit announced' }, signal);
    expect(requests.some((u) => u.includes('duckduckgo'))).toBe(true);
    expect(answer.engine).toMatch(/^Bing News and /);
    expect(answer.results[0]!.title).toContain('summit');
    expect(answer.results.length).toBeGreaterThan(1);
  });

  it('keeps only the general results that are about the query next to real stories', async () => {
    const { s } = service({
      'www.bing.com': (url) => (url.includes('/news/search') ? text(fixture('bing-news.xml')) : html('bing.html')),
      'news.google.com': () => text('<rss><channel></channel></rss>'),
      'html.duckduckgo.com': () => html('ddg-html.html'),
    });
    const answer = await s.search({ query: 'nimbus event', topic: 'news' }, signal);
    expect(answer.results.every((r) => r.published || /nimbus|event/i.test(`${r.title} ${r.snippet} ${r.url}`))).toBe(true);
  });

  it('falls back to the web ladder when both feeds are blocked, and leaves them alone for a while', async () => {
    const { s, requests } = service({ 'www.bing.com': (url) => (url.includes('/news/search') ? text('', 'text/plain', 429) : html('bing.html')), 'news.google.com': () => text('', 'text/plain', 429), 'html.duckduckgo.com': () => html('ddg-html.html') });
    const answer = await s.search({ query: 'tokio news announced today' }, signal);
    expect(answer.engine).toBe('DuckDuckGo');
    const feedRequests = requests.filter((u) => u.includes('/news/')).length;
    await s.search({ query: 'tokio news announced yesterday' }, signal);
    expect(requests.filter((u) => u.includes('/news/')).length).toBe(feedRequests);
  });

  it('reports the news feeds and the developer communities in the status, apart from the general engines', async () => {
    const { s } = service({ 'www.bing.com': (url) => (url.includes('/news/search') ? text('', 'text/plain', 429) : html('bing.html')), 'news.google.com': () => text(fixture('google-news.xml')), 'html.duckduckgo.com': () => html('ddg-html.html') });
    await s.search({ query: 'tokio news announced today', topic: 'news' }, signal);
    const { engines } = await s.status();
    expect(engines.map((e) => [e.kind, e.name])).toEqual([
      ['web', 'DuckDuckGo'],
      ['web', 'Brave'],
      ['web', 'Bing'],
      ['news', 'Bing News'],
      ['news', 'Google News'],
      ['dev', 'Stack Overflow'],
      ['dev', 'Hacker News'],
      ['dev', 'GitHub'],
    ]);
    expect(engines.find((e) => e.id === 'bing-news')).toMatchObject({ state: 'limited' });
    expect(engines.find((e) => e.id === 'google-news')).toMatchObject({ state: 'ok' });
    expect(engines.find((e) => e.id === 'github')).toMatchObject({ state: 'unknown' });
  });

  it('asks the developer communities and the web together', async () => {
    const { s, requests } = service({
      'api.stackexchange.com': () => text(fixture('stackexchange.json'), 'application/json'),
      'hn.algolia.com': () => text(fixture('hn.json'), 'application/json'),
      'api.github.com': () => text(fixture('github.json'), 'application/json'),
      'html.duckduckgo.com': () => html('ddg-html.html'),
    });
    const answer = await s.search({ query: 'tokio runtime panic' }, signal);
    expect(requests.some((u) => u.includes('stackexchange'))).toBe(true);
    expect(requests.some((u) => u.includes('duckduckgo'))).toBe(true);
    const urls = answer.results.map((r) => r.url);
    expect(urls.some((u) => u.startsWith('https://stackoverflow.com/questions/'))).toBe(true);
    expect(urls).toContain('https://github.com/tokio-rs/tokio');
    expect(answer.engine).toContain('Stack Overflow');
    expect(answer.engine).toContain('DuckDuckGo');
  });

  it('does not wait long for the general engines once the communities answered well', async () => {
    vi.useFakeTimers();
    const hang: Handler = (_url, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const { s } = service({
      'api.stackexchange.com': () => text(fixture('stackexchange.json'), 'application/json'),
      'hn.algolia.com': () => text(fixture('hn.json'), 'application/json'),
      'api.github.com': () => text(fixture('github.json'), 'application/json'),
      'html.duckduckgo.com': hang,
      'search.brave.com': hang,
      'lite.duckduckgo.com': hang,
      'www.bing.com': hang,
    });
    const pending = s.search({ query: 'tokio runtime panic' }, signal);
    await vi.advanceTimersByTimeAsync(3_500);
    const answer = await pending;
    expect(answer.results.length).toBeGreaterThanOrEqual(5);
    expect(answer.engine).not.toContain('DuckDuckGo');
  });

  it('adds the news feeds to the general engines for a query with only a hint of news', async () => {
    const { s, requests } = service({ ...feeds, 'html.duckduckgo.com': () => html('ddg-html.html') });
    const answer = await s.search({ query: 'Nimbus event' }, signal);
    expect(requests.some((u) => u.includes('duckduckgo'))).toBe(true);
    expect(requests.some((u) => u.includes('/news/search'))).toBe(true);
    expect(answer.engine).toContain('Bing News');
    expect(answer.engine).toContain('DuckDuckGo');
    // The stories come first.
    expect(answer.results[0]!.published).toBeDefined();
  });

  it('lets the caller name the topic', async () => {
    const { s, requests } = service({ ...feeds, 'html.duckduckgo.com': () => html('ddg-html.html') });
    await s.search({ query: 'Nimbus event October 2026', topic: 'general' }, signal);
    expect(requests.some((u) => u.includes('/news/') || u.includes('news.google'))).toBe(false);
  });

  it('reads the first readable pages for their passages, and only those', async () => {
    const read = vi.fn(async (url: string) => (url.includes('boom') ? null : `passage of ${url}`));
    const { s } = service(
      {
        'api.stackexchange.com': () => text(fixture('stackexchange.json'), 'application/json'),
        'hn.algolia.com': () =>
          text(JSON.stringify({ hits: [{ objectID: '1', title: 'Tokio runtime internals', url: 'https://www.reddit.com/r/rust/x', points: 50 }, { objectID: '2', title: 'Tokio runtime boom', url: 'https://boom.test/a', points: 50 }, { objectID: '3', title: 'Tokio runtime guide', url: 'https://blog.test/guide', points: 50 }] }), 'application/json'),
        'api.github.com': () => text(fixture('github.json'), 'application/json'),
      },
      read,
    );
    const answer = await s.search({ query: 'tokio runtime', topic: 'dev' }, signal);
    const asked = read.mock.calls.map(([u]) => u);
    expect(asked).toHaveLength(3);
    expect(asked).toContain('https://github.com/tokio-rs/tokio');
    // Not read: a site that answers scripts with a wall, a Stack Overflow snippet that already is the passage.
    expect(asked.some((u) => u.includes('reddit.com') || u.includes('stackoverflow.com'))).toBe(false);
    expect(answer.results.find((r) => r.url === 'https://github.com/tokio-rs/tokio')!.extract).toBe('passage of https://github.com/tokio-rs/tokio');
    // A page that can't be read leaves the result as it was.
    expect(answer.results.find((r) => r.url.includes('boom.test'))!.extract).toBeUndefined();
  });

  it('never reads a Google News redirect', async () => {
    const read = vi.fn(async (_url: string) => 'x');
    const { s } = service({ 'www.bing.com': () => text('<rss><channel></channel></rss>'), 'news.google.com': () => text(fixture('google-news.xml')), 'html.duckduckgo.com': () => html('ddg-html.html') }, read);
    await s.search({ query: 'Nimbus event October 2026' }, signal);
    expect(read.mock.calls.every(([u]) => !String(u).includes('news.google.com'))).toBe(true);
  });
});

describe('reading a page', () => {
  const page = `<html><head><title>The Welcome Home event</title></head><body><nav><a href="/a">Home</a> <a href="/b">News</a></nav><article><h1>The Welcome Home event</h1>
    <p>Apple announced a new HomePod mini and a home hub at its Welcome Home event in New York on Tuesday, with preorders starting the same day.</p>
    <p>Subscribe to our newsletter to get the latest stories in your inbox every morning, plus offers from our partners and more.</p>
    <p>The company also showed how the new hub works with the rest of its devices, and said that the software ships next month to everyone.</p>
    <p>Unrelated paragraph about the history of the company and its founders, which says nothing about the questions being asked at all today.</p></article></body></html>`;

  it('keeps the passages that share the most with the query, in page order, without menus and calls to subscribe', () => {
    const markdown = [
      '# The Welcome Home event',
      '[Home](https://x.test/) [News](https://x.test/n) [Reviews](https://x.test/r) [Deals](https://x.test/d) [Videos](https://x.test/v)',
      'Apple announced a new HomePod mini and a home hub at its Welcome Home event in New York on Tuesday, with preorders starting the same day.',
      'Subscribe to our newsletter to get the latest stories in your inbox every morning, plus offers from our partners and more.',
      'The company also showed how the new hub works with the rest of its devices, and said that the software ships next month to everyone.',
      'Unrelated paragraph about the history of the company and its founders, which says nothing about the questions being asked at all today.',
    ].join('\n\n');
    const excerpt = relevantExcerpt(markdown, 'Apple Welcome Home event hub')!;
    expect(excerpt).toContain('HomePod mini');
    expect(excerpt).not.toMatch(/newsletter|\[Home\]|Unrelated/);
    expect(excerpt.length).toBeLessThanOrEqual(700);
    expect(relevantExcerpt('short\n\nbits', 'anything')).toBeNull();
  });

  const reader = (handler: (url: string) => Response, lookup = async () => ['93.184.216.34']) => createExcerptReader({ fetch: async (url) => handler(url), allowPrivateNetworks: () => false, lookup });
  const ok = (body: string, type = 'text/html; charset=utf-8') => new Response(body, { status: 200, headers: { 'content-type': type } });

  it('fetches, extracts and trims a page', async () => {
    const excerpt = await reader(() => ok(page))('https://news.test/story', 'Apple Welcome Home event', signal);
    expect(excerpt).toContain('HomePod mini');
  });

  it('refuses private addresses, other hosts after a redirect, and anything but HTML', async () => {
    expect(await reader(() => ok(page), async () => ['127.0.0.1'])('https://news.test/story', 'x', signal)).toBeNull();
    expect(await reader(() => new Response(null, { status: 301, headers: { location: 'https://other.test/' } }))('https://news.test/story', 'x', signal)).toBeNull();
    expect(await reader(() => ok('%PDF', 'application/pdf'))('https://news.test/doc', 'x', signal)).toBeNull();
    expect(await reader(() => ok(page))('https://www.youtube.com/watch?v=1', 'x', signal)).toBeNull();
    expect(await reader(() => new Response('no', { status: 500 }))('https://news.test/story', 'x', signal)).toBeNull();
  });

  it('follows a redirect inside the same host', async () => {
    let hop = 0;
    const excerpt = await reader(() => (hop++ === 0 ? new Response(null, { status: 301, headers: { location: '/moved' } }) : ok(page)))('https://news.test/story', 'Apple Welcome Home event', signal);
    expect(excerpt).toContain('HomePod mini');
  });
});

describe('what the model reads', () => {
  it('dates a story and says how long ago, names the outlet, and marks redirects and passages', () => {
    const text = formatAnswer(
      'apple event',
      {
        engine: 'Bing News and Google News',
        cached: false,
        results: [
          { title: 'Apple event details', url: 'https://www.pcmag.com/a', snippet: 'A snippet.', source: 'PCMag', published: '2026-10-13T11:50:00.000Z', extract: 'The page says so.' },
          { title: 'In the Loop', url: 'https://news.google.com/rss/articles/x', snippet: '', redirect: true, source: 'Apple', published: '2026-10-08T07:00:00.000Z' },
          { title: 'Plain', url: 'https://example.com/', snippet: 'Plain snippet.' },
          { title: 'tokio-rs/tokio', url: 'https://github.com/tokio-rs/tokio', snippet: 'A runtime.', source: 'GitHub' },
        ],
      },
      NOW,
    );
    expect(text).toContain('1. Apple event details\n   https://www.pcmag.com/a\n   Published: Oct 13, 2026 (4 days ago) · PCMag\n   A snippet.\n   Page: The page says so.');
    expect(text).toContain('(not fetchable: a Google News redirect)');
    expect(text).toContain('3. Plain\n   https://example.com/\n   Plain snippet.');
    expect(text).toContain('4. tokio-rs/tokio\n   https://github.com/tokio-rs/tokio\n   Source: GitHub\n   A runtime.');
    expect(text).toMatch(/\n\n\(via Bing News and Google News · 4 results\)$/);
    expect(whenText('2026-10-17T01:00:00Z', NOW)).toBe('Oct 17, 2026 (today)');
    expect(whenText('2026-10-16T01:00:00Z', NOW)).toBe('Oct 16, 2026 (yesterday)');
    expect(whenText('2025-01-01T00:00:00Z', NOW)).toMatch(/\(\d+ months ago\)/);
  });
});
