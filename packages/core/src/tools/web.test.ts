import { describe, expect, it } from 'vitest';
import { createWebFetchTool, htmlToMarkdown } from './web-fetch.ts';
import { createWebSearchTool } from './web-search.ts';
import { SearchService, type SearchConfig } from '../search/service.ts';
import type { Clock } from '../search/limiter.ts';
import type { ToolContext } from './types.ts';

/** Every test host resolves to a public address unless a test says otherwise. */
const publicDns = { allowPrivateNetworks: () => false, lookup: async () => ['93.184.216.34'] };

const ctx: ToolContext = { sessionId: 's', messageId: 'm', callId: 'c', signal: new AbortController().signal, emit: () => {} };
/** A clock that never waits, so rate limits don't slow tests. */
const instantClock = (): Clock => ({ now: () => Date.now(), random: () => 0, sleep: async () => {} });
const text = (out: { content: { type: string; text?: string }[] }) => out.content.map((c) => c.text ?? '').join('');

const ARTICLE = `<!doctype html><html><head><title>Release notes</title></head><body>
<nav><a href="/">Home</a> <a href="/pricing">Pricing</a></nav>
<article><h1>Release notes</h1>
<p>Version 2.4 ships <strong>faster sync</strong> and a new <a href="/docs/sync">sync guide</a>. ${'Details follow. '.repeat(30)}</p>
<p>Upgrade with <code>npm i app@2.4</code>.</p></article>
<footer>© Example</footer></body></html>`;

describe('WebFetch', () => {
  it('returns the main content as Markdown with absolute links', () => {
    const md = htmlToMarkdown(ARTICLE, 'https://example.com/blog/2-4');
    expect(md).toContain('**faster sync**');
    expect(md).toContain('(https://example.com/docs/sync)');
    expect(md).toContain('`npm i app@2.4`');
    expect(md).not.toContain('Pricing');
  });

  it('follows same-host redirects and reports cross-host ones', async () => {
    const seen: string[] = [];
    const tool = createWebFetchTool({
      ...publicDns,
      summarize: async () => null,
      fetch: async (url) => {
        seen.push(url);
        if (url.endsWith('/old')) return new Response(null, { status: 301, headers: { location: '/new' } });
        if (url.endsWith('/new')) return new Response(ARTICLE, { headers: { 'content-type': 'text/html' } });
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } });
      },
    });
    expect(text(await tool.run({ url: 'https://example.com/old' }, ctx))).toContain('faster sync');
    expect(seen).toEqual(['https://example.com/old', 'https://example.com/new']);
    const out = await tool.run({ url: 'https://example.com/elsewhere' }, ctx);
    expect(text(out)).toBe('https://example.com/elsewhere redirects to https://evil.example/x. Fetch that URL to continue.');
    expect(out.isError).toBeUndefined();
  });

  it('answers a prompt with the summarizer, or returns the page when there is none', async () => {
    const page = async () => new Response('plain facts', { headers: { 'content-type': 'text/plain' } });
    const withModel = createWebFetchTool({
      ...publicDns, fetch: page, summarize: async (content, prompt) => `${prompt} → ${content}` });
    expect(text(await withModel.run({ url: 'https://a.io/x', prompt: 'What?' }, ctx))).toBe('Source: https://a.io/x\n\nWhat? → plain facts');
    const without = createWebFetchTool({
      ...publicDns, fetch: page, summarize: async () => null });
    expect(text(await without.run({ url: 'https://a.io/x', prompt: 'What?' }, ctx))).toBe('Source: https://a.io/x\n\nplain facts');
  });

  it('rejects other schemes, HTTP errors and unreadable content', async () => {
    const tool = createWebFetchTool({
      ...publicDns,
      summarize: async () => null,
      fetch: async (url) => (url.includes('404') ? new Response('', { status: 404 }) : new Response(new Uint8Array(4), { headers: { 'content-type': 'image/png' } })),
    });
    expect((await tool.run({ url: 'file:///etc/passwd' }, ctx)).isError).toBe(true);
    expect(text(await tool.run({ url: 'https://a.io/404' }, ctx))).toContain('HTTP 404');
    expect(text(await tool.run({ url: 'https://a.io/img' }, ctx))).toContain("Can't read image/png");
  });
});

