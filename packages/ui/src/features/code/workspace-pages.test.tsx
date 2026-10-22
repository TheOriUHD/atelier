import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { BrowserPages, BrowserPane, addressUrl } from './browser-pane.tsx';
import { FilesPane } from './file-tree.tsx';
import type { PaneFrameState } from './pane-dock.tsx';
import { canServePages, opensInBrowser, pageUrl } from './workspace-pages.ts';

const bridge = vi.hoisted(() => ({
  serve: vi.fn(async (workspaceId: string) => `atelier-files://grant-${workspaceId}/`),
  setFileReader: vi.fn(),
}));
vi.mock('../../lib/platform.ts', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, desktop: { device: { id: 'this-mac' }, browser: { ...bridge, onOpen: () => () => {}, onDownloadBlocked: () => () => {}, favicon: async () => null } } };
});
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>{children}</TooltipProvider>
  </QueryClientProvider>
);
const frame = (pane: PaneFrameState['pane']): PaneFrameState => ({ pane, style: {}, hidden: false, maximized: false, canMaximize: true, others: 1, sheet: false, dispatch: () => {}, close: () => {} });
const workspace = { id: 'w1', kind: 'local' as const, name: 'repo', root: '/repo', host: null, deviceId: 'another-computer', available: true, scratch: false, lastUsedAt: 0 };

beforeEach(() =>
  resetBackend({
    'workspaces.files': () => [
      { name: 'index.html', path: 'index.html', kind: 'file', size: 30 },
      { name: 'app.ts', path: 'app.ts', kind: 'file', size: 26 },
    ],
    'workspaces.findFiles': () => ['site/index.html', 'src/app.ts'],
    'workspaces.grep': () => ({ matches: [{ path: 'site/index.html', line: 2, text: '<h1>Answer</h1>' }], truncated: false }),
    'workspaces.fileBytes': ({ path }: { path: string }) => ({ dataBase64: btoa(`<p>${path}`), mime: 'application/octet-stream', size: 10 }),
  }),
);

describe('Open in › Browser pane, in the Files pane', () => {
  const setup = (onOpenInBrowser?: (path: string) => void) =>
    render(wrap(<FilesPane frame={frame('files')} workspace={workspace} files={{ paths: [], active: null }} onFiles={() => {}} onOpenInBrowser={onOpenInBrowser} />));
  // The folder is on another computer, so Open in holds only the Browser pane.
  const openInBrowser = async () => {
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Browser pane' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  };

  it('is offered for a page in the tree, not for code, and opens the file', async () => {
    const open = vi.fn();
    setup(open);
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'app.ts' }));
    const menu = await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Open in' })).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.contextMenu(screen.getByRole('button', { name: 'index.html' }));
    await openInBrowser();
    expect(open).toHaveBeenCalledWith('index.html');
  });

  it('is offered in what a search finds, by name and by contents', async () => {
    const open = vi.fn();
    setup(open);
    const filter = screen.getByRole('textbox', { name: 'Filter files' });
    fireEvent.change(filter, { target: { value: 'i' } });
    const found = await screen.findByRole('list', { name: 'Matching files' });
    fireEvent.contextMenu(within(found).getByRole('button', { name: /index\.html/ }));
    await openInBrowser();
    expect(open).toHaveBeenLastCalledWith('site/index.html');

    fireEvent.change(filter, { target: { value: '?Answer' } });
    const results = await screen.findByRole('region', { name: 'site/index.html' });
    fireEvent.contextMenu(within(results).getByText('site/index.html'));
    await openInBrowser();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('is not offered where there is no Browser pane', async () => {
    setup();
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'index.html' }));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Open in' })).toBeNull();
  });

  it('covers HTML, SVG and images', () => {
    for (const path of ['a.html', 'docs/b.HTM', 'logo.svg', 'p.png', 'p.jpg', 'p.jpeg', 'p.gif', 'p.webp']) expect(opensInBrowser(path), path).toBe(true);
    for (const path of ['app.ts', 'README.md', 'notes.txt', 'report.pdf', 'html']) expect(opensInBrowser(path), path).toBe(false);
  });
});

describe('a workspace file’s address', () => {
  it('is its path under the origin the desktop app serves the workspace at, and the window reads what pages load', async () => {
    expect(canServePages()).toBe(true);
    expect(await pageUrl('w1', 'site/My Page.html')).toBe('atelier-files://grant-w1/site/My%20Page.html');
    expect(bridge.serve).toHaveBeenCalledWith('w1');
    const reader = bridge.setFileReader.mock.calls[0]![0] as (r: { workspaceId: string; path: string }) => Promise<string | null>;
    expect(atob((await reader({ workspaceId: 'w1', path: 'site/style.css' }))!)).toBe('<p>site/style.css');
    expect(callsTo('workspaces.fileBytes')).toEqual([{ workspaceId: 'w1', path: 'site/style.css' }]);
    // One reader per window, however many files open.
    await pageUrl('w1', 'other.html');
    expect(bridge.setFileReader).toHaveBeenCalledOnce();
  });

  it('opens in the Browser pane: asked before it opened, in its empty tab; later, in a new one', async () => {
    const url = 'atelier-files://grant-w1/site/index.html';
    const pages = new BrowserPages();
    pages.push(url);
    const { container } = render(wrap(<BrowserPane frame={frame('browser')} pages={pages} />));
    const shown = () => [...container.querySelectorAll('webview')].map((v) => v.getAttribute('src'));
    await waitFor(() => expect(shown()).toEqual([url]));
    expect((screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement).value).toBe(url);
    act(() => pages.push(`${url}?again`));
    expect(shown()).toEqual([url, `${url}?again`]);
    expect(pages.take()).toEqual([]);
  });

  it('can be typed back into the address field', () => {
    expect(addressUrl('atelier-files://grant-w1/site/index.html')).toBe('atelier-files://grant-w1/site/index.html');
    expect(addressUrl('atelier-files://')).toBeNull();
  });
});
