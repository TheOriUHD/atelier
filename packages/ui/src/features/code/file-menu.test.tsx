import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceSummary } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, model, resetBackend } from '../settings/test-backend.ts';
import { Composer, type ComposerHandle } from '../chat/composer.tsx';
import type { Attachments } from '../chat/use-attachments.ts';
import { FilesPane } from './file-tree.tsx';
import type { PaneFrameState } from './pane-dock.tsx';
import { TerminalFolders, TerminalPane } from './terminal-pane.tsx';

const files = vi.hoisted(() => ({ openIn: vi.fn(async () => true), reveal: vi.fn(async () => true) }));
vi.mock('../../lib/platform.ts', async (importOriginal) => {
  const actual = await importOriginal<object>();
  // The labels follow the system ("Show in folder" on Linux); pinned, as jsdom's user agent names the machine running the tests.
  return { ...actual, os: 'linux', isMac: false, desktop: { device: { id: 'this-mac', name: 'Mac', platform: 'darwin' }, files }, getTransport: () => ({ onReconnect: () => () => {} }) };
});
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
// A shell without a screen: jsdom can't lay out xterm.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    clear() {}
    dispose() {}
    onData = () => ({ dispose() {} });
    onResize = () => ({ dispose() {} });
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const clipboard = { writeText: vi.fn(async () => {}) };
Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
  unobserve() {}
} as unknown as typeof ResizeObserver;

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>{children}</TooltipProvider>
  </QueryClientProvider>
);
const frame = (pane: PaneFrameState['pane']): PaneFrameState => ({ pane, style: {}, hidden: false, maximized: false, canMaximize: true, others: 1, sheet: false, dispatch: () => {}, close: () => {} });
const local: WorkspaceSummary = { id: 'w1', kind: 'local', name: 'repo', root: '/repo', host: null, deviceId: null, available: true, scratch: false, lastUsedAt: 0 };
const ssh: WorkspaceSummary = { ...local, kind: 'ssh', root: '/home/ada/repo', host: 'box' };
const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };

beforeEach(() => {
  vi.clearAllMocks();
  resetBackend({
    'workspaces.files': () => [
      { name: 'src', path: 'src', kind: 'dir', size: 0 },
      { name: 'index.html', path: 'index.html', kind: 'file', size: 30 },
      { name: 'app.ts', path: 'app.ts', kind: 'file', size: 26 },
    ],
    'workspaces.findFiles': () => ['src/app.ts'],
    'terminals.open': () => ({ terminalId: 't1' }),
    'terminals.close': () => ({ ok: true }),
  });
});

function setup(workspace = local, handlers: { onAttach?: () => void; onOpenTerminal?: () => void } = {}) {
  const actions = { onOpenInBrowser: vi.fn(), onAttach: vi.fn(), onOpenTerminal: vi.fn(), ...handlers };
  render(wrap(<FilesPane frame={frame('files')} workspace={workspace} files={{ paths: [], active: null }} onFiles={() => {}} {...actions} />));
  return actions;
}

/** The menu's rows in order: items by name, separators as "—". */
const rows = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) => (el.getAttribute('role') === 'separator' ? '—' : el.textContent));

async function menuFor(name: string) {
  fireEvent.contextMenu(await screen.findByRole('button', { name }));
  return screen.findByRole('menu');
}

async function submenu(menu: HTMLElement, label: string) {
  fireEvent.click(within(menu).getByRole('menuitem', { name: label }));
  const menus = await screen.findAllByRole('menu');
  await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2));
  return screen.getAllByRole('menu').find((m) => m !== menu) ?? menus[1]!;
}