describe('WebFetch address guard', () => {
  const fetchOk = async () => new Response('secret', { headers: { 'content-type': 'text/plain' } });
  const tool = (addresses: string[], allowPrivate = false) => createWebFetchTool({ fetch: fetchOk, summarize: async () => null, allowPrivateNetworks: () => allowPrivate, lookup: async () => addresses });

  it.each([
    [['127.0.0.1'], 'this machine'],
    [['::1'], 'this machine'],
    [['169.254.169.254'], 'link-local'],
    [['10.0.0.5'], 'private network'],
    [['93.184.216.34', '192.168.1.10'], 'private network'],
    [['::ffff:127.0.0.1'], 'this machine'],
  ])('refuses %j', async (addresses, why) => {
    const out = await tool(addresses).run({ url: 'https://looks-public.example/x' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain(why);
  });

  it('allows private networks when the admin enabled them, but never this machine', async () => {
    expect((await tool(['192.168.1.10'], true).run({ url: 'http://nas.lan/docs' }, ctx)).isError).toBeUndefined();
    expect((await tool(['127.0.0.1'], true).run({ url: 'http://localhost:7340/api' }, ctx)).isError).toBe(true);
  });

  it('refuses URLs with credentials and stops reading oversized bodies', async () => {
    expect(text(await tool(['93.184.216.34']).run({ url: 'https://user:pw@example.com/' }, ctx))).toContain('credentials');
    const huge = createWebFetchTool({
      ...publicDns,
      summarize: async () => null,
      fetch: async () => new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(1024 * 1024)) }), { headers: { 'content-type': 'text/plain' } }),
    });
    expect(text(await huge.run({ url: 'https://example.com/stream' }, ctx))).toBe('The response is too large.');
  });
});

describe('WebSearch', () => {
  /** A tool over a real SearchService whose network is `respond`; pages for the open-web engines are served by it too. */
  function tool(config: SearchConfig, respond: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    };
    const service = new SearchService({ fetch, config: async () => config, clock: instantClock() });
    return { t: createWebSearchTool({ service }), calls };
  }
  const results = [
    { title: 'Docs', url: 'https://docs.example.com/a', content: 'Snippet <b>one</b> atelier' },
    { title: 'Spam', url: 'https://spam.io/b', content: 'two atelier' },
  ];

  it('queries SearXNG as JSON and applies domain filters', async () => {
    const { t, calls } = tool({ provider: 'searxng', url: 'http://searx.lan' }, () => Response.json({ results }));
    const out = text(await t.run({ query: 'atelier', blocked_domains: ['spam.io'] }, ctx));
    expect(calls[0]!.url).toBe('http://searx.lan/search?q=atelier+-site%3Aspam.io&format=json');
    expect(out).toBe('1. Docs\n   https://docs.example.com/a\n   Snippet <b>one</b> atelier\n\n(via SearXNG · 1 result)');
    expect(text(await t.run({ query: 'atelier', allowed_domains: ['example.com'] }, ctx))).toContain('docs.example.com');
  });

  it('explains how to enable SearXNG JSON output', async () => {
    const { t } = tool({ provider: 'searxng', url: 'http://searx.lan' }, () => new Response('', { status: 403 }));
    const out = await t.run({ query: 'x y' }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('search.formats');
  });

  it('sends the Brave token as a header and strips markup from snippets', async () => {
    const { t, calls } = tool({ provider: 'brave', apiKey: 'brv' }, () =>
      Response.json({ web: { results: [{ title: 'Docs', url: 'https://docs.example.com/a', description: 'Snippet <strong>one</strong> q' }] } }),
    );
    expect(text(await t.run({ query: 'q q' }, ctx))).toContain('Snippet one q');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Subscription-Token']).toBe('brv');
  });

  it('posts to Tavily with a bearer key; a provider without its key is the built-in search', async () => {
    const { t, calls } = tool({ provider: 'tavily', apiKey: 'tv' }, () => Response.json({ results }));
    await t.run({ query: 'atelier' }, ctx);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tv');
    const missing = tool({ provider: 'tavily' }, () => new Response('', { status: 500 }));
    await missing.t.run({ query: 'atelier' }, ctx);
    expect(missing.calls[0]!.url).not.toContain('tavily');
  });
});
