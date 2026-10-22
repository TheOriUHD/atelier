import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type SkillSummary, type WorkspaceSummary } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { SkillsPage } from './skills-page.tsx';
import { callsTo, resetBackend, user } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const skill = (name: string, extra: Partial<SkillSummary> = {}): SkillSummary => ({
  name,
  description: `What ${name} does.`,
  scope: 'global',
  manualOnly: false,
  warnings: [],
  installed: null,
  ...extra,
});

const pdf = skill('pdf', { installed: { source: 'acme/skills', sha: '0123456789abcdef', installedAt: '2026-10-01T12:00:00.000Z' } });
const deploy = skill('deploy', { manualOnly: true, warnings: ['The name “Deploy” differs from its folder “deploy”.'] });
const lint = skill('review-kit:lint', { scope: 'plugin' });
const local = skill('house-style', { scope: 'project' });

const folder = (id: string, available = true): WorkspaceSummary => ({
  id,
  kind: 'local',
  name: id,
  root: `/work/${id}`,
  host: null,
  deviceId: null,
  available,
  scratch: false,
  lastUsedAt: 0,
});

beforeEach(() => {
  resetBackend({
    'workspaces.list': () => [],
    'skills.list': () => [lint, pdf, deploy],
  });
});

/** Like the overlay, renders the page once the account is known. */
async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await client.prefetchQuery({ queryKey: keys.account, queryFn: () => rpc().call('account.get', {}) });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SkillsPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function section(id: string) {
  const el = document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`);
  if (!el) throw new Error(`no section ${id}`);
  return within(el);
}

/** The text of each skill row: name, badges and the lines under it. */
async function rows() {
  const list = await screen.findByRole('list', { name: 'Skills' });
  return within(list).getAllByRole('listitem').map((r) => r.textContent);
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('Skills page', () => {
  it('lists global skills before plugin ones, with where Atelier installed them from', async () => {
    await renderPage();
    expect(await rows()).toEqual([
      'deployGlobalOnly by /deployWhat deploy does.The name “Deploy” differs from its folder “deploy”.',
      'pdfGlobalfrom acme/skills 0123456 · What pdf does.Oct 1, 2026',
      'review-kit:lintPluginWhat review-kit:lint does.',
    ]);
    // Only skills Atelier installed can be uninstalled here.
    expect(screen.getByRole('button', { name: 'Uninstall pdf' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Uninstall deploy' })).toBeNull();
    expect(callsTo('skills.list')).toEqual([{}]);
    // Without folders there is nothing to choose project skills from.
    expect(screen.queryByText('Project skills from')).toBeNull();
  });

  it('adds a folder’s project skills, which come first', async () => {
    resetBackend({
      'workspaces.list': () => [folder('atelier'), folder('laptop', false)],
      'skills.list': ({ workspaceId }: { workspaceId?: string }) => (workspaceId ? [lint, local, pdf] : [lint, pdf]),
    });
    await renderPage();
    const select = await screen.findByRole('combobox', { name: 'Project skills from' });
    expect(select.textContent).toContain('No folder');
    fireEvent.click(select);
    // Offline folders can't be read.
    expect(screen.queryByRole('option', { name: 'laptop' })).toBeNull();
    pick(await screen.findByRole('option', { name: 'atelier' }));

    expect(await screen.findByText('house-style')).toBeTruthy();
    expect((await rows())[0]).toBe('house-styleProjectWhat house-style does.');
    expect(callsTo('skills.list')).toEqual([{}, { workspaceId: 'atelier' }]);
  });

  it('installs from GitHub, asking before it replaces a skill installed some other way', async () => {
    let attempts = 0;
    resetBackend({
      'workspaces.list': () => [],
      'skills.list': () => [pdf],
      'skills.install': ({ replace }: { replace?: boolean }) => {
        if (attempts++ === 0) throw appError('skill_exists', 'A skill named “pdf” is already installed from somewhere else. Install again with replace to overwrite it.', { name: 'pdf' });
        if (!replace) throw new Error('replace was not passed');
        return { installed: ['pdf', 'docx'] };
      },
    });
    await renderPage();
    const install = section('skills.install');
    fireEvent.change(install.getByRole('textbox', { name: 'Skill repository' }), { target: { value: '  acme/skills@main/office  ' } });
    fireEvent.click(install.getByRole('button', { name: 'Install' }));

    const confirm = within(await screen.findByRole('alertdialog', { name: 'Replace pdf?' }));
    expect(confirm.getByText(/put in place by another tool like npx skills or by hand.*from acme\/skills@main\/office\./)).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Replace' }));

    expect(await screen.findByText('Installed 2 skills: pdf, docx.')).toBeTruthy();
    expect(callsTo('skills.install')).toEqual([{ source: 'acme/skills@main/office' }, { source: 'acme/skills@main/office', replace: true }]);
    expect((install.getByRole('textbox', { name: 'Skill repository' }) as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(callsTo('skills.list').length).toBeGreaterThanOrEqual(3));
  });

  it('shows other install failures under the field', async () => {
    resetBackend({
      'workspaces.list': () => [],
      'skills.list': () => [],
      'skills.install': () => {
        throw appError('install_failed', 'No SKILL.md found under the repository root.');
      },
    });
    await renderPage();
    expect(await screen.findByText('No skills yet.')).toBeTruthy();
    const install = section('skills.install');
    fireEvent.change(install.getByRole('textbox', { name: 'Skill repository' }), { target: { value: 'acme/empty' } });
    fireEvent.click(install.getByRole('button', { name: 'Install' }));

    expect((await install.findByRole('alert')).textContent).toBe('No SKILL.md found under the repository root.');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(install.getByRole('textbox', { name: 'Skill repository' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('uninstalls a skill Atelier installed after confirming', async () => {
    let skills = [pdf, deploy];
    resetBackend({
      'workspaces.list': () => [],
      'skills.list': () => skills,
      'skills.uninstall': ({ name }: { name: string }) => {
        skills = skills.filter((s) => s.name !== name);
        return { ok: true };
      },
    });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall pdf' }));
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Uninstall pdf?' }));
    expect(confirm.getByText('Its folder is deleted and sessions stop offering it. You can install it again from acme/skills.')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Uninstall' }));

    await waitFor(() => expect(screen.queryByText('pdf')).toBeNull());
    expect(callsTo('skills.uninstall')).toEqual([{ name: 'pdf' }]);
  });

  it('shows everyone else the skills, without installing or uninstalling', async () => {
    resetBackend({
      'account.get': () => user({ id: 'u-bob', username: 'bob', name: 'Bob', role: 'user' }),
      'workspaces.list': () => [],
      'skills.list': () => [pdf],
    });
    await renderPage();
    expect(await screen.findByText('pdf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Uninstall pdf' })).toBeNull();
    expect(screen.queryByText('Install from GitHub')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Skill repository' })).toBeNull();
  });
});
