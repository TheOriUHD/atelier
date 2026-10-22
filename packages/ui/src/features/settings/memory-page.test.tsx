import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type MemoryEntry, type SettingsPath, type UserPrefs } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { MEMORY_IMPORT_PROMPT } from './memory-import-prompt.ts';
import { MemoryPage } from './memory-page.tsx';
import { callsTo, model, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const opened = vi.hoisted(() => [] as string[]);
vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), openExternal: (url: string) => opened.push(url) }));

const DAY = 86_400_000;
const entry = (extra: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'section' | 'title'>): MemoryEntry => ({
  summary: '',
  details: '',
  projectId: null,
  sensitive: false,
  source: 'chat',
  sourceSessionId: null,
  createdAt: Date.now() - 10 * DAY,
  updatedAt: Date.now() - 2 * DAY,
  ...extra,
});

let entries: MemoryEntry[];
let manualEditing: boolean;

function prefsBackend(initial: UserPrefs = defaultUserPrefs()) {
  let prefs = initial;
  return {
    'prefs.get': () => prefs,
    'prefs.set': ({ path, value }: { path: SettingsPath; value: unknown }) => (prefs = setPath(prefs, path, value)),
  };
}

beforeEach(() => {
  opened.length = 0;
  sessionStorage.clear();
  entries = [
    entry({ id: 'p1', section: 'preferences', title: 'Preferences', details: '- Short answers\n- Metric units' }),
    entry({ id: 't1', section: 'topic', title: 'Beans', summary: 'Ada’s beagle, four years old', details: '- Likes the park' }),
    entry({ id: 'h1', section: 'person', title: 'Sam', summary: 'Ada’s brother' }),
    entry({ id: 'k1', section: 'project', title: 'Shot list', summary: 'What to film', projectId: 'film' }),
    entry({ id: 'k2', section: 'project', title: 'Drehorte', summary: 'Where to shoot', projectId: 'film' }),
    entry({ id: 'g1', section: 'project', title: 'Plots', summary: 'Who has which plot', projectId: 'garden' }),
  ];
  manualEditing = false;
  resetBackend({
    ...prefsBackend(),
    'settings.get': () => snapshot({ memory: { manualEditing } }),
    'projects.list': () => [
      { id: 'film', name: 'Kurzfilm Kunst', description: '', instructions: '', pinnedAt: null, createdAt: 0, updatedAt: 0, fileCount: 0, sessionCount: 0 },
      { id: 'garden', name: 'Garden club', description: '', instructions: '', pinnedAt: null, createdAt: 0, updatedAt: 0, fileCount: 0, sessionCount: 0 },
    ],
    'memory.update': (input: { id?: string; title?: string; summary?: string; details?: string }) => {
      const current = entries.find((e) => e.id === input.id)!;
      const next = { ...current, ...input, details: input.details!.split('\n').filter(Boolean).map((l) => `- ${l}`).join('\n') };
      entries = entries.map((e) => (e.id === next.id ? next : e));
      return next;
    },
    'memory.list': () => ({ entries }),
    'memory.delete': ({ id }: { id: string }) => {
      entries = entries.filter((e) => e.id !== id);
      return { ok: true };
    },
    'memory.instruct': () => ({ changes: [{ op: 'updated', id: 'p1', title: 'Preferences', section: 'preferences' }] }),
    'memory.import': () => ({ changes: [{ op: 'created', id: 'x', title: 'Profile', section: 'profile' }] }),
    'models.list': () => [model('lab', 'qwen3:8b', { displayName: 'Qwen3 8B' }), model('lab', 'big', { displayName: 'Big One' }), model('lab', 'secret', { hidden: true })],
  });
});
afterEach(() => vi.restoreAllMocks());

