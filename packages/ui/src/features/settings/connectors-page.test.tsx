import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSchema, type McpImportEntry, type McpServerStatus, type SecretSummary, type Settings, type SettingsPath } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { getPath, setPath } from '../../lib/json-path.ts';
import { openExternal } from '../../lib/platform.ts';
import { ConnectorsPage } from './connectors-page.tsx';
import { callsTo, emit, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), openExternal: vi.fn() }));

const tools: McpServerStatus['tools'] = [
  { name: 'search_issues', description: 'Finds issues.', readOnly: true, enabled: true },
  { name: 'create_issue', description: 'Opens an issue.', readOnly: false, enabled: true },
  { name: 'delete_repo', description: 'Deletes a repository.', readOnly: false, enabled: false },
];
const github: McpServerStatus = { name: 'github', type: 'http', state: 'ready', tools, protocolEra: 'legacy' };
const notes: McpServerStatus = { name: 'notes', type: 'http', state: 'error', error: 'HTTP 401: Unauthorized', tools: [] };

/** The system settings as the backend keeps them: writes land in `raw`, reads apply the schema's defaults. */
let raw: Record<string, unknown>;
let statuses: McpServerStatus[];

function connectorsBackend(surface: 'web' | 'desktop' = 'web') {
  return {
    'app.info': () => ({ name: 'Atelier', version: '0', surface, platform: 'darwin', dataDir: '/data' }),
    'settings.get': () => ({ ...snapshot(), effective: SettingsSchema.parse(raw) }),
    'settings.set': ({ path, value }: { path: SettingsPath; value: unknown }) => {
      raw = setPath(raw, path, value);
      return { ok: true };
    },
    'settings.reset': ({ path }: { path: SettingsPath }) => {
      const parent = getPath(raw, path.slice(0, -1)) as Record<string, unknown>;
      raw = setPath(raw, path.slice(0, -1), Object.fromEntries(Object.entries(parent).filter(([k]) => k !== path.at(-1))));
      return { ok: true };
    },
    'secrets.set': ({ id, label, kind }: Pick<SecretSummary, 'id' | 'label' | 'kind'>): SecretSummary => ({ id, label, kind, masked: '••••', usedBy: [], createdAt: 0, rotatedAt: null, lastUsedAt: null }),
    'secrets.list': () => [],
    'mcp.status': () => statuses,
    'mcp.test': ({ name }: { name: string }) => ({ ...statuses.find((s) => s.name === name)!, state: 'ready' }),
    'mcp.signIn': ({ name }: { name: string }) => ({ url: `https://auth.example/authorize?for=${name}` }),
    'mcp.cancelSignIn': () => ({ ok: true }),
    'mcp.signOut': () => ({ ok: true }),
  };
}

