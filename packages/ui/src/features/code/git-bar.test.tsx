import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type GitStatus } from '@atelier/protocol';
import { backend, callsTo, resetBackend } from '../settings/test-backend.ts';
import { DiffView } from './diff-review.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const HEADER = 'diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n';
const HUNK_1 = '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n';
const HUNK_2 = '@@ -9,2 +9,2 @@\n nine\n-ten\n+TEN\n';
const NEW_FILE = 'diff --git a/b.ts b/b.ts\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+export {};\n';

const ok = () => ({ ok: true });

function setup(
  files: NonNullable<GitStatus>['files'] = [
    { path: 'a.ts', status: 'modified', staged: false },
    { path: 'b.ts', status: 'added', staged: true },
  ],
  upstream: NonNullable<GitStatus>['upstream'] = null,
) {
  resetBackend({
    'workspaces.gitStatus': () => ({ branch: 'main', upstream, files }),
    'workspaces.diff': () => ({ diff: HEADER + HUNK_1 + HUNK_2 + NEW_FILE, truncated: false }),
    'git.branches': () => ({ current: 'main', branches: ['feature/notes', 'main'], lastCommit: 'Add notes page' }),
    'git.checkout': ok,
    'git.stage': ok,
    'git.commit': () => ({ commit: 'abc1234' }),
    'git.push': ok,
    'git.revertHunk': ok,
    'git.pullRequest': () => ({ url: 'https://github.com/acme/app/pull/7' }),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DiffView workspaceId="w1" />
    </QueryClientProvider>,
  );
}

/** Each action refreshes the pane: git status is read again. */
const refreshed = (before: number) => waitFor(() => expect(callsTo('workspaces.gitStatus').length).toBeGreaterThan(before));

beforeEach(() => resetBackend({}));

describe('Diff tab staging', () => {
  it('stages and unstages one file, or all of them', async () => {
    setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Stage a.ts' }));
    await waitFor(() => expect(callsTo('git.stage')).toEqual([{ workspaceId: 'w1', paths: ['a.ts'], staged: true }]));
    await refreshed(1);

    const b = screen.getByRole('checkbox', { name: 'Stage b.ts' });
    expect(b.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(b);
    await waitFor(() => expect(callsTo('git.stage').at(-1)).toEqual({ workspaceId: 'w1', paths: ['b.ts'], staged: false }));

    const all = screen.getByRole('checkbox', { name: 'Stage all' });
    expect(all.getAttribute('aria-checked')).toBe('mixed');
    expect(screen.getByText(/2 changed files · 1 staged/)).toBeTruthy();
    await waitFor(() => expect(all.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(all);
    await waitFor(() => expect(callsTo('git.stage').at(-1)).toEqual({ workspaceId: 'w1', paths: ['a.ts'], staged: true }));
  });

  it('rejects one hunk by sending the file’s header and that hunk', async () => {
    setup();
    const file = await screen.findByRole('region', { name: 'a.ts' });
    const rejects = within(file).getAllByRole('button', { name: 'Reject' });
    expect(rejects).toHaveLength(2);
    fireEvent.click(rejects[1]!);
    await waitFor(() => expect(callsTo('git.revertHunk')).toEqual([{ workspaceId: 'w1', patch: HEADER + HUNK_2 }]));
    await refreshed(1);
  });
});

describe('git bar', () => {
  it('commits what is staged with the message, and only once something is', async () => {
    setup();
    const message = await screen.findByRole('textbox', { name: 'Commit message' });
    const commit = screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' });
    expect(commit.disabled).toBe(true);
    fireEvent.change(message, { target: { value: 'Add the notes page ' } });
    fireEvent.click(commit);
    await waitFor(() => expect(callsTo('git.commit')).toEqual([{ workspaceId: 'w1', message: 'Add the notes page' }]));
    await waitFor(() => expect((message as HTMLInputElement).value).toBe(''));
  });

  it('keeps Commit off with nothing staged', async () => {
    setup([{ path: 'a.ts', status: 'modified', staged: false }]);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Commit message' }), { target: { value: 'Something' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' }).disabled).toBe(true);
  });

  it('switches to a branch, or creates one', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Branch: main' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'feature/notes' }));
    await waitFor(() => expect(callsTo('git.checkout')).toEqual([{ workspaceId: 'w1', branch: 'feature/notes', create: false }]));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Branch: main' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New branch…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New branch' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'fix/typo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create branch' }));
    await waitFor(() => expect(callsTo('git.checkout').at(-1)).toEqual({ workspaceId: 'w1', branch: 'fix/typo', create: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('pushes, and opens a pull request with a link to it', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }));
    await waitFor(() => expect(callsTo('git.push')).toEqual([{ workspaceId: 'w1' }]));

    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: 'Notes page' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), { target: { value: 'Adds it.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open pull request' }));
    await waitFor(() => expect(callsTo('git.pullRequest')).toEqual([{ workspaceId: 'w1', title: 'Notes page', body: 'Adds it.' }]));
    const link = await screen.findByRole('link', { name: 'https://github.com/acme/app/pull/7' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/pull/7');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('counts commits to push and suggests the pull request’s title and base', async () => {
    setup(undefined, { ahead: 0, behind: 2 });
    expect((await screen.findByRole('button', { name: 'Push: nothing to push' })).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('2 behind')).toBeTruthy();

    cleanup();
    setup(undefined, { ahead: 3, behind: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Push 3 commits' }));
    await waitFor(() => expect(callsTo('git.push')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    await waitFor(() => expect((within(dialog).getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Add notes page'));
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Base branch' }));
    const option = await screen.findByRole('option', { name: 'feature/notes' });
    // Base UI only accepts mouse clicks that started on the option.
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open pull request' }));
    await waitFor(() => expect(callsTo('git.pullRequest')).toEqual([{ workspaceId: 'w1', title: 'Add notes page', body: '', base: 'feature/notes' }]));
  });

  it('shows git’s message inline when it refuses', async () => {
    setup();
    backend.handlers['git.push'] = () => {
      throw appError('git_failed', 'Updates were rejected because the remote contains work that you do not have locally.');
    };
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/^Updates were rejected/);

    backend.handlers['git.pullRequest'] = () => {
      throw appError('git_failed', 'Opening a pull request needs the GitHub CLI (gh).');
    };
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: 'Notes' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open pull request' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Opening a pull request needs the GitHub CLI (gh).');
  });
});
