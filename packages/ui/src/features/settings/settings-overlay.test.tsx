import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, defaultUserPrefs, type ProviderStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { SettingsOverlay } from './settings-overlay.tsx';
import { backend, callsTo, model, resetBackend, snapshot, user } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** The desktop bridge; undefined is the browser. */
const platform = vi.hoisted(() => ({ desktop: undefined as unknown }));
vi.mock('../../lib/platform.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get desktop() {
    return platform.desktop;
  },
}));

const scrollIntoView = vi.fn();

beforeEach(() => {
  platform.desktop = undefined;
  Element.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockReset();
  resetBackend({
    'settings.get': () => snapshot(),
    'settings.set': () => ({ ok: true }),
    'settings.reset': () => ({ ok: true }),
  });
});

function renderSettings(url: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <SettingsOverlay />
      </>
    ),
    validateSearch: (s: Record<string, unknown>) => ({
      ...(typeof s.settings === 'string' ? { settings: s.settings } : {}),
      ...(typeof s.row === 'string' ? { row: s.row } : {}),
    }),
  });
  const home = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([home]), history: createMemoryHistory({ initialEntries: [url] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { client, search: () => router.state.location.search as { settings?: string; row?: string } };
}

async function openDialog() {
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  return { dialog, ui: within(dialog) };
}

function row(dialog: HTMLElement, id: string): HTMLElement {
  const el = dialog.querySelector<HTMLElement>(`[data-setting-row="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el;
}

describe('SettingsOverlay', () => {
  it('opens from ?settings and closes with Escape', async () => {
    const { search } = renderSettings('/?settings=general');
    const { dialog, ui } = await openDialog();
    expect(dialog.className).toContain('w-(--at-layout-settings-dialog-w)');
    expect(ui.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    await ui.findByText('Appearance');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(search().settings).toBeUndefined());
  });

  it('says which settings file has problems and what they are', async () => {
    resetBackend({ 'settings.get': () => ({ ...snapshot(), errors: [{ layer: 'global', message: 'permissions.defaultMode: Invalid option' }] }) });
    renderSettings('/?settings=general');
    const { ui } = await openDialog();
    expect((await ui.findByRole('alert')).textContent).toBe('The settings file has settings that don’t apply until it is fixed: permissions.defaultMode: Invalid option');
  });

  it('closes from the close button', async () => {
    const { search } = renderSettings('/?settings=general');
    const { ui } = await openDialog();
    fireEvent.click(ui.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(search().settings).toBeUndefined());
  });

  it('falls back to General for an unknown page and switches pages from the nav', async () => {
    const { search } = renderSettings('/?settings=nope');
    const { ui } = await openDialog();
    expect(ui.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(ui.getByRole('button', { name: 'Account' }));

    await ui.findByText('Profile photo');
    expect(search().settings).toBe('account');
  });

  it('filters the nav while searching and jumps to the chosen row, which scrolls into view and flashes', async () => {
    const { search } = renderSettings('/?settings=account');
    const { dialog, ui } = await openDialog();
    await ui.findByText('Profile photo');

    fireEvent.change(ui.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'composer columns' } });
    expect(ui.queryByRole('button', { name: 'Account' })).toBeNull();
    fireEvent.click(ui.getByRole('button', { name: /Transcript width/ }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const target = row(dialog, 'appearance.transcriptWidth');
    expect(scrollIntoView.mock.contexts[0]).toBe(target);
    expect(target.className).toContain('data-flash:bg-interactive-subtle');
    expect(target.className).toContain('duration-[1200ms]');
    // The row param is consumed, so choosing the same row again flashes it again.
    await waitFor(() => expect(search()).toEqual({ settings: 'general' }));
    expect((ui.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('picks results with the arrow keys and Enter, and Escape clears the search without closing', async () => {
    const { search } = renderSettings('/?settings=general');
    const { ui } = await openDialog();
    const input = ui.getByRole('searchbox');

    fireEvent.change(input, { target: { value: 'esc' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(search().settings).toBe('general');

    fireEvent.change(input, { target: { value: 'default chat model' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(search().settings).toBe('models'));
  });

  it('opens on the row named by a deep link', async () => {
    renderSettings('/?settings=general&row=appearance.motion');
    const { dialog } = await openDialog();
    await waitFor(() => expect(scrollIntoView.mock.contexts[0]).toBe(row(dialog, 'appearance.motion')));
  });
});

describe('setting rows', () => {
  it('write exactly their own preference and update before the backend answers', async () => {
    resetBackend({ 'settings.get': () => snapshot(), 'prefs.set': () => new Promise(() => {}) });
    renderSettings('/?settings=general');
    const { ui } = await openDialog();

    fireEvent.click(await ui.findByRole('radio', { name: 'Dark' }));

    await waitFor(() => expect(ui.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true'));
    expect(callsTo('prefs.set')).toEqual([{ path: ['appearance', 'theme'], value: 'dark' }]);
    expect(callsTo('settings.set')).toEqual([]);
  });

  it('show a failed write inline and reload the preferences', async () => {
    resetBackend({
      'settings.get': () => snapshot(),
      'prefs.set': () => {
        throw new Error('That value is not allowed.');
      },
    });
    renderSettings('/?settings=general');
    const { dialog, ui } = await openDialog();

    fireEvent.click(await ui.findByRole('radio', { name: 'Large' }));

    const alert = await within(row(dialog, 'appearance.textSize')).findByRole('alert');
    expect(alert.textContent).toBe('That value is not allowed.');
    await waitFor(() => expect(callsTo('prefs.get').length).toBe(2));
  });

  it('mark project-layer system values and reset them in that layer', async () => {
    resetBackend({
      'settings.get': () => snapshot({}, { 'capabilities.webFetch': 'project' }),
      'settings.reset': () => ({ ok: true }),
    });
    renderSettings('/?settings=capabilities');
    const { dialog } = await openDialog();
    await screen.findByText('Web fetch');
    const fetchRow = within(row(dialog, 'capabilities.webFetch'));

    expect(fetchRow.getByText('Project')).toBeTruthy();
    expect(within(row(dialog, 'capabilities.webSearch.enabled')).queryByText('Project')).toBeNull();
    fireEvent.click(fetchRow.getByRole('button', { name: 'Reset' }));

    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'project', path: ['capabilities', 'webFetch'] }]));
  });

  it('warn when their default model is no longer available, naming what new chats use instead', async () => {
    const prefs = { ...defaultUserPrefs(), models: { ...defaultUserPrefs().models, chat: 'ollama/gemma-4-12b:q4_0' } };
    resetBackend({
      'settings.get': () => snapshot({ models: { defaults: { chat: 'ollama/gone' }, aliases: {}, overrides: {} } }),
      'models.list': () => [model('lab', 'qwen3:8b', { displayName: 'Qwen3 8B' })],
      'prefs.get': () => prefs,
    });
    renderSettings('/?settings=general');
    const { dialog } = await openDialog();
    const general = within(row(dialog, 'prefs.models.chat'));
    expect((await general.findByRole('alert')).textContent).toBe('This model is no longer available. New chats start with the server default (Qwen3 8B) until you choose another.');
    expect(general.getByRole('combobox').textContent).toContain('ollama/gemma-4-12b:q4_0 (unavailable)');
  });

  it('pick a default model from the visible ones, or the server default named by what it comes to', async () => {
    resetBackend({
      'settings.get': () => snapshot({ models: { defaults: { chat: 'lab/qwen3:32b' }, aliases: {}, overrides: {} } }),
      'models.list': () => [model('lab', 'qwen3:8b'), model('lab', 'qwen3:32b', { displayName: 'Qwen3 32B' }), model('lab', 'secret', { hidden: true })],
      'prefs.set': () => ({ ok: true }),
      'prefs.reset': () => ({}),
    });
    renderSettings('/?settings=general');
    const { dialog } = await openDialog();
    expect(within(row(dialog, 'prefs.models.chat')).getByText('Default model')).toBeTruthy();
    const picker = within(row(dialog, 'prefs.models.chat')).getByRole('combobox');
    await waitFor(() => expect(picker.textContent).toContain('Server default (Qwen3 32B)'));
    expect(within(row(dialog, 'prefs.models.chat')).queryByRole('alert')).toBeNull();

    fireEvent.click(picker);
    expect(screen.queryByRole('option', { name: 'secret' })).toBeNull();
    const qwen = await screen.findByRole('option', { name: 'qwen3:8b' });
    fireEvent.pointerDown(qwen, { pointerType: 'mouse' });
    fireEvent.click(qwen);

    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['models', 'chat'], value: 'lab/qwen3:8b' }]));
  });
});

describe('admin pages', () => {
  const asUser = () =>
    resetBackend({ 'settings.get': () => snapshot(), 'account.get': () => user({ id: 'u-bob', username: 'bob', name: 'Bob', role: 'user' }) });

  it('are listed under Admin for admins', async () => {
    renderSettings('/?settings=general');
    const { ui } = await openDialog();
    expect(ui.getByRole('heading', { name: 'Admin' })).toBeTruthy();
    for (const page of ['Providers', 'Models', 'Capabilities', 'Connectors', 'Plugins', 'Keys & secrets', 'Users', 'Server']) expect(ui.getByRole('button', { name: page })).toBeTruthy();
    // Their own Code settings, and everyone's.
    expect(ui.getAllByRole('button', { name: 'Code' })).toHaveLength(2);
  });

  it('open Admin › Code from search, apart from the personal Code page', async () => {
    resetBackend({ 'settings.get': () => snapshot(), 'instructions.get': () => ({ content: '' }) });
    const { search } = renderSettings('/?settings=code');
    const { ui } = await openDialog();
    await ui.findByText('Always-allowed actions');

    fireEvent.change(ui.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'agents.md' } });
    fireEvent.click(ui.getByRole('button', { name: /System AGENTS\.md/ }));

    await waitFor(() => expect(search().settings).toBe('admin-code'));
    expect(await ui.findByRole('textbox', { name: 'System AGENTS.md' })).toBeTruthy();
  });

  it('jump from search to the skill installer on a page everyone has', async () => {
    resetBackend({ 'settings.get': () => snapshot(), 'workspaces.list': () => [], 'skills.list': () => [] });
    const { search } = renderSettings('/?settings=general');
    const { dialog, ui } = await openDialog();

    fireEvent.change(ui.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'github' } });
    fireEvent.click(ui.getByRole('button', { name: /Install from GitHub/ }));

    await waitFor(() => expect(scrollIntoView.mock.contexts[0]).toBe(row(dialog, 'skills.install')));
    expect(search().settings).toBe('skills');
  });

  it('are neither shown nor found nor opened for everyone else', async () => {
    asUser();
    renderSettings('/?settings=users');
    const { ui } = await openDialog();

    // A deep link to an admin page lands on General.
    expect(ui.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    expect(ui.queryByRole('heading', { name: 'Admin' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Providers' })).toBeNull();
    expect(ui.queryByRole('button', { name: 'Plugins' })).toBeNull();
    // Their own folders and the skills sessions use are theirs to see.
    for (const page of ['Privacy', 'Usage', 'Folders', 'Cloud', 'Skills']) expect(ui.getByRole('button', { name: page })).toBeTruthy();
    expect(callsTo('users.list')).toEqual([]);

    const search = ui.getByRole('searchbox', { name: 'Search settings' });
    for (const query of ['users', 'web search', 'sign-up', 'deny', 'agents.md', 'permission mode', 'marketplace', 'oauth', 'pricing']) {
      fireEvent.change(search, { target: { value: query } });
      expect(ui.getByText(`No settings match “${query}”.`)).toBeTruthy();
    }
    // Model providers are the admin's; importing memory from another assistant's is everyone's.
    fireEvent.change(search, { target: { value: 'provider' } });
    expect(within(document.getElementById('settings-search-results')!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Import memory from other AI providersMemory']);
    fireEvent.change(search, { target: { value: 'password' } });
    expect(ui.getByRole('button', { name: /^Password/ })).toBeTruthy();
  });

  it('leave everyone their own Code page, but not the system one', async () => {
    asUser();
    renderSettings('/?settings=admin-code');
    const { ui } = await openDialog();

    expect(ui.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    expect(ui.getAllByRole('button', { name: 'Code' })).toHaveLength(1);
    expect(callsTo('instructions.get')).toEqual([]);

    fireEvent.change(ui.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'rules' } });
    expect(ui.getAllByRole('button', { name: /Always-allowed actions/ })).toHaveLength(1);
    expect(ui.queryByRole('button', { name: /Deny rules/ })).toBeNull();
  });
});

describe('System page', () => {
  const desktopBridge = () => ({
    updates: {
      status: async () => ({ version: '0.2.0', channel: 'stable', automatic: true, state: { kind: 'idle' }, checkedAt: null }),
      onStatus: () => () => undefined,
    },
    system: { get: async () => ({ openAtLogin: false, dataFolder: '/Users/ada/.atelier/data' }) },
  });

  it('is one of everyone’s pages in the desktop app', async () => {
    resetBackend({ 'settings.get': () => snapshot(), 'account.get': () => user({ role: 'user' }) });
    platform.desktop = desktopBridge();
    renderSettings('/?settings=system');
    const { ui } = await openDialog();
    expect(ui.getByRole('button', { name: 'System' }).getAttribute('aria-current')).toBe('page');
    expect(await ui.findByRole('switch', { name: 'Launch at login' })).toBeTruthy();

    fireEvent.change(ui.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'launch at login' } });
    expect(ui.getByRole('button', { name: /Launch at login/ })).toBeTruthy();
  });

  it('isn’t listed, found or opened in a browser', async () => {
    renderSettings('/?settings=system');
    const { ui } = await openDialog();
    expect(ui.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    expect(ui.queryByRole('button', { name: 'System' })).toBeNull();

    const search = ui.getByRole('searchbox', { name: 'Search settings' });
    for (const query of ['launch at login', 'update channel', 'data folder']) {
      fireEvent.change(search, { target: { value: query } });
      expect(ui.getByText(`No settings match “${query}”.`)).toBeTruthy();
    }
  });
});

describe('Providers page', () => {
  const ok: ProviderStatus = { providerId: 'homelab', ok: true, latencyMs: 12, modelCount: 3, warnings: [], checkedAt: 1 };

  beforeEach(() => {
    resetBackend({
      'settings.get': () => snapshot(),
      'providers.status': () => [],
      'providers.detect': () => [],
      'secrets.list': () => [],
      'providers.test': () => ({ status: ok, models: [] }),
      'providers.save': (draft: object) => ({ ...draft }),
    });
  });

  it('adds a provider through the wizard: type, details with an auto id, test, save', async () => {
    renderSettings('/?settings=providers');
    const { ui } = await openDialog();
    fireEvent.click(await ui.findByRole('button', { name: 'Add provider' }));

    const wizard = within(await screen.findByRole('dialog', { name: 'Add provider' }));
    fireEvent.click(wizard.getByRole('button', { name: /^Ollama/ }));
    const form = within(await screen.findByRole('dialog', { name: 'Add Ollama' }));
    expect((form.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('http://localhost:11434');
    fireEvent.change(form.getByRole('textbox', { name: 'Name' }), { target: { value: 'Homelab' } });
    expect((form.getByRole('textbox', { name: 'ID' }) as HTMLInputElement).value).toBe('homelab');

    fireEvent.click(form.getByRole('button', { name: 'Test connection' }));
    await form.findByText('Connected · 3 models · 12 ms');
    fireEvent.click(form.getByRole('button', { name: 'Add provider' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Ollama' })).toBeNull());
    const draft = { id: 'homelab', type: 'ollama', name: 'Homelab', baseUrl: 'http://localhost:11434', headers: {}, enabled: true };
    expect(callsTo('providers.test')).toEqual([draft]);
    expect(callsTo('providers.save')).toEqual([draft]);
  });

  it('shows no error while adding, when the new provider arrives before the save answers', async () => {
    let answer!: (config: object) => void;
    // The backend announces the new provider (settings.changed) before the save call returns.
    backend.handlers['providers.save'] = ((draft: object) => {
      client.setQueryData(keys.settings, snapshot({ providers: [draft as never] }));
      return new Promise((resolve) => (answer = () => resolve(draft)));
    }) as never;
    const { client } = renderSettings('/?settings=providers');
    const { ui } = await openDialog();
    fireEvent.click(await ui.findByRole('button', { name: 'Add provider' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add provider' })).getByRole('button', { name: /^Ollama/ }));
    const form = within(await screen.findByRole('dialog', { name: 'Add Ollama' }));
    fireEvent.click(form.getByRole('button', { name: 'Add provider' }));

    await waitFor(() => expect(callsTo('providers.save')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(form.queryByText(/already/i)).toBeNull();
    answer({});
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Ollama' })).toBeNull());
  });

  describe('ChatGPT Plan', () => {
    const signedOut = { available: true, signedIn: false, signingIn: false };
    const base = {
      'providers.status': () => [],
      'providers.detect': () => [],
      'secrets.list': () => [],
    };
    const wizard = async () => {
      const { ui } = await openDialog();
      fireEvent.click(await ui.findByRole('button', { name: 'Add provider' }));
      return within(await screen.findByRole('dialog', { name: 'Add provider' }));
    };

    it('is not offered when a backend reports sign-in unavailable', async () => {
      resetBackend({ ...base, 'settings.get': () => snapshot(), 'chatgpt.status': () => ({ available: false, signedIn: false, signingIn: false }) });
      renderSettings('/?settings=providers');
      const choices = await wizard();
      await choices.findByRole('button', { name: /^Anthropic/ });
      expect(choices.queryByRole('button', { name: /^ChatGPT Plan/ })).toBeNull();
    });

    it('is a normal entry beside the OpenAI API, starts the browser sign-in and can be cancelled', async () => {
      let state: Record<string, unknown> = signedOut;
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      resetBackend({
        ...base,
        'settings.get': () => snapshot(),
        'chatgpt.status': () => state,
        'chatgpt.signIn': () => ((state = { ...signedOut, signingIn: true }), { url: 'https://auth.openai.com/oauth/authorize?x=1' }),
        'chatgpt.cancel': () => ((state = signedOut), { ok: true }),
      });
      renderSettings('/?settings=providers');
      const choices = await wizard();
      expect(choices.getByRole('button', { name: /^OpenAI ?GPT models through the OpenAI API/ })).toBeTruthy();
      fireEvent.click(await choices.findByRole('button', { name: /^ChatGPT Plan/ }));

      const dialog = within(await screen.findByRole('dialog', { name: 'Add ChatGPT Plan' }));
      expect(dialog.getByText(/Unofficial: it isn’t a documented API/)).toBeTruthy();
      fireEvent.click(dialog.getByRole('button', { name: 'Sign in with ChatGPT' }));
      await dialog.findByText('Finish signing in in your browser…');
      expect(open).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?x=1', '_blank', 'noopener,noreferrer');

      // Closing the dialog ends the sign-in that is still open in the browser.
      fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(callsTo('chatgpt.cancel')).toHaveLength(1));
      expect(callsTo('providers.save')).toEqual([]);
      open.mockRestore();
    });

    it('shows a server device code, opens its verification page and cancels on leaving', async () => {
      let state: Record<string, unknown> = signedOut;
      const device = { url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' };
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      resetBackend({
        ...base,
        'settings.get': () => snapshot(),
        'chatgpt.status': () => state,
        'chatgpt.signIn': () => ((state = { ...signedOut, signingIn: true, device }), device),
        'chatgpt.cancel': () => ((state = signedOut), { ok: true }),
      });
      renderSettings('/?settings=providers');
      const choices = await wizard();
      fireEvent.click(await choices.findByRole('button', { name: /^ChatGPT Plan/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Add ChatGPT Plan' }));
      expect(dialog.getByText(/Everyone who can use this provider uses your plan/)).toBeTruthy();
      fireEvent.click(dialog.getByRole('button', { name: 'Sign in with ChatGPT' }));
      expect((await dialog.findByLabelText('Your code')).textContent).toBe(device.userCode);
      expect(dialog.getByRole('button', { name: 'Copy code' })).toBeTruthy();
      expect(dialog.getByRole('link', { name: 'auth.openai.com/codex/device' }).getAttribute('href')).toBe(device.url);
      expect(open).not.toHaveBeenCalled();
      fireEvent.click(dialog.getByRole('button', { name: 'Open OpenAI' }));
      expect(open).toHaveBeenCalledWith(device.url, '_blank', 'noopener,noreferrer');
      fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(callsTo('chatgpt.cancel')).toHaveLength(1));
      expect(callsTo('providers.save')).toEqual([]);
      open.mockRestore();
    });

    it('cancels when closed before the device code request finishes', async () => {
      let resolveStart!: (value: { url: string; userCode: string }) => void;
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      resetBackend({
        ...base,
        'settings.get': () => snapshot(),
        'chatgpt.status': () => signedOut,
        'chatgpt.signIn': () => new Promise<{ url: string; userCode: string }>((resolve) => { resolveStart = resolve; }),
        'chatgpt.cancel': () => ({ ok: true }),
      });
      renderSettings('/?settings=providers');
      const choices = await wizard();
      fireEvent.click(await choices.findByRole('button', { name: /^ChatGPT Plan/ }));
      const dialog = within(await screen.findByRole('dialog', { name: 'Add ChatGPT Plan' }));
      fireEvent.click(dialog.getByRole('button', { name: 'Sign in with ChatGPT' }));
      await waitFor(() => expect(callsTo('chatgpt.signIn')).toHaveLength(1));
      fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(callsTo('chatgpt.cancel')).toHaveLength(1));
      resolveStart({ url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(open).not.toHaveBeenCalled();
      expect(callsTo('providers.save')).toEqual([]);
      open.mockRestore();
    });

    it('adds the provider and closes once the sign-in finishes', async () => {
      let state: Record<string, unknown> = { ...signedOut, signingIn: true };
      resetBackend({
        ...base,
        'settings.get': () => snapshot(),
        'chatgpt.status': () => state,
        'providers.save': (draft: Record<string, unknown>) => draft,
      });
      renderSettings('/?settings=providers');
      const choices = await wizard();
      fireEvent.click(await choices.findByRole('button', { name: /^ChatGPT Plan/ }));
      await screen.findByRole('dialog', { name: 'Add ChatGPT Plan' });

      state = { available: true, signedIn: true, signingIn: false, email: 'me@example.com', plan: 'plus' };
      await waitFor(() => expect(callsTo('providers.save')).toEqual([{ id: 'chatgpt', type: 'chatgpt', name: 'ChatGPT Plan', baseUrl: 'https://chatgpt.com/backend-api/codex', headers: {}, enabled: true }]), { timeout: 3000 });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add ChatGPT Plan' })).toBeNull());
    });

    it('lists the signed-in account and plan, is not offered again, and signs out with its removal', async () => {
      let providers: Record<string, unknown>[] = [{ id: 'chatgpt', type: 'chatgpt', name: 'ChatGPT Plan', baseUrl: 'https://chatgpt.com/backend-api/codex', headers: {}, enabled: true }];
      resetBackend({
        ...base,
        'settings.get': () => snapshot({ providers: providers as never }),
        'chatgpt.status': () => ({ available: true, signedIn: true, signingIn: false, email: 'me@example.com', plan: 'plus' }),
        'providers.remove': () => ((providers = []), { ok: true }),
      });
      renderSettings('/?settings=providers');
      const { ui } = await openDialog();
      await ui.findByText('me@example.com · Plus plan');
      expect(ui.queryByRole('menuitem', { name: 'Edit' })).toBeNull();

      fireEvent.click(ui.getByRole('button', { name: 'Add provider' }));
      const choices = within(await screen.findByRole('dialog', { name: 'Add provider' }));
      await choices.findByRole('button', { name: /^Anthropic/ });
      expect(choices.queryByRole('button', { name: /^ChatGPT Plan/ })).toBeNull();
    });
  });

  describe('GitHub Copilot', () => {
    const signedOut = { signedIn: false, signingIn: false };
    const waiting = { signedIn: false, signingIn: true, userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 900_000 };
    const base = {
      'providers.status': () => [],
      'providers.detect': () => [],
      'secrets.list': () => [],
      'chatgpt.status': () => ({ available: false, signedIn: false, signingIn: false }),
    };
    const wizard = async () => {
      const { ui } = await openDialog();
      fireEvent.click(await ui.findByRole('button', { name: 'Add provider' }));
      return within(await screen.findByRole('dialog', { name: 'Add provider' }));
    };

    it('is offered on a server too, shows the code to enter on GitHub, and can be cancelled', async () => {
      let state: Record<string, unknown> = signedOut;
      resetBackend({
        ...base,
        'settings.get': () => snapshot(),
        'copilot.status': () => state,
        'copilot.signIn': () => ((state = waiting), { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: waiting.expiresAt }),
        'copilot.cancel': () => ((state = signedOut), { ok: true }),
      });
      renderSettings('/?settings=providers');
      const choices = await wizard();
      fireEvent.click(await choices.findByRole('button', { name: /^GitHub Copilot/ }));

      const dialog = within(await screen.findByRole('dialog', { name: 'Add GitHub Copilot' }));
      fireEvent.click(dialog.getByRole('button', { name: 'Sign in with GitHub' }));
      expect((await dialog.findByLabelText('Your code')).textContent).toBe('ABCD-1234');
      expect(dialog.getByRole('link', { name: 'github.com/login/device' }).getAttribute('href')).toBe('https://github.com/login/device');
      expect(dialog.getByRole('button', { name: 'Copy code' })).toBeTruthy();
      expect(dialog.getByText('Waiting for you to enter the code on GitHub…')).toBeTruthy();

      fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(callsTo('copilot.cancel')).toHaveLength(1));
      expect(callsTo('providers.save')).toEqual([]);
    });

    it('adds the provider and closes once the code is entered', async () => {
      let state: Record<string, unknown> = waiting;
      resetBackend({ ...base, 'settings.get': () => snapshot(), 'copilot.status': () => state, 'providers.save': (draft: Record<string, unknown>) => draft });
      renderSettings('/?settings=providers');
      const choices = await wizard();
      fireEvent.click(await choices.findByRole('button', { name: /^GitHub Copilot/ }));
      await screen.findByRole('dialog', { name: 'Add GitHub Copilot' });

      state = { signedIn: true, signingIn: false, login: 'octocat' };
      await waitFor(() => expect(callsTo('providers.save')).toEqual([{ id: 'copilot', type: 'copilot', name: 'GitHub Copilot', baseUrl: 'https://api.githubcopilot.com', headers: {}, enabled: true }]), { timeout: 3000 });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add GitHub Copilot' })).toBeNull());
    });

    it('lists the signed-in account and is not offered again', async () => {
      resetBackend({
        ...base,
        'settings.get': () => snapshot({ providers: [{ id: 'copilot', type: 'copilot', name: 'GitHub Copilot', baseUrl: 'https://api.githubcopilot.com', headers: {}, enabled: true }] as never }),
        'copilot.status': () => ({ signedIn: true, signingIn: false, login: 'octocat' }),
      });
      renderSettings('/?settings=providers');
      const { ui } = await openDialog();
      await ui.findByText('Signed in as octocat');
      fireEvent.click(ui.getByRole('button', { name: 'Add provider' }));
      const choices = within(await screen.findByRole('dialog', { name: 'Add provider' }));
      await choices.findByRole('button', { name: /^Anthropic/ });
      expect(choices.queryByRole('button', { name: /^GitHub Copilot/ })).toBeNull();
    });
  });

  describe('OpenRouter and OpenCode Zen', () => {
    const draft = { id: 'openrouter', type: 'openai-compatible', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {}, enabled: true };
    const choose = async (name: RegExp, title: string) => {
      const { ui } = await openDialog();
      fireEvent.click(await ui.findByRole('button', { name: 'Add provider' }));
      fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add provider' })).getByRole('button', { name }));
      return within(await screen.findByRole('dialog', { name: title }));
    };

    it('connects OpenRouter in the browser in one click; the backend saves it with the key it got', async () => {
      let state: Record<string, unknown> = { connecting: false };
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      backend.handlers['openrouter.status'] = () => state;
      backend.handlers['openrouter.connect'] = () => ((state = { connecting: true }), { url: 'https://openrouter.ai/auth?code_challenge=x' });
      renderSettings('/?settings=providers');
      const form = await choose(/^OpenRouter/, 'Add OpenRouter');
      expect(form.getByText(/limited to 50 requests a day/)).toBeTruthy();
      expect((form.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('https://openrouter.ai/api/v1');

      fireEvent.click(form.getByRole('button', { name: 'Connect with OpenRouter' }));
      await form.findByText('Finish connecting in your browser…');
      expect(callsTo('openrouter.connect')).toEqual([draft]);
      expect(open).toHaveBeenCalledWith('https://openrouter.ai/auth?code_challenge=x', '_blank', 'noopener,noreferrer');

      state = { connecting: false, provider: { ...draft, apiKey: '${secret:provider-openrouter}' } };
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add OpenRouter' })).toBeNull(), { timeout: 3000 });
      expect(callsTo('providers.save')).toEqual([]);
      open.mockRestore();
    });

    it('shows no id error while connecting saves the provider, even after an attempt to add without a key', async () => {
      let state: Record<string, unknown> = { connecting: false };
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      backend.handlers['openrouter.status'] = () => state;
      backend.handlers['openrouter.connect'] = () => ((state = { connecting: true }), { url: 'https://openrouter.ai/auth' });
      const { client } = renderSettings('/?settings=providers');
      const form = await choose(/^OpenRouter/, 'Add OpenRouter');
      fireEvent.click(form.getByRole('button', { name: 'Add provider' }));
      await form.findByText(/needs an API key/);

      fireEvent.click(form.getByRole('button', { name: 'Connect with OpenRouter' }));
      await form.findByText('Finish connecting in your browser…');
      client.setQueryData(keys.settings, snapshot({ providers: [draft as never] }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(form.queryByText(/already/i)).toBeNull();

      state = { connecting: false, provider: { ...draft, apiKey: '${secret:provider-openrouter}' } };
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add OpenRouter' })).toBeNull(), { timeout: 3000 });
      expect(form.queryByText(/already/i)).toBeNull();
      open.mockRestore();
    });

    it('cancels connecting when the dialog closes, and shows why a connect failed', async () => {
      let state: Record<string, unknown> = { connecting: false };
      backend.handlers['openrouter.status'] = () => state;
      backend.handlers['openrouter.connect'] = () => ((state = { connecting: true }), { url: 'https://openrouter.ai/auth' });
      backend.handlers['openrouter.cancel'] = () => ((state = { connecting: false }), { ok: true });
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      renderSettings('/?settings=providers');
      const form = await choose(/^OpenRouter/, 'Add OpenRouter');
      fireEvent.click(form.getByRole('button', { name: 'Connect with OpenRouter' }));
      await form.findByText('Finish connecting in your browser…');
      state = { connecting: false, error: 'OpenRouter refused the connection (403: Invalid code or code_verifier).' };
      expect(await form.findByRole('alert', {}, { timeout: 3000 })).toHaveProperty('textContent', 'OpenRouter refused the connection (403: Invalid code or code_verifier).');

      fireEvent.click(form.getByRole('button', { name: 'Connect with OpenRouter' }));
      await form.findByText('Finish connecting in your browser…');
      fireEvent.click(form.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(callsTo('openrouter.cancel')).toHaveLength(1));
      open.mockRestore();
    });

    it('takes a pasted OpenRouter key instead, and requires one', async () => {
      backend.handlers['openrouter.status'] = () => ({ connecting: false });
      renderSettings('/?settings=providers');
      const form = await choose(/^OpenRouter/, 'Add OpenRouter');
      fireEvent.click(form.getByRole('button', { name: 'Add provider' }));
      expect(await form.findByText('OpenRouter needs an API key.')).toBeTruthy();
      fireEvent.change(document.querySelector<HTMLInputElement>('input[type=password]')!, { target: { value: 'sk-or-v1-pasted' } });
      fireEvent.click(form.getByRole('button', { name: 'Add provider' }));
      await waitFor(() => expect(callsTo('providers.save')).toEqual([{ ...draft, apiKey: 'sk-or-v1-pasted' }]));
    });

    it('adds OpenCode Zen with a Console key, saying where its free models work', async () => {
      renderSettings('/?settings=providers');
      const form = await choose(/^OpenCode Zen/, 'Add OpenCode Zen');
      expect(form.getByText(/OpenCode Console key/)).toBeTruthy();
      expect(form.getByText(/free models may only work inside OpenCode itself/)).toBeTruthy();
      fireEvent.change(document.querySelector<HTMLInputElement>('input[type=password]')!, { target: { value: 'oc-key' } });
      fireEvent.click(form.getByRole('button', { name: 'Add provider' }));
      await waitFor(() =>
        expect(callsTo('providers.save')).toEqual([
          { id: 'opencode-zen', type: 'openai-compatible', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/inference/openai/v1', headers: {}, enabled: true, apiKey: 'oc-key' },
        ]),
      );
    });
  });

  it('requires a key for hosted APIs and sends it only to the backend, masked in the form', async () => {
    renderSettings('/?settings=providers');
    const { ui } = await openDialog();
    fireEvent.click(await ui.findByRole('button', { name: 'Add provider' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add provider' })).getByRole('button', { name: /^Anthropic/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Anthropic' });
    const form = within(dialog);

    fireEvent.click(form.getByRole('button', { name: 'Add provider' }));
    expect(await form.findByText('Anthropic needs an API key.')).toBeTruthy();
    expect(callsTo('providers.save')).toEqual([]);

    const key = dialog.querySelector<HTMLInputElement>('input[type=password]')!;
    fireEvent.change(key, { target: { value: 'sk-ant-test' } });
    fireEvent.click(form.getByRole('button', { name: 'Add provider' }));

    await waitFor(() => expect(callsTo('providers.save')).toEqual([expect.objectContaining({ id: 'anthropic', apiKey: 'sk-ant-test' })]));
    expect(document.body.textContent).not.toContain('sk-ant-test');
  });

  it('lists providers with status, models and the masked key, and toggles them through settings', async () => {
    resetBackend({
      'settings.get': () =>
        snapshot({
          providers: [{ id: 'homelab', type: 'ollama', name: 'Homelab', baseUrl: 'http://lab:11434', apiKey: '${secret:provider-homelab}', headers: {}, enabled: true }],
        }),
      'settings.set': () => ({ ok: true }),
      'providers.status': () => [ok],
      'providers.detect': () => [{ type: 'llamacpp', baseUrl: 'http://localhost:8080', label: 'llama.cpp', via: 'port' }],
      'providers.refresh': () => [ok],
      'secrets.list': () => [
        { id: 'provider-homelab', label: 'Homelab API key', kind: 'api_key', masked: '••••3f9a', usedBy: [], createdAt: 0, rotatedAt: null, lastUsedAt: null },
      ],
    });
    renderSettings('/?settings=providers');
    const { dialog, ui } = await openDialog();

    expect(await ui.findByText('lab:11434 · 12 ms · 3 models · Key ••••3f9a')).toBeTruthy();
    expect(ui.getByRole('img', { name: 'Connected' })).toBeTruthy();
    expect(within(row(dialog, 'providers.detect')).getByText('Running at localhost:8080')).toBeTruthy();

    fireEvent.click(ui.getByRole('switch', { name: 'Enable Homelab' }));

    await waitFor(() => expect(callsTo('providers.refresh')).toEqual([{ id: 'homelab' }]));
    expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['providers', 0, 'enabled'], value: false }]);
  });
});

describe('Models page', () => {
  it('writes visibility and favorites as per-model overrides', async () => {
    const qwen = model('lab', 'qwen3:8b', { displayName: 'Qwen3 8B' });
    resetBackend({
      'settings.get': () => snapshot({ providers: [{ id: 'lab', type: 'ollama', name: 'Lab', baseUrl: 'http://lab:11434', headers: {}, enabled: true }] }),
      'settings.set': () => ({ ok: true }),
      'settings.reset': () => ({ ok: true }),
      'models.list': () => [qwen],
    });
    renderSettings('/?settings=models');
    const { ui } = await openDialog();

    fireEvent.click(ui.getByRole('button', { name: 'Browse catalog' }));
    fireEvent.click(await ui.findByRole('switch', { name: 'Show Qwen3 8B in the model picker' }));
    fireEvent.click(ui.getByRole('button', { name: 'Favorite Qwen3 8B' }));

    await waitFor(() => expect(callsTo('settings.set')).toHaveLength(2));
    expect(callsTo('settings.set')).toEqual([
      { layer: 'global', path: ['models', 'overrides', 'lab/qwen3:8b', 'hidden'], value: true },
      { layer: 'global', path: ['models', 'overrides', 'lab/qwen3:8b', 'favorite'], value: true },
    ]);
    expect(ui.getByRole('button', { name: 'Favorite Qwen3 8B' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('adds a model by id to a provider’s block and removes it again', async () => {
    let models = [model('router', 'glm-5.3')];
    resetBackend({
      'settings.get': () => snapshot({ providers: [{ id: 'router', type: 'openai-compatible', name: 'Router', baseUrl: 'http://router:1234/v1', headers: {}, enabled: true }] }),
      'settings.set': () => {
        models = [...models, model('router', 'glm-5.3-flash-free', { source: 'default', manual: true })];
        return { ok: true };
      },
      'settings.reset': () => {
        models = models.filter((m) => !m.manual);
        return { ok: true };
      },
      'models.list': () => models,
    });
    renderSettings('/?settings=models');
    const { ui } = await openDialog();
    await ui.findByRole('textbox', { name: 'Display name for glm-5.3' });

    fireEvent.click(ui.getByRole('button', { name: 'Add model by id' }));
    const field = ui.getByRole('textbox', { name: 'Model id to add to Router' });
    fireEvent.change(field, { target: { value: 'glm-5.3' } });
    fireEvent.click(ui.getByRole('button', { name: 'Add' }));
    expect((await ui.findByRole('alert')).textContent).toBe('glm-5.3 is in the list already.');
    expect(callsTo('settings.set')).toEqual([]);

    fireEvent.change(field, { target: { value: ' glm-5.3-flash-free ' } });
    fireEvent.click(ui.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['models', 'overrides', 'router/glm-5.3-flash-free', 'manual'], value: true }]));
    expect(await ui.findByRole('textbox', { name: 'Display name for glm-5.3-flash-free' })).toBeTruthy();
    expect(ui.queryByRole('textbox', { name: 'Model id to add to Router' })).toBeNull();

    fireEvent.click(ui.getByRole('button', { name: 'glm-5.3 options' }));
    await screen.findByRole('menuitem', { name: 'Probe tool calling' });
    expect(screen.queryByRole('menuitem', { name: 'Remove' })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Probe tool calling' })).toBeNull());

    fireEvent.click(ui.getByRole('button', { name: 'glm-5.3-flash-free options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'global', path: ['models', 'overrides', 'router/glm-5.3-flash-free'] }]));
    await waitFor(() => expect(ui.queryByRole('textbox', { name: 'Display name for glm-5.3-flash-free' })).toBeNull());
  });

  it('offers adding by id for a provider that lists no models, and Escape leaves the field only', async () => {
    resetBackend({
      'settings.get': () => snapshot({ providers: [{ id: 'router', type: 'openai-compatible', name: 'Router', baseUrl: 'http://router:1234/v1', headers: {}, enabled: true }] }),
      'models.list': () => [],
    });
    const { search } = renderSettings('/?settings=models');
    const { ui } = await openDialog();
    expect(await ui.findByRole('table', { name: 'Router' })).toBeTruthy();

    fireEvent.click(ui.getByRole('button', { name: 'Add model by id' }));
    fireEvent.keyDown(ui.getByRole('textbox', { name: 'Model id to add to Router' }), { key: 'Escape' });
    expect(ui.queryByRole('textbox', { name: 'Model id to add to Router' })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(search().settings).toBe('models');
    expect(ui.getByRole('button', { name: 'Add model by id' })).toBeTruthy();
  });

  it('names the server’s defaults for everyone and warns when one points at a model that is gone', async () => {
    resetBackend({
      'settings.get': () => snapshot({ models: { defaults: { chat: 'ollama/gemma-4-12b:q4_0', small: 'lab/hidden' }, aliases: {}, overrides: {} } }),
      'models.list': () => [model('lab', 'qwen3:8b'), model('lab', 'hidden', { hidden: true })],
    });
    renderSettings('/?settings=models');
    const { dialog } = await openDialog();
    await screen.findByText('Default model for everyone');
    expect(screen.getByText('Writes titles, summaries and memory. “Same as the chat” uses each chat’s own model.')).toBeTruthy();
    const chat = within(row(dialog, 'models.defaults.chat'));
    expect((await chat.findByRole('alert')).textContent).toBe('This model is no longer available. New chats start with the first available model until you choose another.');
    expect(chat.getByRole('combobox').textContent).toContain('ollama/gemma-4-12b:q4_0 (unavailable)');
    expect(within(row(dialog, 'models.defaults.small')).getByRole('alert').textContent).toBe(
      'This model is no longer available. Titles, summaries and memory use the chat’s model until you choose another.',
    );
  });

  it('clears the small model with “Same as the chat”', async () => {
    const qwen = model('lab', 'qwen3:8b');
    resetBackend({
      'settings.get': () => snapshot({ models: { defaults: { small: qwen.ref }, aliases: {}, overrides: {} } }),
      'settings.reset': () => ({ ok: true }),
      'models.list': () => [qwen],
    });
    renderSettings('/?settings=models');
    const { dialog } = await openDialog();
    await screen.findByText('Small model');
    const small = within(row(dialog, 'models.defaults.small'));

    fireEvent.click(small.getByRole('combobox'));
    const same = await screen.findByRole('option', { name: 'Same as the chat' });
    // Base UI only accepts mouse clicks that started on the option.
    fireEvent.pointerDown(same, { pointerType: 'mouse' });
    fireEvent.click(same);

    await waitFor(() => expect(callsTo('settings.reset')).toEqual([{ layer: 'global', path: ['models', 'defaults', 'small'] }]));
  });
});

describe('Capabilities page', () => {
  it('stores a search key in the secret store and only references it from settings', async () => {
    resetBackend({
      'settings.get': () => snapshot({ capabilities: { ...defaultSettings().capabilities, webSearch: { enabled: true, provider: 'brave' } } }),
      'settings.set': () => ({ ok: true }),
      'secrets.list': () => [],
      'secrets.set': () => ({ id: 'web-search-brave', label: 'Brave Search API key', kind: 'api_key', masked: '••••9999', usedBy: [], createdAt: 0, rotatedAt: null, lastUsedAt: null }),
    });
    renderSettings('/?settings=capabilities');
    const { dialog, ui } = await openDialog();

    fireEvent.change(await ui.findByLabelText('Search API key'), { target: { value: 'brv-secret-9999' } });
    fireEvent.click(within(dialog.querySelector<HTMLElement>('[data-setting-row="capabilities.webSearch.apiKey"]')!).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(callsTo('settings.set')).toHaveLength(1));
    expect(callsTo('secrets.set')).toEqual([{ id: 'web-search-brave', label: 'Brave Search API key', kind: 'api_key', value: 'brv-secret-9999' }]);
    expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['capabilities', 'webSearch', 'apiKey'], value: '${secret:web-search-brave}' }]);
    expect(ui.queryByDisplayValue('brv-secret-9999')).toBeNull();
  });

  it('is on without any setup, and offers a provider only while search is on', async () => {
    resetBackend({
      'settings.get': () => snapshot({ capabilities: { ...defaultSettings().capabilities, webSearch: { enabled: false, provider: 'auto' } } }),
      'settings.set': () => ({ ok: true }),
      'search.status': () => ({ mode: 'auto', engines: [] }),
    });
    renderSettings('/?settings=capabilities');
    const { dialog, ui } = await openDialog();
    const toggle = await ui.findByRole('switch', { name: 'Web search' });
    expect(dialog.querySelector('[data-setting-row="capabilities.webSearch.provider"]')).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['capabilities', 'webSearch', 'enabled'], value: true }]));
  });

  it('shows the built-in search working, with nothing to fill in, and tests it', async () => {
    resetBackend({
      'settings.get': () => snapshot(),
      'search.status': () => ({ mode: 'auto', engines: [{ id: 'duckduckgo', name: 'DuckDuckGo', state: 'ok' }, { id: 'brave', name: 'Brave', state: 'limited', retryAt: Date.now() + 90_000 }] }),
      'search.test': () => ({ engine: 'DuckDuckGo', ms: 1234, results: [{ title: 'Wikipedia', url: 'https://wikipedia.org/' }] }),
    });
    renderSettings('/?settings=capabilities');
    const { dialog, ui } = await openDialog();
    expect((await ui.findByRole('switch', { name: 'Web search' })).hasAttribute('data-checked')).toBe(true);
    expect(dialog.querySelector('[data-setting-row="capabilities.webSearch.url"]')).toBeNull();
    expect(dialog.querySelector('[data-setting-row="capabilities.webSearch.apiKey"]')).toBeNull();
    expect(await ui.findByText(/Working\. Answered by DuckDuckGo; Brave is catching its breath/)).toBeTruthy();
    fireEvent.click(ui.getByRole('button', { name: 'Test search' }));
    expect(await ui.findByText('DuckDuckGo answered in 1.2 s with 1 result.')).toBeTruthy();
  });

  it('asks for the SearXNG URL once SearXNG is chosen', async () => {
    resetBackend({
      'settings.get': () => snapshot({ capabilities: { ...defaultSettings().capabilities, webSearch: { enabled: true, provider: 'searxng' } } }),
      'search.status': () => ({ mode: 'searxng', engines: [] }),
    });
    renderSettings('/?settings=capabilities');
    const { ui } = await openDialog();
    expect(await ui.findByLabelText('SearXNG URL')).toBeTruthy();
    expect(await ui.findByText(/Atelier does not fall back to other engines/)).toBeTruthy();
  });
});
