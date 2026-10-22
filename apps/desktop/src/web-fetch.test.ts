import { describe, expect, it } from 'vitest';
import { browserUserAgent, createWebFetch } from './web-fetch.ts';

describe('web fetch', () => {
  it('names the Chromium it runs on, per platform', () => {
    expect(browserUserAgent('darwin', '152.0.1')).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.1 Safari/537.36');
    expect(browserUserAgent('win32', '152.0.1')).toContain('Windows NT 10.0; Win64; x64');
    expect(browserUserAgent('linux', '152.0.1')).toContain('X11; Linux x86_64');
  });

  it('sends requests without cookies and with the browser user agent', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetch = createWebFetch({ fetch: async (url, init) => ((seen = { url, init: init! }), new Response('ok')) }, 'UA/1');
    await fetch('https://example.com/', { headers: { 'Accept-Language': 'de', 'User-Agent': 'node' }, method: 'POST' });
    expect(seen!.url).toBe('https://example.com/');
    expect(seen!.init).toMatchObject({ credentials: 'omit', method: 'POST' });
    const headers = new Headers(seen!.init.headers);
    expect(headers.get('user-agent')).toBe('UA/1');
    expect(headers.get('accept-language')).toBe('de');
  });
});