beforeEach(() => {
  raw = {
    mcpServers: {
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${secret:mcp-github}' }, preset: 'github', disabledTools: ['delete_repo'] },
      notes: { type: 'http', url: 'https://notes.example/mcp' },
    },
    permissions: { allow: ['Bash(ls)'], deny: ['mcp__github__create_issue'] },
  };
  statuses = [github, notes];
  resetBackend(connectorsBackend());
  vi.mocked(openExternal).mockClear();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ConnectorsPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const settings = () => SettingsSchema.parse(raw) as Settings;
const table = () => screen.findByRole('table', { name: 'Connectors' });
async function row(name: string) {
  return within((await within(await table()).findByRole('button', { name })).closest('tr')!);
}
async function openConnector(name: string) {
  fireEvent.click(within(await table()).getByRole('button', { name }));
  return screen.findByRole('list', { name: `Tools of ${name}` });
}

describe('Connectors page', () => {
  it('lists connectors with their type, live state and tools; the switch turns one off', async () => {
    renderPage();
    const gh = await row('github');
    expect(gh.getAllByRole('cell').map((c) => c.textContent)).toEqual(['github', 'HTTP', 'Ready', '2 of 3', '']);
    const broken = await row('notes');
    expect(broken.getByText('Error')).toBeTruthy();
    expect(broken.getByText('HTTP 401: Unauthorized')).toBeTruthy();

    // Live updates arrive as mcp.changed.
    emit('mcp.changed', [github, { ...notes, state: 'ready', error: undefined, tools: [tools[0]] }]);
    await waitFor(() => expect(broken.getByText('Ready')).toBeTruthy());
    expect(broken.queryByText('HTTP 401: Unauthorized')).toBeNull();

    fireEvent.click(gh.getByRole('switch', { name: 'Enable github' }));
    await waitFor(() => expect(gh.getByText('Off')).toBeTruthy());
    expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['mcpServers', 'github', 'enabled'], value: false }]);
  });

  it('shows a connector’s tools, switches them and sets when they may run', async () => {
    renderPage();
    const list = within(await openConnector('github'));
    expect(screen.getByText('Issues, pull requests, code search and Actions in your repositories.')).toBeTruthy();
    expect(screen.getByText(/MCP 2025 or earlier/)).toBeTruthy();
    const tool = (name: string) => within(list.getByText(name).closest('li')!);
    expect(tool('search_issues').getByText('Read-only')).toBeTruthy();
    expect(tool('search_issues').getByText('Finds issues.')).toBeTruthy();

    // Off tools can't be given a permission.
    expect(tool('delete_repo').getByRole('switch', { name: 'Use delete_repo' }).getAttribute('aria-checked')).toBe('false');
    expect(tool('delete_repo').getByRole('radiogroup', { name: 'When delete_repo may run' }).hasAttribute('data-disabled')).toBe(true);
    fireEvent.click(tool('delete_repo').getByRole('switch', { name: 'Use delete_repo' }));
    await waitFor(() => expect(settings().mcpServers.github!.disabledTools).toEqual([]));

    // Blocked by a deny rule; "Always allow" moves the rule to the allow list.
    const policy = (name: string, label: string) => tool(name).getByRole('radio', { name: label });
    expect(policy('create_issue', 'Block').getAttribute('aria-checked')).toBe('true');
    expect(policy('search_issues', 'Ask').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(policy('create_issue', 'Always allow'));
    await waitFor(() => expect(settings().permissions).toMatchObject({ allow: ['Bash(ls)', 'mcp__github__create_issue'], deny: [] }));
    fireEvent.click(policy('create_issue', 'Ask'));
    await waitFor(() => expect(settings().permissions).toMatchObject({ allow: ['Bash(ls)'], deny: [] }));
    fireEvent.click(policy('search_issues', 'Block'));
    await waitFor(() => expect(settings().permissions.deny).toEqual(['mcp__github__search_issues']));
  });

  it('keeps the tools listed while the server reconnects after a change', async () => {
    renderPage();
    const list = await openConnector('github');
    emit('mcp.changed', [{ ...github, state: 'connecting', tools: [] }, notes]);
    await waitFor(() => expect(screen.getByText('Connecting')).toBeTruthy());
    expect(within(list).getByText('search_issues')).toBeTruthy();
  });

  it('tests the connection and shows why it failed', async () => {
    renderPage();
    fireEvent.click(within(await table()).getByRole('button', { name: 'notes' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'HTTP 401: Unauthorized');
    expect(screen.getByText('Its tools show up once it connects.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(callsTo('mcp.test')).toEqual([{ name: 'notes' }]);
  });

  it('removes a connector with its tool rules after confirming, and keeps its secret', async () => {
    renderPage();
    await openConnector('github');
    fireEvent.click(screen.getByRole('button', { name: 'github options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Remove github?' })).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Connectors' })).queryByRole('button', { name: 'github' })).toBeNull());
    expect(Object.keys(settings().mcpServers)).toEqual(['notes']);
    expect(settings().permissions).toMatchObject({ allow: ['Bash(ls)'], deny: [] });
    expect(callsTo('secrets.delete')).toEqual([]);
  });

  it('adds a preset: the token goes to the secret store and the entry refers to it', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add connector' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add connector' }));
    // stdio presets need the desktop app.
    expect(dialog.getByRole('button', { name: /^Brave Search/ }).hasAttribute('disabled')).toBe(true);
    expect(dialog.getByRole('button', { name: /^Brave Search/ }).textContent).toContain('Only in the desktop app: it runs a program on your computer.');
    fireEvent.click(dialog.getByRole('button', { name: /^Cloudflare/ }));

    const form = within(await screen.findByRole('dialog', { name: 'Add Cloudflare' }));
    expect(form.getByRole('link', { name: 'Create one' }).getAttribute('href')).toBe('https://dash.cloudflare.com/profile/api-tokens');
    fireEvent.click(form.getByRole('button', { name: 'Add connector' }));
    expect(form.getByText('Paste your API token.')).toBeTruthy();
    fireEvent.change(form.getByLabelText('API token'), { target: { value: 'test-token-123' } });
    fireEvent.click(form.getByRole('button', { name: 'Add connector' }));

    // It opens on the new connector.
    expect(await screen.findByRole('heading', { name: 'cloudflare' })).toBeTruthy();
    expect(callsTo('secrets.set')).toEqual([{ id: 'mcp-cloudflare', label: 'API token for cloudflare', kind: 'token', value: 'test-token-123' }]);
    expect(callsTo('settings.set')).toEqual([
      {
        layer: 'global',
        path: ['mcpServers', 'cloudflare'],
        value: { type: 'http', url: 'https://mcp.cloudflare.com/mcp', headers: { Authorization: 'Bearer ${secret:mcp-cloudflare}' }, preset: 'cloudflare' },
      },
    ]);
    expect(screen.queryByText('test-token-123')).toBeNull();
  });

  it('signs an OAuth connector in from its row, waits for it, and signs it out on its page', async () => {
    raw = setPath(raw, ['mcpServers', 'notion'], { type: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', preset: 'notion' });
    const notion: McpServerStatus = { name: 'notion', type: 'http', state: 'error', tools: [], signIn: 'needed' };
    statuses = [github, notes, notion];
    renderPage();
    const r = await row('notion');
    expect(r.getAllByRole('cell').map((c) => c.textContent)).toEqual(['notion', 'HTTP', 'Sign in', '—', '']);
    fireEvent.click(r.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://auth.example/authorize?for=notion'));
    expect(callsTo('mcp.signIn')).toEqual([{ name: 'notion' }]);

    emit('mcp.changed', [github, notes, { ...notion, signIn: 'waiting' }]);
    await waitFor(() => expect(r.getByText('Waiting for sign-in')).toBeTruthy());
    fireEvent.click(within(await table()).getByRole('button', { name: 'notion' }));
    expect(await screen.findByText('Waiting for you to sign in in the other tab…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(callsTo('mcp.cancelSignIn')).toEqual([{ name: 'notion' }]));

    // Back to needing a sign-in, the page offers it; a failed attempt says why.
    emit('mcp.changed', [github, notes, { ...notion, error: 'Signing in failed: The sign-in was refused or didn’t finish.' }]);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Signing in failed: The sign-in was refused or didn’t finish.');
    expect(screen.getByText('Its tools show up once it’s signed in.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(callsTo('mcp.signIn')).toHaveLength(2));

    // Signed in, it connects, and its menu signs it out again.
    emit('mcp.changed', [github, notes, { name: 'notion', type: 'http', state: 'ready', tools }]);
    expect(await screen.findByRole('list', { name: 'Tools of notion' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'notion options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Sign out of notion?' })).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(callsTo('mcp.signOut')).toEqual([{ name: 'notion' }]));
  });

  it('adds a preset by signing in: Linear may, Notion must on the web', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add connector' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add connector' })).getByRole('button', { name: /^Linear/ }));
    const linear = within(await screen.findByRole('dialog', { name: 'Add Linear' }));
    expect(linear.getByLabelText('Personal API key')).toBeTruthy();
    fireEvent.click(linear.getByRole('radio', { name: 'Sign in with Linear' }));
    expect(linear.queryByLabelText('Personal API key')).toBeNull();
    expect(linear.getByRole('button', { name: 'Add and sign in' })).toBeTruthy();
    fireEvent.click(linear.getByRole('button', { name: 'Back' }));

    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add connector' })).getByRole('button', { name: /^Notion/ }));
    const notion = within(await screen.findByRole('dialog', { name: 'Add Notion' }));
    // Its token setup runs a program, which only the desktop app does.
    expect(notion.queryByRole('radiogroup', { name: 'How to connect' })).toBeNull();
    expect(notion.queryByLabelText('Integration secret')).toBeNull();
    fireEvent.click(notion.getByRole('button', { name: 'Add and sign in' }));

    expect(await screen.findByRole('heading', { name: 'notion' })).toBeTruthy();
    expect(callsTo('secrets.set')).toEqual([]);
    expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['mcpServers', 'notion'], value: { type: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', preset: 'notion' } }]);
    expect(callsTo('mcp.signIn')).toEqual([{ name: 'notion' }]);
    expect(openExternal).toHaveBeenCalledWith('https://auth.example/authorize?for=notion');
  });

  it('adds a custom HTTP connector, keeping its credential header as a secret; stdio needs the desktop app', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add connector' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add connector' })).getByRole('button', { name: /^Custom/ }));
    const form = within(await screen.findByRole('dialog', { name: 'Add a custom connector' }));
    expect(form.getByRole('radio', { name: 'stdio' }).hasAttribute('data-disabled')).toBe(true);

    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'github' } });
    fireEvent.click(form.getByRole('button', { name: 'Add connector' }));
    expect(form.getByText('There is a connector with this name already.')).toBeTruthy();
    expect(form.getByText('Enter the server’s URL, like https://example.com/mcp.')).toBeTruthy();

    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'mock' } });
    fireEvent.change(form.getByLabelText('URL'), { target: { value: 'http://127.0.0.1:9000/mcp' } });
    fireEvent.click(form.getByRole('button', { name: 'Add header' }));
    fireEvent.change(form.getByLabelText('Header 1 name'), { target: { value: 'Authorization' } });
    fireEvent.change(form.getByLabelText('Header 1 value'), { target: { value: 'Bearer test-token-123' } });
    // A credential's name marks it to be kept as a secret, and hides what was typed.
    expect(form.getByRole('button', { name: 'Keep header 1 as a secret' }).getAttribute('aria-pressed')).toBe('true');
    expect(form.getByLabelText('Header 1 value').getAttribute('type')).toBe('password');
    fireEvent.click(form.getByRole('button', { name: 'Add header' }));
    fireEvent.change(form.getByLabelText('Header 2 name'), { target: { value: 'X-Team' } });
    fireEvent.change(form.getByLabelText('Header 2 value'), { target: { value: 'blue' } });
    fireEvent.click(form.getByRole('button', { name: 'Add connector' }));

    expect(await screen.findByRole('heading', { name: 'mock' })).toBeTruthy();
    expect(callsTo('secrets.set')).toEqual([{ id: 'mcp-mock-authorization', label: 'Authorization for mock', kind: 'token', value: 'test-token-123' }]);
    expect(settings().mcpServers.mock).toMatchObject({ type: 'http', url: 'http://127.0.0.1:9000/mcp', headers: { Authorization: 'Bearer ${secret:mcp-mock-authorization}', 'X-Team': 'blue' } });
  });

  it('edits a connector’s connection and keeps its tool settings', async () => {
    renderPage();
    await openConnector('github');
    fireEvent.click(screen.getByRole('button', { name: 'github options' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const form = within(await screen.findByRole('dialog', { name: 'Edit github' }));
    expect(form.getByLabelText('Name').hasAttribute('disabled')).toBe(true);
    // A reference stays as it is.
    expect(form.getByLabelText<HTMLInputElement>('Header 1 value').value).toBe('Bearer ${secret:mcp-github}');
    expect(form.getByRole('button', { name: 'Keep header 1 as a secret' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(form.getByLabelText('URL'), { target: { value: 'https://gh.example/mcp' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit github' })).toBeNull());
    expect(callsTo('secrets.set')).toEqual([]);
    expect(settings().mcpServers.github).toMatchObject({ url: 'https://gh.example/mcp', headers: { Authorization: 'Bearer ${secret:mcp-github}' }, preset: 'github', disabledTools: ['delete_repo'], enabled: true });
  });
});

describe('Import from Claude Code', () => {
  const entries: McpImportEntry[] = [
    {
      name: 'linear',
      config: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_api_test123' }, args: [], env: {}, enabled: true, disabledTools: [] },
      secrets: [['headers', 'Authorization']],
      source: '~/.claude.json',
    },
    { name: 'files', config: { type: 'stdio', command: 'npx', args: ['-y', 'files-mcp'], env: {}, headers: {}, enabled: true, disabledTools: [] }, secrets: [], source: '/work/site/.mcp.json' },
    { name: 'notes', config: { type: 'http', url: 'https://notes.example/mcp', args: [], env: {}, headers: {}, enabled: true, disabledTools: [] }, secrets: [], source: '~/.claude.json (/work/site)' },
  ];

  it('is only offered by the desktop app', async () => {
    renderPage();
    await table();
    expect(screen.queryByRole('button', { name: 'Import from Claude Code' })).toBeNull();
  });

  it('imports the chosen servers and moves their credentials into the secret store', async () => {
    resetBackend({ ...connectorsBackend('desktop'), 'mcp.import': () => entries });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Import from Claude Code' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Import from Claude Code' }));
    const box = (name: string) => dialog.getByRole('checkbox', { name });
    await waitFor(() => expect(box('linear').getAttribute('aria-checked')).toBe('true'));
    expect(dialog.getByText('1 credential to move to the secret store')).toBeTruthy();
    expect(dialog.getByText('From /work/site/.mcp.json')).toBeTruthy();
    expect(box('notes').hasAttribute('data-disabled')).toBe(true);
    expect(dialog.getByText('Already added')).toBeTruthy();
    fireEvent.click(box('files'));
    fireEvent.click(dialog.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import from Claude Code' })).toBeNull());
    expect(callsTo('secrets.set')).toEqual([{ id: 'mcp-linear-authorization', label: 'Authorization for linear', kind: 'token', value: 'lin_api_test123' }]);
    expect(Object.keys(settings().mcpServers)).toEqual(['github', 'notes', 'linear']);
    expect(settings().mcpServers.linear!.headers).toEqual({ Authorization: 'Bearer ${secret:mcp-linear-authorization}' });
  });
});
