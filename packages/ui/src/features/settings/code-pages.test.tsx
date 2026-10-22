import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs, type SettingsPath, type UserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { setPath } from '../../lib/json-path.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { AdminCodePage } from './admin-code-page.tsx';
import { CodePage } from './code-page.tsx';
import { backend, callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

/** Preferences as the backend keeps them: each write answers with the whole document. */
function prefsBackend(initial: UserPrefs) {
  let prefs = initial;
  return {
    'prefs.get': () => prefs,
    'prefs.set': ({ path, value }: { path: SettingsPath; value: unknown }) => (prefs = setPath(prefs, path, value)),
  };
}

/** Like the overlay, renders the page once preferences and system settings are loaded. */
async function renderPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await client.prefetchQuery({ queryKey: keys.prefs, queryFn: () => rpc().call('prefs.get', {}) });
  if (backend.handlers['settings.get']) await client.prefetchQuery({ queryKey: keys.settings, queryFn: () => rpc().call('settings.get', {}) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{page}</TooltipProvider>
    </QueryClientProvider>,
  );
}

function row(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return within(el);
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

function addEntry(rowId: string, field: string, value: string) {
  fireEvent.change(row(rowId).getByRole('textbox', { name: field }), { target: { value } });
  fireEvent.click(row(rowId).getByRole('button', { name: 'Add' }));
}

describe('Code page', () => {
  beforeEach(() => {
    const prefs = defaultUserPrefs();
    resetBackend(prefsBackend({ ...prefs, permissions: { allow: ['Bash(npm test *)', 'mcp__github__get_issue'] } }));
  });

  it('lists the always-allowed rules and removes one', async () => {
    await renderPage(<CodePage />);
    const rules = await screen.findByRole('list', { name: 'Always-allowed actions' });
    expect(within(rules).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Bash(npm test *)', 'mcp__github__get_issue']);

    fireEvent.click(within(rules).getByRole('button', { name: 'Remove Bash(npm test *)' }));

    await waitFor(() => expect(within(rules).getAllByRole('listitem')).toHaveLength(1));
    expect(callsTo('prefs.set')).toEqual([{ path: ['permissions', 'allow'], value: ['mcp__github__get_issue'] }]);
  });

  it('adds a rule only once it is valid and new', async () => {
    await renderPage(<CodePage />);
    const id = 'prefs.permissions.allow';
    const field = 'New always-allowed rule';
    await screen.findByRole('list', { name: 'Always-allowed actions' });

    for (const [rule, message] of [
      ['Bash(npm test', 'Write a rule as Tool or Tool(specifier), like Bash(npm test *).'],
      ['bash(ls)', 'Tool names start with a capital letter, like Bash, Read or WebFetch.'],
      ['WebFetch(example.com)', 'WebFetch rules name a domain, like WebFetch(domain:example.com).'],
      ['Bash(npm test *)', 'That is in the list already.'],
    ]) {
      addEntry(id, field, rule!);
      expect(row(id).getByRole('alert').textContent).toBe(message);
    }
    expect(callsTo('prefs.set')).toEqual([]);

    addEntry(id, field, '  Read(./src/**)  ');

    await waitFor(() => expect(row(id).getAllByRole('listitem')).toHaveLength(3));
    expect(callsTo('prefs.set')).toEqual([{ path: ['permissions', 'allow'], value: ['Bash(npm test *)', 'mcp__github__get_issue', 'Read(./src/**)'] }]);
    expect((row(id).getByRole('textbox', { name: field }) as HTMLInputElement).value).toBe('');
    expect(row(id).queryByRole('alert')).toBeNull();
  });

  it('picks syntax themes of the matching kind and previews each in its own theme', async () => {
    await renderPage(<CodePage />);
    const light = await screen.findByRole('combobox', { name: 'Light theme' });
    expect(light.textContent).toContain('Atelier Light');
    expect(screen.getByRole('combobox', { name: 'Dark theme' }).textContent).toContain('Atelier Dark');
    expect(screen.getByRole('figure', { name: 'Light theme preview' }).textContent).toContain('function greet(name: string) {');

    fireEvent.click(light);
    expect(screen.queryByRole('option', { name: 'Dracula Theme' })).toBeNull();
    pick(await screen.findByRole('option', { name: 'GitHub Light' }));

    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['code', 'syntaxTheme', 'light'], value: 'github-light' }]));
    // The preview loads the theme and takes its background.
    await waitFor(() => expect(screen.getByRole('figure', { name: 'Light theme preview' }).style.backgroundColor).toMatch(/^(#fff|rgb\(255, 255, 255\))$/));
  });

  it('writes the code font and the interface font to the person’s preferences', async () => {
    await renderPage(<CodePage />);
    const font = await screen.findByRole('textbox', { name: 'Code font' });
    expect(font.getAttribute('placeholder')).toBe('JetBrains Mono');

    fireEvent.focus(font);
    fireEvent.change(font, { target: { value: 'Fira Code' } });
    fireEvent.blur(font);
    fireEvent.click(screen.getByRole('radio', { name: 'OpenDyslexic' }));

    await waitFor(() =>
      expect(callsTo('prefs.set')).toEqual([
        { path: ['code', 'font'], value: 'Fira Code' },
        { path: ['appearance', 'interfaceFont'], value: 'dyslexic' },
      ]),
    );
    expect(callsTo('settings.set')).toEqual([]);
  });

  it('writes the default transcript view to the person’s preferences', async () => {
    await renderPage(<CodePage />);
    const views = await screen.findByRole('radiogroup', { name: 'Default transcript view' });
    expect(within(views).getByRole('radio', { name: 'Normal' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(views).getByRole('radio', { name: 'Verbose' }));
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['code', 'transcriptView'], value: 'verbose' }]));
  });

  it('writes the commit author to the person’s preferences', async () => {
    await renderPage(<CodePage />);
    for (const [name, value] of [['Commit author name', 'Ada Lovelace'], ['Commit author email', 'ada@example.com']] as const) {
      const field = await screen.findByRole('textbox', { name });
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value } });
      fireEvent.blur(field);
    }
    await waitFor(() =>
      expect(callsTo('prefs.set')).toEqual([
        { path: ['git', 'authorName'], value: 'Ada Lovelace' },
        { path: ['git', 'authorEmail'], value: 'ada@example.com' },
      ]),
    );
  });
});

