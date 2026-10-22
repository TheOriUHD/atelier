import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerStatus, WorkspaceSummary } from '@atelier/protocol';
import { model, resetBackend, user } from '../settings/test-backend.ts';
import { Composer, type ComposerProps } from './composer.tsx';
import type { Attachments } from './use-attachments.ts';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => navigate }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const attachments: Attachments = { items: [], quotes: [], addQuote: () => {}, removeQuote: () => {}, add: async () => {}, remove: () => {}, clear: () => {}, restore: () => {}, uploading: false, parts: () => [] };
const server = (name: string, state: McpServerStatus['state']): McpServerStatus => ({ name, type: 'http', state, tools: [] });
const folder: WorkspaceSummary = { id: 'w1', kind: 'local', name: 'site', root: '/home/ada/site', host: null, deviceId: null, available: true, scratch: false, lastUsedAt: 1 };

function renderComposer(props: Partial<ComposerProps> = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer variant="new" attachments={attachments} model={model('fake', 'm')} streaming={false} onSubmit={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

async function openPlus() {
  fireEvent.click(screen.getByRole('button', { name: 'Add files and more' }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  navigate.mockReset();
  resetBackend({
    'slash.list': () => [
      { name: 'pdf', description: 'Work with PDFs', kind: 'skill' },
      { name: 'standup', description: 'Draft my standup', kind: 'command' },
    ],
    'workspaces.list': () => [folder, { ...folder, id: 'w2', name: 'offline', available: false }],
  });
});

describe('the composer’s + menu', () => {
  it('switches a connector off for this conversation', async () => {
    const onChange = vi.fn();
    renderComposer({ connectors: { list: [server('github', 'ready'), server('notion', 'error'), server('linear', 'disabled')], off: ['notion'], onChange } });
    const menu = await openPlus();
    expect(within(menu).getByRole('menuitem', { name: /Upload or add files/ }).textContent).toMatch(/(⌘|Ctrl\+)U$/);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Connectors/ }));
    const github = await screen.findByRole('menuitemcheckbox', { name: 'github' });
    expect(github.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemcheckbox', { name: /notion/ }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('menuitemcheckbox', { name: /linear/ }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(github);
    expect(onChange).toHaveBeenCalledWith(['notion', 'github']);
  });

  it('starts a skill with /name, and sends admins to Customize › Plugins', async () => {
    renderComposer();
    const menu = await openPlus();
    fireEvent.click(await within(menu).findByRole('menuitem', { name: /Skills/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'pdf' }));
    expect(screen.queryByRole('menuitem', { name: 'standup' })).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('/pdf ');

    fireEvent.click(await within(await openPlus()).findByRole('menuitem', { name: 'Add plugins' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/customize', search: { tab: 'plugins' } });
  });

  it('shows only what works: no plugins for people who aren’t admins, no folder in a conversation that exists', async () => {
    resetBackend({ 'account.get': () => user({ role: 'user' }), 'slash.list': () => [] });
    renderComposer();
    const menu = await openPlus();
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([expect.stringMatching(/^Upload or add files/)]);
    expect(within(menu).queryByRole('separator')).toBeNull();
  });

  it('turns a new conversation into a Cowork task in a folder picked from Add folder', async () => {
    const onAddFolder = vi.fn();
    renderComposer({ onAddFolder });
    fireEvent.click(within(await openPlus()).getByRole('menuitem', { name: /Add folder/ }));
    expect(screen.queryByRole('menuitem', { name: /offline/ })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: /site/ }));
    expect(onAddFolder).toHaveBeenCalledWith('w1');
  });

  it('toggles Research, and shows it on in the box until switched off there', async () => {
    const onChange = vi.fn();
    renderComposer({ research: { on: false, onChange } });
    fireEvent.click(within(await openPlus()).getByRole('menuitemcheckbox', { name: 'Research' }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('button', { name: 'Research', pressed: true })).toBeNull();

    renderComposer({ research: { on: true, onChange } });
    fireEvent.click(screen.getByRole('button', { name: 'Research', pressed: true }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('opens the file picker with ⌘U / Ctrl+U', () => {
    renderComposer();
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.keyDown(window, { key: 'u', metaKey: true, ctrlKey: true });
    expect(click).toHaveBeenCalledOnce();
  });
});
