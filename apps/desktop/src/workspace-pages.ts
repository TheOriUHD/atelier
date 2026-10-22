/**
 * Workspace files in the Code Browser pane ("Open in Browser pane" in the Files pane). Each window gets one origin per
 * workspace, `atelier-files://<random grant>/`, under which a file's URL is its path from the workspace root, so a
 * page's relative links (styles, scripts, images, other pages) resolve the way they would from disk.
 *
 * Only the pane's own session answers the scheme. A request is read by the window that asked for the origin, through
 * its connection to the backend (`workspaces.fileBytes`), so the runner's scoping applies and SSH, Codespaces and
 * server folders work like local ones. Every response carries a CSP sandbox without `allow-same-origin`: the page runs
 * in an opaque origin, as a `file:` page does in Chrome, so its scripts can embed sibling files but never read them
 * (the scheme has no CORS and no fetch), and it gets no storage or cookies.
 */
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { APP } from '@atelier/protocol';

export const PAGES_SCHEME = `${APP.scheme}-files`;

/** The scheme's registration: a standard URL (host and path, so relative links resolve), and nothing more. */
export const PAGES_PRIVILEGES = { standard: true, secure: true } as const;

/** Whether a URL is a workspace file served to the pane. */
export function isWorkspacePage(url: string): boolean {
  return url.startsWith(`${PAGES_SCHEME}://`) && URL.canParse(url);
}

/** Whether two URLs are workspace pages of the same grant (a page may only lead to files of its own workspace). */
export function sameGrant(a: string, b: string): boolean {
  return isWorkspacePage(a) && isWorkspacePage(b) && new URL(a).host === new URL(b).host;
}

/**
 * The opaque origin and what a page may do in it: scripts, forms, dialogs and links that open a tab. Navigating the
 * pane, plugins, downloads and same-origin access stay off.
 */
export const PAGE_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups';

const TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** A served file's type, by its extension; anything unknown is plain bytes (which the pane won't download). */
export function pageType(path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** The headers every served file gets. */
export function pageHeaders(path: string): Headers {
  return new Headers({
    'Content-Type': pageType(path),
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff',
    // The grant is in every URL; sites the page loads from don't learn it.
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
}

/**
 * The workspace-relative path a URL's path names: decoded, `index.html` for a folder, and null for anything that
 * tries to leave the root (`..` that survived URL parsing, encoded separators, backslashes, NUL) or is too long.
 */
export function pagePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = pathname
      .split('/')
      .map((segment) => {
        const part = decodeURIComponent(segment);
        if (part.includes('/') || part.includes('\\') || part.includes('\0') || part === '..' || part === '.') throw new Error('unsafe segment');
        return part;
      })
      .join('/');
  } catch {
    return null;
  }
  if (decoded.endsWith('/')) decoded += 'index.html';
  const path = posix.normalize(decoded).replace(/^\/+/, '');
  if (!path || path.length > 4096 || path.startsWith('..')) return null;
  return path;
}

/** A file's bytes as the window read them; null when it isn't there or can't be read. */
export type ReadFile = (host: number, workspaceId: string, path: string) => Promise<Uint8Array | null>;

interface Grant {
  host: number;
  workspaceId: string;
}

/** The grants handed out, and the scheme's answers. */
export class WorkspacePages {
  private readonly grants = new Map<string, Grant>();

  constructor(
    private readonly read: ReadFile,
    private readonly newGrant: () => string = () => randomBytes(16).toString('hex'),
  ) {}

  /** The origin for a workspace's files in a window: the same one each time, so pages keep their URLs. */
  origin(host: number, workspaceId: string): string {
    for (const [grant, g] of this.grants) if (g.host === host && g.workspaceId === workspaceId) return `${PAGES_SCHEME}://${grant}/`;
    const grant = this.newGrant();
    this.grants.set(grant, { host, workspaceId });
    return `${PAGES_SCHEME}://${grant}/`;
  }

  /** A window closed or reloaded: its origins stop answering. */
  forget(host: number): void {
    for (const [grant, g] of this.grants) if (g.host === host) this.grants.delete(grant);
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Only reading', { status: 405 });
    const url = new URL(request.url);
    const grant = this.grants.get(url.host);
    if (!grant) return new Response('Not found', { status: 404 });
    const path = pagePath(url.pathname);
    if (!path) return new Response('Bad path', { status: 400 });
    const bytes = await this.read(grant.host, grant.workspaceId, path).catch(() => null);
    if (!bytes) return new Response('Not found', { status: 404, headers: { 'Content-Security-Policy': PAGE_CSP } });
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers: pageHeaders(path) });
  }
}

/** How long a window has to answer for one file. */
const READ_TIMEOUT_MS = 30_000;

/**
 * Reads asked of windows over IPC: `send` delivers a request, `answer` settles it with what the same window sent back.
 * A window that doesn't answer in time, or answers for another, gets nothing.
 */
export class FileReads {
  private next = 1;
  private readonly pending = new Map<number, { host: number; settle(bytes: Uint8Array | null): void }>();

  constructor(private readonly send: (host: number, request: { id: number; workspaceId: string; path: string }) => boolean) {}

  readonly read: ReadFile = (host, workspaceId, path) =>
    new Promise((resolve) => {
      const id = this.next++;
      const timer = setTimeout(() => this.settle(id, null), READ_TIMEOUT_MS);
      this.pending.set(id, {
        host,
        settle: (bytes) => {
          clearTimeout(timer);
          resolve(bytes);
        },
      });
      if (!this.send(host, { id, workspaceId, path })) this.settle(id, null);
    });

  /** What a window sent back: base64 bytes, or null when it couldn't read the file. */
  answer(host: number, id: number, dataBase64: string | null): void {
    const request = this.pending.get(id);
    if (!request || request.host !== host) return;
    this.settle(id, dataBase64 === null ? null : Buffer.from(dataBase64, 'base64'));
  }

  private settle(id: number, bytes: Uint8Array | null): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.settle(bytes);
  }
}