describe('the Files pane’s right-click menu', () => {
  it('on a folder: attach, copy, open in an editor, show it, and a terminal there', async () => {
    setup();
    const menu = await menuFor('src');
    expect(rows(menu)).toEqual(['Attach as context', 'Copy', '—', 'Open in', 'Show in folder', '—', 'Open in terminal']);
    expect(rows(await submenu(menu, 'Open in'))).toEqual(['Cursor', 'VS Code']);
  });

  it('on a file: no terminal, and the Browser pane only for what it can show', async () => {
    setup();
    let menu = await menuFor('app.ts');
    expect(rows(menu)).toEqual(['Attach as context', 'Copy', '—', 'Open in', 'Show in folder']);
    const editors = await submenu(menu, 'Open in');
    expect(rows(editors)).toEqual(['Cursor', 'VS Code']);
    fireEvent.click(within(editors).getByRole('menuitem', { name: 'VS Code' }));
    expect(files.openIn).toHaveBeenCalledWith('vscode', '/repo/app.ts');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    menu = await menuFor('index.html');
    expect(rows(await submenu(menu, 'Open in'))).toEqual(['Browser pane', 'Cursor', 'VS Code']);
  });

  it('copies the absolute path, the relative path and the name', async () => {
    setup();
    for (const [item, text] of [
      ['Absolute path', '/repo/src'],
      ['Relative path', 'src'],
      ['Filename', 'src'],
    ]) {
      const menu = await menuFor('src');
      fireEvent.click(within(await submenu(menu, 'Copy')).getByRole('menuitem', { name: item }));
      expect(clipboard.writeText).toHaveBeenLastCalledWith(text);
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), { target: { value: 'app' } });
    const found = await screen.findByRole('list', { name: 'Matching files' });
    fireEvent.contextMenu(within(found).getByRole('button', { name: /app\.ts/ }));
    fireEvent.click(within(await submenu(await screen.findByRole('menu'), 'Copy')).getByRole('menuitem', { name: 'Absolute path' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('/repo/src/app.ts');
  });

  it('opens editors and Finder on the absolute path', async () => {
    setup();
    fireEvent.click(within(await submenu(await menuFor('src'), 'Open in')).getByRole('menuitem', { name: 'Cursor' }));
    expect(files.openIn).toHaveBeenCalledWith('cursor', '/repo/src');
    fireEvent.click(within(await menuFor('app.ts')).getByRole('menuitem', { name: 'Show in folder' }));
    expect(files.reveal).toHaveBeenCalledWith('/repo/app.ts');
  });

  it('in a folder on another machine: copy gives its remote path, and there are no editors or Finder', async () => {
    setup(ssh);
    const menu = await menuFor('src');
    expect(rows(menu)).toEqual(['Attach as context', 'Copy', '—', 'Open in terminal']);
    fireEvent.click(within(await submenu(menu, 'Copy')).getByRole('menuitem', { name: 'Absolute path' }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith('/home/ada/repo/src');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(rows(await menuFor('app.ts'))).toEqual(['Attach as context', 'Copy']);
  });

  it('opens from the keyboard on a focused row', async () => {
    setup();
    const row = await screen.findByRole('button', { name: 'src' });
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(rows(await screen.findByRole('menu'))[0]).toBe('Attach as context');
  });

  it('opens a terminal in the folder', async () => {
    const { onOpenTerminal } = setup();
    fireEvent.click(within(await menuFor('src')).getByRole('menuitem', { name: 'Open in terminal' }));
    expect(onOpenTerminal).toHaveBeenCalledWith('src');
  });

  it('attaches a file or a folder to the message as an @ mention', async () => {
    const composer = createRef<ComposerHandle>();
    render(wrap(<Composer ref={composer} variant="reply" attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={() => {}} />));
    setup(local, { onAttach: (path: string, kind: 'file' | 'dir') => composer.current!.mention(kind === 'dir' ? `${path}/` : path) } as never);
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'look at' } });
    fireEvent.click(within(await menuFor('app.ts')).getByRole('menuitem', { name: 'Attach as context' }));
    await waitFor(() => expect(box.value).toBe('look at @app.ts '));
    fireEvent.click(within(await menuFor('src')).getByRole('menuitem', { name: 'Attach as context' }));
    await waitFor(() => expect(box.value).toBe('look at @app.ts @src/ '));
  });
});

describe('a terminal opened for a folder', () => {
  it('starts its shell there, first when the pane opens for it, then in a new tab', async () => {
    const folders = new TerminalFolders();
    folders.push('src');
    render(wrap(<TerminalPane frame={frame('terminal')} workspace={local} folders={folders} />));
    await waitFor(() => expect(callsTo('terminals.open')).toEqual([{ workspaceId: 'w1', cols: 80, rows: 24, dir: 'src' }]));
    act(() => folders.push('src/lib'));
    await waitFor(() => expect(callsTo('terminals.open')).toHaveLength(2));
    expect(callsTo('terminals.open')[1]).toEqual({ workspaceId: 'w1', cols: 80, rows: 24, dir: 'src/lib' });
    expect(screen.getAllByRole('button', { name: /^Terminal \d$/ }).map((b) => b.textContent)).toEqual(['Terminal 1', 'Terminal 2']);
  });

  it('without a folder starts in the workspace root', async () => {
    render(wrap(<TerminalPane frame={frame('terminal')} workspace={local} folders={new TerminalFolders()} />));
    await waitFor(() => expect(callsTo('terminals.open')).toEqual([{ workspaceId: 'w1', cols: 80, rows: 24 }]));
  });
});