function renderPage(url = '/?settings=memory') {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <MemoryPage />
      </>
    ),
    validateSearch: (s: Record<string, unknown>) => ({
      ...(typeof s.settings === 'string' ? { settings: s.settings } : {}),
      ...(typeof s.memory === 'string' ? { memory: s.memory } : {}),
    }),
  });
  const routes = ['/', '/chat/$sessionId'].map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null }));
  const router = createRouter({ routeTree: rootRoute.addChildren(routes), history: createMemoryHistory({ initialEntries: [url] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { search: () => router.state.location.search as { settings?: string; memory?: string } };
}

const section = (name: string) => screen.getByRole('heading', { name }).closest('section')!;

describe('Settings › Memory', () => {
  it('lists the toggles, You with Preferences and Profile, then topics, people and projects', async () => {
    renderPage();
    await screen.findByText('Beans');
    for (const label of ['Search and reference chats', 'Generate memory from chats', 'Include sensitive topics in memory', 'Import memory from other AI providers']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('Let Atelier remember details about sensitive topics like health or religious beliefs.')).toBeTruthy();

    const you = within(section('You'));
    const prefsRow = you.getByRole('button', { name: /^Preferences/ });
    expect(prefsRow.textContent).toContain('How Ada wants Atelier to respond');
    expect(prefsRow.textContent).toContain('Updated 2 days ago');
    expect(you.getByRole('button', { name: /^Profile/ }).textContent).toContain('Who Ada is');
    expect(you.getByRole('button', { name: /^Profile/ }).textContent).toContain('Empty');

    expect(within(section('Topics')).getByRole('button', { name: /^Beans/ }).textContent).toContain('Ada’s beagle, four years old');
    expect(within(section('People')).getByRole('button', { name: /^Sam/ })).toBeTruthy();
    // Sections without entries aren't shown.
    expect(screen.queryByRole('heading', { name: 'Areas' })).toBeNull();
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Memory', 'You', 'Topics', 'People', 'Projects']);

    // Project entries sit under their project, behind a collapsible row.
    const projects = within(section('Projects'));
    await projects.findByText('Garden club');
    const groups = projects.getAllByRole('button', { expanded: false });
    expect(groups.map((g) => g.textContent)).toEqual(['Garden club1 entry', 'Kurzfilm Kunst2 entries']);
    expect(projects.queryByText('Drehorte')).toBeNull();
    fireEvent.click(groups[1]!);
    expect(groups[1]!.getAttribute('aria-expanded')).toBe('true');
    expect(projects.getByRole('button', { name: /^Drehorte/ })).toBeTruthy();
    expect(projects.getByRole('button', { name: /^Shot list/ })).toBeTruthy();
    expect(projects.queryByRole('button', { name: /^Plots/ })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Learn more' })[0]!);
    expect(opened).toEqual(['https://docs.atelierhq.dev/memory/#search-and-reference-chats']);
  });

  it('keeps the toggles as preferences, sensitive topics off by default', async () => {
    renderPage();
    const generate = await screen.findByRole('switch', { name: 'Generate memory from chats' });
    await waitFor(() => expect(generate.getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByRole('switch', { name: 'Search and reference chats' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Include sensitive topics in memory' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(generate);
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['memory', 'generate'], value: false }]));
  });

  it('imports: copy the prompt, paste the result, add to memory', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Start import' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Import memory to Atelier' }));
    expect(dialog.getByText('1. Copy this prompt into a chat with your other AI provider')).toBeTruthy();
    expect(dialog.getByLabelText('Import prompt').textContent).toBe(MEMORY_IMPORT_PROMPT);
    expect(MEMORY_IMPORT_PROMPT).toContain('[YYYY-MM-DD] - Entry');
    fireEvent.click(dialog.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MEMORY_IMPORT_PROMPT));
    expect(await dialog.findByRole('button', { name: 'Copied' })).toBeTruthy();

    const add = dialog.getByRole('button', { name: 'Add to memory' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText('2. Paste the result below to add it to Atelier’s memory'), { target: { value: '```\nIdentity\n[unknown] - Lives in Leeds\n```' } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(callsTo('memory.import')).toEqual([{ text: 'Identity\n[unknown] - Lives in Leeds' }]));
    expect(await dialog.findByText('Added 1 entry.')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import memory to Atelier' })).toBeNull());
  });

  it('imports a long export in parts, shows how far it got, then says what it added', async () => {
    const waiting: (() => void)[] = [];
    let n = 0;
    resetBackend({
      ...prefsBackend(),
      'memory.list': () => ({ entries }),
      'models.list': () => [],
      'memory.import': () =>
        new Promise((resolve) => {
          const i = n++;
          const change =
            i === 0
              ? { op: 'updated', id: 'pr', title: 'Profile', section: 'profile' }
              : i === 1
                ? { op: 'updated', id: 'pf', title: 'Preferences', section: 'preferences' }
                : { op: 'created', id: `e${i}`, title: `Entry ${i}`, section: 'topic' };
          waiting.push(() => resolve({ changes: [change] }));
        }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Start import' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Import memory to Atelier' }));
    const career = Array.from({ length: 200 }, (_, i) => `[2020-01-01] - Career fact ${i}: ${'detail '.repeat(10)}`);
    fireEvent.change(dialog.getByLabelText('2. Paste the result below to add it to Atelier’s memory'), { target: { value: ['## Career', ...career].join('\n') } });
    fireEvent.click(dialog.getByRole('button', { name: 'Add to memory' }));
    const total = Math.ceil((career.join('\n').length + 200) / 6_000);
    for (let part = 1; part <= total; part++) {
      await waitFor(() => expect(waiting).toHaveLength(part));
      const status = dialog.getByText(/^Adding \d+ of \d+…/).textContent!;
      expect(status).toMatch(new RegExp(`^Adding ${part} of ${status.match(/of (\d+)/)![1]}…`));
      expect(dialog.getByRole('progressbar', { name: 'Import progress' }).getAttribute('aria-valuenow')).toBe(String(part - 1));
      if (part === total) break;
      waiting[part - 1]!();
    }
    const sent = callsTo('memory.import') as { text: string }[];
    expect(sent.length).toBeGreaterThan(1);
    for (let i = 0; i < 200; i++) expect(sent.some((c) => c.text.includes(`Career fact ${i}:`))).toBe(true);
    expect(sent.every((c) => c.text.startsWith('## Career'))).toBe(true);
    waiting.at(-1)!();
    const done = `Added ${sent.length - 2} ${sent.length - 2 === 1 ? 'entry' : 'entries'}, updated Profile and Preferences.`;
    expect(await dialog.findByText(done)).toBeTruthy();
    expect(dialog.queryByRole('progressbar')).toBeNull();
  });

  it('sends the bottom bar to a model and says what changed', async () => {
    renderPage();
    const bar = await screen.findByRole('textbox', { name: 'Tell Atelier something to remember' });
    expect(bar.getAttribute('placeholder')).toBe('My dog’s name is Beans');
    fireEvent.change(bar, { target: { value: 'Keep answers short' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    await waitFor(() => expect(callsTo('memory.instruct')).toEqual([{ text: 'Keep answers short' }]));
    expect(await screen.findByText('Updated Preferences')).toBeTruthy();
    expect((bar as HTMLTextAreaElement).value).toBe('');
  });

  it('opens an entry: back link, details, delete with confirmation, and its own bar', async () => {
    const { search } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Beans/ }));
    await waitFor(() => expect(search().memory).toBe('t1'));
    expect(await screen.findByRole('heading', { name: 'Beans' })).toBeTruthy();
    expect(screen.getByText('Last updated')).toBeTruthy();
    expect(screen.getByText('Ada’s beagle, four years old')).toBeTruthy();
    expect(screen.getByText('Likes the park')).toBeTruthy();

    const bar = screen.getByRole('textbox', { name: 'Tell Atelier what to change in Beans' });
    expect(bar.getAttribute('placeholder')).toBe('Tell Atelier what to change');
    fireEvent.change(bar, { target: { value: 'He is five now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(callsTo('memory.instruct')).toEqual([{ text: 'He is five now', entryId: 't1' }]));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText('Delete this memory?')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(callsTo('memory.delete')).toEqual([{ id: 't1' }]));
    await waitFor(() => expect(search().memory).toBeUndefined());

    fireEvent.click(await screen.findByRole('button', { name: /^Sam/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Memory' }));
    await waitFor(() => expect(search().memory).toBeUndefined());
  });

  /** Picks `name` in the model menu opened from `trigger`. */
  const pickModel = async (trigger: HTMLElement, name: string) => {
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: new RegExp(`^${name}`) }));
    await waitFor(() => expect(trigger.textContent).toBe(name));
  };

  it('imports on the model chosen next to Add to memory, Default sending none', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Start import' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Import memory to Atelier' }));
    const trigger = dialog.getByRole('button', { name: 'Model: Default' });
    expect(trigger.textContent).toBe('Default');
    fireEvent.click(trigger);
    expect(await screen.findByRole('menuitemradio', { name: /^Default/ })).toBeTruthy();
    expect(screen.queryByRole('menuitemradio', { name: /^secret/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Big One/ }));
    expect(await dialog.findByRole('button', { name: 'Model: Big One' })).toBeTruthy();
    fireEvent.change(dialog.getByLabelText('2. Paste the result below to add it to Atelier’s memory'), { target: { value: 'Lives in Leeds' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Add to memory' }));
    await waitFor(() => expect(callsTo('memory.import')).toEqual([{ text: 'Lives in Leeds', model: 'lab/big' }]));
  });

  it('sends the model chosen in either bar, kept for the session, and none for Default', async () => {
    const { search } = renderPage();
    const bar = await screen.findByRole('textbox', { name: 'Tell Atelier something to remember' });
    await pickModel(await screen.findByRole('button', { name: 'Model: Default' }), 'Qwen3 8B');
    fireEvent.change(bar, { target: { value: 'Keep answers short' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    await waitFor(() => expect(callsTo('memory.instruct')).toEqual([{ text: 'Keep answers short', model: 'lab/qwen3:8b' }]));

    fireEvent.click(await screen.findByRole('button', { name: /^Beans/ }));
    await waitFor(() => expect(search().memory).toBe('t1'));
    const entryBar = await screen.findByRole('textbox', { name: 'Tell Atelier what to change in Beans' });
    const trigger = screen.getByRole('button', { name: 'Model: Qwen3 8B' });
    fireEvent.change(entryBar, { target: { value: 'He is five now' } });
    fireEvent.keyDown(entryBar, { key: 'Enter' });
    await waitFor(() => expect(callsTo('memory.instruct')).toHaveLength(2));
    expect(callsTo('memory.instruct')[1]).toEqual({ text: 'He is five now', entryId: 't1', model: 'lab/qwen3:8b' });

    await pickModel(trigger, 'Default');
    fireEvent.change(entryBar, { target: { value: 'He likes the beach' } });
    fireEvent.keyDown(entryBar, { key: 'Enter' });
    await waitFor(() => expect(callsTo('memory.instruct')).toHaveLength(3));
    expect(callsTo('memory.instruct')[2]).toEqual({ text: 'He likes the beach', entryId: 't1' });
  });

  it('lets an empty Profile be written from its page', async () => {
    renderPage('/?settings=memory&memory=profile');
    expect(await screen.findByRole('heading', { name: 'Profile' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    const bar = screen.getByRole('textbox', { name: 'Tell Atelier what to change in Profile' });
    fireEvent.change(bar, { target: { value: 'I live in Leeds' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    await waitFor(() => expect(callsTo('memory.instruct')).toEqual([{ text: 'I live in Leeds', section: 'profile' }]));
  });

  it('keeps the bar on the panel’s bottom edge, below a scrolling area, on the list and on an entry', async () => {
    const { search } = renderPage();
    await screen.findByText('Beans');
    const check = () => {
      const scroll = screen.getByTestId('memory-scroll');
      const bar = screen.getByTestId('memory-bar');
      expect(scroll.className).toContain('overflow-y-auto');
      expect(scroll.className).toContain('min-h-0');
      // The bar comes after the scrolling area, not inside it, so it can't cover the last row.
      expect(scroll.contains(bar)).toBe(false);
      expect(scroll.parentElement).toBe(bar.parentElement);
      expect(bar.className).toContain('shrink-0');
    };
    check();
    expect(within(screen.getByTestId('memory-scroll')).getByText('Beans')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Beans/ }));
    await waitFor(() => expect(search().memory).toBe('t1'));
    await screen.findByRole('heading', { name: 'Beans' });
    check();
    expect(within(screen.getByTestId('memory-scroll')).getByText('Likes the park')).toBeTruthy();
  });

  it('shows a project entry’s project above Last updated', async () => {
    renderPage('/?settings=memory&memory=g1');
    expect(await screen.findByRole('heading', { name: 'Plots' })).toBeTruthy();
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    expect(terms.slice(0, 2)).toEqual(['Project', 'Last updated']);
    expect(await screen.findByText('Garden club')).toBeTruthy();
  });

  it('offers Edit only while the administrator allows it', async () => {
    renderPage('/?settings=memory&memory=t1');
    expect(await screen.findByRole('heading', { name: 'Beans' })).toBeTruthy();
    await waitFor(() => expect(callsTo('settings.get')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Tell Atelier what to change in Beans' })).toBeTruthy();
  });

  it('edits an entry in place: title, summary and details one per line, Save and Cancel', async () => {
    manualEditing = true;
    entries = entries.map((e) => (e.id === 't1' ? { ...e, details: '- Likes the park\n- Four years old' } : e));
    renderPage('/?settings=memory&memory=t1');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(screen.getByRole('form', { name: 'Edit Beans' }));
    expect((form.getByLabelText('Details, one fact per line') as HTMLTextAreaElement).value).toBe('Likes the park\nFour years old');
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Beans the beagle' } });
    fireEvent.click(form.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'Beans' })).toBeTruthy();
    expect(callsTo('memory.update')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const again = within(screen.getByRole('form', { name: 'Edit Beans' }));
    expect(screen.queryByRole('textbox', { name: 'Tell Atelier what to change in Beans' })).toBeNull();
    fireEvent.change(again.getByLabelText('Title'), { target: { value: 'Beans the beagle' } });
    fireEvent.change(again.getByLabelText('Summary'), { target: { value: 'Ada’s dog' } });
    fireEvent.change(again.getByLabelText('Details, one fact per line'), { target: { value: 'Likes the park\nFive years old' } });
    fireEvent.click(again.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo('memory.update')).toEqual([{ id: 't1', title: 'Beans the beagle', summary: 'Ada’s dog', details: 'Likes the park\nFive years old' }]),
    );
    expect(await screen.findByRole('heading', { name: 'Beans the beagle' })).toBeTruthy();
    expect(screen.getByText('Five years old')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });
});
