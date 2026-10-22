import { describe, expect, it, vi } from 'vitest';
import { FileReads, PAGE_CSP, WorkspacePages, isWorkspacePage, pagePath, pageType, sameGrant } from './workspace-pages.ts';

const html = new TextEncoder().encode('<!doctype html><link rel="stylesheet" href="style.css"><p>hi');

function pages(files: Record<string, Uint8Array> = { 'site/index.html': html, 'site/style.css': new TextEncoder().encode('p{}') }) {
  const read = vi.fn(async (_host: number, _workspaceId: string, path: string) => files[path] ?? null);
  let n = 0;
  return { pages: new WorkspacePages(read, () => `grant${++n}`), read };
}

describe('workspace files in the Browser pane', () => {
  it('give each window one origin per workspace, and forget a window’s when it goes', async () => {
    const { pages: p } = pages();
    const origin = p.origin(1, 'ws-a');
    expect(origin).toBe('atelier-files://grant1/');
    expect(p.origin(1, 'ws-a')).toBe(origin);
    expect(p.origin(1, 'ws-b')).toBe('atelier-files://grant2/');
    expect(p.origin(2, 'ws-a')).toBe('atelier-files://grant3/');
    p.forget(1);
    expect((await p.handle(new Request(`${origin}site/index.html`))).status).toBe(404);
    expect((await p.handle(new Request('atelier-files://grant3/site/index.html'))).status).toBe(200);
  });

  it('serve a file by its path from the root, read by the window that asked, sandboxed', async () => {
    const { pages: p, read } = pages();
    const origin = p.origin(7, 'ws');
    const page = await p.handle(new Request(`${origin}site/index.html`));
    expect(page.status).toBe(200);
    expect(read).toHaveBeenCalledWith(7, 'ws', 'site/index.html');
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(html);
    expect(page.headers.get('content-type')).toBe('text/html');
    expect(page.headers.get('content-security-policy')).toBe(PAGE_CSP);
    expect(PAGE_CSP).toMatch(/^sandbox /);
    expect(PAGE_CSP).not.toContain('allow-same-origin');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('access-control-allow-origin')).toBeNull();

    // A relative link resolves next to the page.
    const style = await p.handle(new Request(new URL('style.css', `${origin}site/index.html`)));
    expect(style.headers.get('content-type')).toBe('text/css');
    // A folder serves its index.html.
    expect((await p.handle(new Request(`${origin}site/`))).status).toBe(200);
  });

  it('refuse paths that leave the workspace, unknown grants, missing files and writes', async () => {
    const { pages: p, read } = pages();
    const origin = p.origin(1, 'ws');
    for (const path of ['site/..%2f..%2fsecret', 'a%5c..%5c..%5csecret', 'a%00.html', '%2Fetc%2Fpasswd'])
      expect((await p.handle(new Request(`${origin}${path}`))).status, path).toBe(400);
    // Dot segments the URL parser resolves stay under the root.
    for (const path of ['site/../../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd']) {
      await p.handle(new Request(`${origin}${path}`));
      expect(read).toHaveBeenLastCalledWith(1, 'ws', 'etc/passwd');
    }
    // And any that reach the handler unresolved are refused.
    for (const pathname of ['/../secret', '/site/%2e%2e/%2e%2e/secret', '/./a.html', '/a/%2E%2E/b']) expect(pagePath(pathname), pathname).toBeNull();
    expect((await p.handle(new Request('atelier-files://guessed/site/index.html'))).status).toBe(404);
    expect((await p.handle(new Request(`${origin}nope.html`))).status).toBe(404);
    expect((await p.handle(new Request(`${origin}site/index.html`, { method: 'POST', body: 'x' }))).status).toBe(405);
  });

  it('name paths and types', () => {
    expect(pagePath('/')).toBe('index.html');
    expect(pagePath('/docs/My%20Page.html')).toBe('docs/My Page.html');
    expect(pagePath('/a//b.png')).toBe('a/b.png');
    expect(pagePath('/%E0%A4%A')).toBeNull();
    for (const [path, type] of [
      ['a.HTM', 'text/html'],
      ['logo.svg', 'image/svg+xml'],
      ['p.jpeg', 'image/jpeg'],
      ['app.js', 'text/javascript'],
      ['.env', 'application/octet-stream'],
      ['Makefile', 'application/octet-stream'],
    ])
      expect(pageType(path!), path).toBe(type);
  });

  it('tell workspace pages and their grants apart', () => {
    expect(isWorkspacePage('atelier-files://g1/a.html')).toBe(true);
    expect(isWorkspacePage('https://example.com/')).toBe(false);
    expect(sameGrant('atelier-files://g1/a.html', 'atelier-files://g1/b/c.html')).toBe(true);
    expect(sameGrant('atelier-files://g1/a.html', 'atelier-files://g2/a.html')).toBe(false);
    expect(sameGrant('https://g1/a.html', 'atelier-files://g1/a.html')).toBe(false);
  });
});

describe('reads asked of a window', () => {
  it('settle with what the same window sends back, and nothing from another', async () => {
    const sent: { host: number; id: number }[] = [];
    const reads = new FileReads((host, request) => {
      sent.push({ host, id: request.id });
      return true;
    });
    const read = reads.read(3, 'ws', 'a.html');
    const { id } = sent[0]!;
    reads.answer(4, id, Buffer.from('evil').toString('base64'));
    reads.answer(3, id, Buffer.from('<p>').toString('base64'));
    expect(Buffer.from((await read)!).toString()).toBe('<p>');

    const missing = reads.read(3, 'ws', 'b.html');
    reads.answer(3, sent[1]!.id, null);
    expect(await missing).toBeNull();
  });

  it('give nothing when the window is gone or doesn’t answer in time', async () => {
    expect(await new FileReads(() => false).read(1, 'ws', 'a.html')).toBeNull();
    vi.useFakeTimers();
    try {
      const read = new FileReads(() => true).read(1, 'ws', 'a.html');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await read).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