describe('Admin › Code page', () => {
  let agentsMd: string;

  beforeEach(() => {
    agentsMd = '# Team\n';
    resetBackend({
      'settings.get': () => snapshot({ permissions: { defaultMode: 'default', allow: [], ask: [], deny: ['Read(./.env)'], additionalDirectories: [] } }),
      'settings.set': () => ({ ok: true }),
      'instructions.get': () => ({ content: agentsMd }),
      'instructions.set': ({ content }: { content: string }) => {
        agentsMd = content;
        return { ok: true };
      },
    });
  });

  it('edits the system rule lists, checking each entry first', async () => {
    await renderPage(<AdminCodePage />);
    const deny = await screen.findByRole('list', { name: 'Deny rules' });
    expect(within(deny).getByText('Read(./.env)')).toBeTruthy();

    addEntry('permissions.deny', 'New deny rule', 'Bash(rm -rf *)');
    await waitFor(() => expect(within(deny).getAllByRole('listitem')).toHaveLength(2));
    addEntry('permissions.additionalDirectories', 'New directory', 'shared/docs');
    expect(row('permissions.additionalDirectories').getByRole('alert').textContent).toBe('Use an absolute path, like /srv/shared or C:\\Shared.');
    addEntry('permissions.additionalDirectories', 'New directory', '/srv/shared');
    fireEvent.click(within(deny).getByRole('button', { name: 'Remove Read(./.env)' }));

    await waitFor(() => expect(callsTo('settings.set')).toHaveLength(3));
    expect(callsTo('settings.set')).toEqual([
      { layer: 'global', path: ['permissions', 'deny'], value: ['Read(./.env)', 'Bash(rm -rf *)'] },
      { layer: 'global', path: ['permissions', 'additionalDirectories'], value: ['/srv/shared'] },
      { layer: 'global', path: ['permissions', 'deny'], value: ['Bash(rm -rf *)'] },
    ]);
  });

  it('sets the default mode, Ultracode and the Claude Code compatibility', async () => {
    await renderPage(<AdminCodePage />);
    fireEvent.click(await screen.findByRole('combobox', { name: 'Default permission mode' }));
    pick(await screen.findByRole('option', { name: 'Accept edits' }));
    const ultracode = screen.getByRole('switch', { name: 'Ultracode' });
    expect(ultracode.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(ultracode);
    fireEvent.click(screen.getByRole('switch', { name: 'Claude Code compatibility' }));

    await waitFor(() => expect(callsTo('settings.set')).toHaveLength(3));
    expect(callsTo('settings.set')).toEqual([
      { layer: 'global', path: ['permissions', 'defaultMode'], value: 'acceptEdits' },
      { layer: 'global', path: ['ultracode', 'enabled'], value: false },
      { layer: 'global', path: ['compat', 'claudeCode'], value: false },
    ]);
  });

  it('saves the system AGENTS.md explicitly, within the limit', async () => {
    await renderPage(<AdminCodePage />);
    const editor = (await screen.findByRole('textbox', { name: 'System AGENTS.md' })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe('# Team\n'));
    const save = row('instructions.system').getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('7 / 60,000 characters')).toBeTruthy();

    fireEvent.change(editor, { target: { value: 'x'.repeat(60_001) } });
    expect(screen.getByText('60,001 / 60,000 characters · Unsaved changes').className).toContain('text-danger-text');
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.change(editor, { target: { value: '# Team\n\nUse pnpm.\n' } });
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
    fireEvent.click(save);

    await waitFor(() => expect(callsTo('instructions.set')).toEqual([{ content: '# Team\n\nUse pnpm.\n' }]));
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(true));
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(editor.value).toBe('# Team\n\nUse pnpm.\n');

    fireEvent.change(editor, { target: { value: 'Never mind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(editor.value).toBe('# Team\n\nUse pnpm.\n');
  });

  it('saves system hooks once they parse, and names the ones Atelier won’t run', async () => {
    await renderPage(<AdminCodePage />);
    const editor = await screen.findByRole('textbox', { name: 'Hooks' });
    const save = row('hooks').getByRole('button', { name: 'Save' });
    fireEvent.change(editor, { target: { value: '{ "PreToolUse": [' } });
    expect(row('hooks').getByRole('alert').textContent).toBe('This isn’t valid JSON.');
    expect(save.hasAttribute('disabled')).toBe(true);

    const hooks = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }, { type: 'prompt', prompt: 'Is this safe?' }] }],
      Notification: [{ hooks: [{ type: 'command', command: 'notify' }] }],
    };
    fireEvent.change(editor, { target: { value: JSON.stringify(hooks) } });
    expect(row('hooks').getByText('“prompt” hooks under PreToolUse don’t run in Atelier; only “command” hooks do.')).toBeTruthy();
    expect(row('hooks').getByText('Notification hooks don’t run in Atelier.')).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['hooks'], value: hooks }]));
  });

  it('keeps checkpoints for a whole number of days', async () => {
    await renderPage(<AdminCodePage />);
    const field = await screen.findByRole('textbox', { name: 'Keep checkpoints for' });
    expect((field as HTMLInputElement).value).toBe('30');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '0' } });
    await waitFor(() => expect(row('checkpoints.retentionDays').getByRole('alert').textContent).toBe('Enter whole days, 1 to 3650.'));
    fireEvent.change(field, { target: { value: '14' } });
    fireEvent.blur(field);
    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['checkpoints', 'retentionDays'], value: 14 }]));
  });
});

