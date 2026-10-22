import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, SecretSummary } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { SecretsPage, usedByLabels } from './secrets-page.tsx';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const DAY = 86_400_000;
const secret = (id: string, label: string, extra: Partial<SecretSummary> = {}): SecretSummary => ({
  id,
  label,
  kind: 'api_key',
  masked: '••••9f3a',
  usedBy: [],
  createdAt: Date.now() - 3 * DAY,
  rotatedAt: null,
  lastUsedAt: null,
  ...extra,
});
const anthropic: ProviderConfig = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '${secret:anthropic}', headers: {}, enabled: true };

/** Secrets as the backend keeps them; setting one again rotates it. */
function secretsBackend(initial: SecretSummary[]) {
  let secrets = initial;
  return {
    'settings.get': () => snapshot({ providers: [anthropic] }),
    'secrets.list': () => secrets,
    'secrets.set': ({ id, label, kind }: Pick<SecretSummary, 'id' | 'label' | 'kind'>) => {
      const existing = secrets.find((s) => s.id === id);
      const next = existing ? { ...existing, rotatedAt: Date.now() } : secret(id, label, { kind, createdAt: Date.now() });
      secrets = [...secrets.filter((s) => s.id !== id), next];
      return next;
    },
    'secrets.delete': ({ id }: { id: string }) => {
      secrets = secrets.filter((s) => s.id !== id);
      return { ok: true };
    },
  };
}

beforeEach(() =>
  resetBackend(
    secretsBackend([
      secret('mcp-github', 'Personal access token for github', { kind: 'token', usedBy: ['mcpServers.github.headers.Authorization'], lastUsedAt: Date.now() - 60_000 }),
      secret('anthropic', 'Anthropic API key', { usedBy: ['providers.anthropic'], rotatedAt: Date.now() - DAY }),
      secret('old-key', 'Old key'),
    ]),
  ),
);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SecretsPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function row(label: string) {
  const table = await screen.findByRole('table', { name: 'Keys and secrets' });
  return within((await within(table).findByText(label)).closest('tr')!);
}

describe('Keys & secrets page', () => {
  it('names what uses each secret', () => {
    expect(usedByLabels(['mcpServers.github.headers.Authorization', 'mcpServers.github.url'], [])).toEqual(['Connector github']);
    expect(usedByLabels([`providers.${anthropic.id}`], [anthropic, { ...anthropic, id: 'other', name: 'Other', apiKey: '${secret:other}' }])).toEqual(['Provider Anthropic']);
    expect(usedByLabels(['capabilities.webSearch.apiKey'], [])).toEqual(['Web search']);
    expect(usedByLabels(['hooks.custom'], [])).toEqual(['hooks.custom']);
  });

  it('lists masked values with their uses and dates', async () => {
    renderPage();
    const gh = await row('Personal access token for github');
    expect(gh.getAllByRole('cell').map((c) => c.textContent)).toEqual(['Personal access token for githubToken', '••••9f3a', 'Connector github', '3 days ago', '1 minute ago', '—', '']);
    expect((await row('Anthropic API key')).getByRole('list', { name: 'Uses of Anthropic API key' }).textContent).toBe('Provider Anthropic');
    const unused = await row('Old key');
    expect(unused.getByText('Not used')).toBeTruthy();
    expect(unused.getByText('Never')).toBeTruthy();
  });

  it('refuses to delete a secret that is in use, and deletes an unused one after confirming', async () => {
    renderPage();
    const used = (await row('Anthropic API key')).getByRole('button', { name: 'Delete Anthropic API key' });
    expect(used.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(used);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click((await row('Old key')).getByRole('button', { name: 'Delete Old key' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete Old key?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Old key')).toBeNull());
    expect(callsTo('secrets.delete')).toEqual([{ id: 'old-key' }]);
  });

  it('rotates a secret under the same id; the value never comes back', async () => {
    renderPage();
    fireEvent.click((await row('Anthropic API key')).getByRole('button', { name: 'Rotate Anthropic API key' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Rotate Anthropic API key' }));
    const field = dialog.getByLabelText('New value');
    expect(field.getAttribute('type')).toBe('password');
    fireEvent.change(field, { target: { value: ' sk-ant-test-123 ' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText('Rotated Anthropic API key')).toBeTruthy();
    expect(callsTo('secrets.set')).toEqual([{ id: 'anthropic', label: 'Anthropic API key', kind: 'api_key', value: 'sk-ant-test-123' }]);
    expect(screen.queryByText(/sk-ant-test-123/)).toBeNull();
  });

  it('adds a secret with an id made from its label', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add secret' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add secret' }));
    fireEvent.change(dialog.getByLabelText('Label'), { target: { value: 'Old key' } });
    // Taken already, so it gets a suffix.
    expect(dialog.getByText('Refer to it in settings as ${secret:old-key-2}.')).toBeTruthy();
    fireEvent.change(dialog.getByLabelText('Value'), { target: { value: 'test-token-123' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Add secret' }));

    expect(await within(await screen.findByRole('table', { name: 'Keys and secrets' })).findAllByText('Old key')).toHaveLength(2);
    expect(callsTo('secrets.set')).toEqual([{ id: 'old-key-2', label: 'Old key', kind: 'api_key', value: 'test-token-123' }]);
  });
});
