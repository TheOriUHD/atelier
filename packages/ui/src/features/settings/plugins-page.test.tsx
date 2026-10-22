import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type PluginSummary } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { PluginsPage } from './plugins-page.tsx';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const reviewKit: PluginSummary = {
  id: 'review-kit@acme-tools',
  name: 'review-kit',
  description: 'Reviews pull requests.',
  version: '1.2.0',
  source: 'atelier',
  enabled: true,
  skills: ['review-kit:lint', 'review-kit:style'],
  commands: ['review-kit:ship'],
  agents: [],
};
const notes: PluginSummary = {
  id: 'notes@claude-plugins',
  name: 'notes',
  description: 'Hooks that keep notes.',
  version: '0.3.0',
  source: 'claude-code',
  enabled: false,
  skills: [],
  commands: [],
  agents: [],
};

/** Plugins as the backend keeps them: switching one writes `enabledPlugins`, uninstalling removes it. */
function pluginsBackend(initial: PluginSummary[]) {
  let plugins = initial;
  return {
    'settings.get': () => snapshot(),
    'plugins.list': () => plugins,
    'plugins.setEnabled': ({ id, enabled }: { id: string; enabled: boolean }) => {
      plugins = plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
      return { ok: true };
    },
    'plugins.uninstall': ({ id }: { id: string }) => {
      plugins = plugins.filter((p) => p.id !== id);
      return { ok: true };
    },
  };
}

beforeEach(() => resetBackend(pluginsBackend([reviewKit, notes])));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PluginsPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function pluginRow(name: string) {
  const list = await screen.findByRole('list', { name: 'Installed plugins' });
  const label = await within(list).findByText(name);
  return within(label.closest('li')!);
}

describe('Plugins page', () => {
  it('shows what each plugin brings; Claude Code’s can only be switched', async () => {
    renderPage();
    const kit = await pluginRow('review-kit');
    expect(kit.getByText('1.2.0 · Reviews pull requests.')).toBeTruthy();
    const brings = kit.getByRole('button', { name: '2 skills · 1 command' });
    expect(brings.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(brings);
    expect(within(kit.getByRole('list', { name: 'Skills in review-kit' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'review-kit:lint',
      'review-kit:style',
    ]);
    expect(kit.getByRole('list', { name: 'Commands in review-kit' }).textContent).toBe('review-kit:ship');
    expect(kit.queryByRole('list', { name: 'Agents in review-kit' })).toBeNull();
    expect(kit.getByRole('button', { name: 'Uninstall review-kit' })).toBeTruthy();

    const claude = await pluginRow('notes');
    expect(claude.getByText('Claude Code')).toBeTruthy();
    expect(claude.getByText('No skills, commands or agents')).toBeTruthy();
    expect(claude.getByRole('switch', { name: 'Enable notes' }).getAttribute('aria-checked')).toBe('false');
    expect(claude.queryByRole('button', { name: 'Uninstall notes' })).toBeNull();
  });

  it('switches plugins on and off, and shows a refused switch as it was', async () => {
    renderPage();
    fireEvent.click((await pluginRow('notes')).getByRole('switch', { name: 'Enable notes' }));
    await waitFor(async () => expect((await pluginRow('notes')).getByRole('switch').getAttribute('aria-checked')).toBe('true'));
    expect(callsTo('plugins.setEnabled')).toEqual([{ id: 'notes@claude-plugins', enabled: true }]);

    resetBackend({
      ...pluginsBackend([reviewKit, notes]),
      'plugins.setEnabled': () => {
        throw appError('forbidden', 'Only admins can do that.');
      },
    });
    fireEvent.click((await pluginRow('review-kit')).getByRole('switch', { name: 'Enable review-kit' }));
    expect(await screen.findByText('Only admins can do that.')).toBeTruthy();
    await waitFor(async () => expect((await pluginRow('review-kit')).getByRole('switch').getAttribute('aria-checked')).toBe('true'));
  });

  it('uninstalls an Atelier install after confirming', async () => {
    renderPage();
    fireEvent.click((await pluginRow('review-kit')).getByRole('button', { name: 'Uninstall review-kit' }));
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Uninstall review-kit?' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Uninstall' }));

    await waitFor(() => expect(screen.queryByText('review-kit')).toBeNull());
    expect(callsTo('plugins.uninstall')).toEqual([{ id: 'review-kit@acme-tools' }]);
  });

  it('browses a marketplace added before and installs from it; unsupported plugins say why', async () => {
    resetBackend({
      ...pluginsBackend([reviewKit]),
      'settings.get': () => snapshot({ extraKnownMarketplaces: { 'acme-tools': { source: { source: 'github', repo: 'acme/tools' } } } }),
      'plugins.browse': () => ({
        name: 'acme-tools',
        plugins: [
          { name: 'review-kit', description: 'Reviews pull requests.', version: '1.2.0' },
          { name: 'deploy-kit', description: 'Ships it.', version: '2.0.0' },
          { name: 'npm-kit', description: 'From npm.', version: '', unsupported: 'Plugins from “npm” sources can’t be installed yet.' },
        ],
      }),
      'plugins.install': ({ plugin }: { plugin: string }) => ({ id: `${plugin}@acme-tools` }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'acme/tools' }));

    const list = within(await screen.findByRole('list', { name: 'Plugins in acme-tools' }));
    expect(screen.getByText('3 plugins in acme-tools')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Marketplace repository' }).value).toBe('acme/tools');
    const item = (name: string) => within(list.getByText(name).closest('li')!);
    expect(item('review-kit').getByText('Installed')).toBeTruthy();
    expect(item('npm-kit').getByText('Plugins from “npm” sources can’t be installed yet.')).toBeTruthy();
    expect(item('npm-kit').getByRole('button', { name: 'Install npm-kit' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(item('deploy-kit').getByRole('button', { name: 'Install deploy-kit' }));

    expect(await screen.findByText('Installed deploy-kit.')).toBeTruthy();
    expect(callsTo('plugins.browse')).toEqual([{ repo: 'acme/tools' }]);
    expect(callsTo('plugins.install')).toEqual([{ repo: 'acme/tools', plugin: 'deploy-kit' }]);
    await waitFor(() => expect(callsTo('plugins.list')).toHaveLength(2));
  });

  it('shows why a marketplace can’t be browsed', async () => {
    resetBackend({
      ...pluginsBackend([]),
      'plugins.browse': () => {
        throw appError('install_failed', 'That repository has no valid .claude-plugin/marketplace.json.');
      },
    });
    renderPage();
    expect(await screen.findByText('No plugins yet. Add one from a marketplace below.')).toBeTruthy();
    // Nothing was installed before, so there are no marketplaces to offer.
    expect(screen.queryByText('Added before:')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Marketplace repository' }), { target: { value: ' acme/site ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));

    expect((await screen.findByRole('alert')).textContent).toBe('That repository has no valid .claude-plugin/marketplace.json.');
    expect(callsTo('plugins.browse')).toEqual([{ repo: 'acme/site' }]);
    expect(screen.queryByRole('list', { name: /^Plugins in/ })).toBeNull();
  });
});
