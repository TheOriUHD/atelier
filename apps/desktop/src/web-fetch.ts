/**
 * Network access for search engines' result pages. Node's `fetch` is recognisably not a browser (several engines answer
 * it with empty or unrelated results); Chromium's own network stack, which the desktop app already ships, is one.
 */
export type WebFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The user agent of the Chromium inside this Electron, so what is sent matches how it connects. */
export function browserUserAgent(platform: string = process.platform, chrome: string = process.versions.chrome ?? '130.0.0.0'): string {
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

export function createWebFetch(net: { fetch(url: string, init?: RequestInit): Promise<Response> }, userAgent = browserUserAgent()): WebFetch {
  return (url, init) => {
    const headers = new Headers(init.headers);
    headers.set('User-Agent', userAgent);
    // No cookies in either direction: a search is not a session.
    return net.fetch(url, { ...init, headers, credentials: 'omit' });
  };
}
