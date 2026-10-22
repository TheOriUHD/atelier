import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, type InviteSummary } from '@atelier/protocol';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend, snapshot, user } from './test-backend.ts';
import { UsersPage } from './users-page.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const ada = user();
const bob = user({ id: 'u-bob', username: 'bob', name: 'Bob', role: 'user', lastActiveAt: Date.now() - 3_600_000 });
const eve = user({ id: 'u-eve', username: 'eve', name: 'Eve', role: 'pending' });

/** Every test sees the default settings: safeguards off for everyone. */
const reset = (handlers: Parameters<typeof resetBackend>[0]) => resetBackend({ 'settings.get': () => snapshot(), ...handlers });

beforeEach(() => {
  reset({
    'users.list': () => [ada, bob, eve],
    'invites.list': () => [],
    'users.update': ({ id, ...patch }: { id: string }) => ({ ...bob, id, ...patch }),
  });
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <UsersPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function userRow(name: string) {
  const table = await screen.findByRole('table', { name: 'Users' });
  const cell = await within(table).findByText(name);
  return within(cell.closest('tr')!);
}

async function chooseFromMenu(rowName: string, item: RegExp) {
  const row = await userRow(rowName);
  fireEvent.click(row.getByRole('button', { name: `${rowName} options` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

function pick(option: HTMLElement) {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
}

describe('Users page', () => {
  it('lists members with role and status, and keeps pending sign-ups apart', async () => {
    renderPage();
    const me = await userRow('Ada Lovelace');
    expect(me.getByText('You')).toBeTruthy();
    // Nobody demotes or deletes themselves from here.
    expect(me.getByRole('combobox', { name: 'Role of Ada Lovelace' }).hasAttribute('data-disabled')).toBe(true);
    expect(me.queryByRole('button', { name: 'Ada Lovelace options' })).toBeNull();

    const row = await userRow('Bob');
    expect(row.getByText('Active')).toBeTruthy();
    expect(row.getByText('1 hour ago')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Users' })).queryByText('Eve')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve Eve' })).toBeTruthy();
  });

  it('changes a role, and shows the backend’s reason when it refuses', async () => {
    reset({
      'users.list': () => [ada, bob],
      'invites.list': () => [],
      'users.update': () => {
        throw appError('last_admin', 'This is the only admin. Make someone else an admin first.');
      },
    });
    renderPage();
    fireEvent.click((await userRow('Bob')).getByRole('combobox', { name: 'Role of Bob' }));
    pick(await screen.findByRole('option', { name: 'Admin' }));

    expect(await screen.findByText('This is the only admin. Make someone else an admin first.')).toBeTruthy();
    expect(callsTo('users.update')).toEqual([{ id: 'u-bob', role: 'admin' }]);
    await waitFor(() => expect(callsTo('users.list')).toHaveLength(2));
  });

  it('sets safeguards per person, showing what the default follows', async () => {
    renderPage();
    const select = (await userRow('Bob')).getByRole('combobox', { name: 'Safeguards for Bob' });
    expect(select.textContent).toContain('Default (off)');
    fireEvent.click(select);
    pick(await screen.findByRole('option', { name: 'On' }));
    await waitFor(() => expect(callsTo('users.update')).toEqual([{ id: 'u-bob', safeguards: 'on' }]));
  });

  it('adds a user and shows the temporary password once, with copy', async () => {
    let taken = true;
    reset({
      'users.list': () => [ada],
      'invites.list': () => [],
      'users.create': ({ username, name, role }: { username: string; name: string; role: 'user' }) => {
        if (taken) {
          taken = false;
          throw appError('exists', `The username “${username}” is taken.`);
        }
        return { user: user({ id: 'u-new', username, name, role, mustChangePassword: true }), temporaryPassword: 'tmp-Pass-123' };
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add user' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add user' }));

    fireEvent.click(dialog.getByRole('button', { name: 'Add user' }));
    expect(await dialog.findByText('Enter their name.')).toBeTruthy();
    expect(callsTo('users.create')).toEqual([]);

    fireEvent.change(dialog.getByRole('textbox', { name: 'Full name' }), { target: { value: 'Carol' } });
    fireEvent.change(dialog.getByRole('textbox', { name: /^Username/ }), { target: { value: 'Carol' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Add user' }));
    expect(await dialog.findByText('The username “carol” is taken.')).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'Add user' }));
    const done = within(await screen.findByRole('dialog', { name: 'Carol can sign in now' }));
    expect((done.getByRole('textbox', { name: 'Temporary password' }) as HTMLInputElement).value).toBe('tmp-Pass-123');
    expect(done.getByRole('button', { name: 'Copy password' })).toBeTruthy();
    expect(callsTo('users.create')).toEqual([
      { username: 'carol', name: 'Carol', role: 'user' },
      { username: 'carol', name: 'Carol', role: 'user' },
    ]);
  });

  it('resets a password after confirming and shows the new temporary one', async () => {
    reset({ 'users.list': () => [ada, bob], 'invites.list': () => [], 'users.resetPassword': () => ({ temporaryPassword: 'reset-Pass-9' }) });
    renderPage();
    await chooseFromMenu('Bob', /Reset password/);
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Reset Bob’s password?' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Reset password' }));

    const shown = within(await screen.findByRole('dialog', { name: 'Temporary password' }));
    expect((shown.getByRole('textbox', { name: 'Temporary password' }) as HTMLInputElement).value).toBe('reset-Pass-9');
    expect(callsTo('users.resetPassword')).toEqual([{ id: 'u-bob' }]);
  });

  it('disables and deletes a user; deleting explains what goes with the account', async () => {
    reset({
      'users.list': () => [ada, bob],
      'invites.list': () => [],
      'users.update': () => ({ ...bob, disabled: true }),
      'users.delete': () => ({ ok: true }),
    });
    renderPage();
    await chooseFromMenu('Bob', /Disable/);
    await waitFor(() => expect(callsTo('users.update')).toEqual([{ id: 'u-bob', disabled: true }]));

    await chooseFromMenu('Bob', /Delete/);
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Delete Bob?' }));
    expect(confirm.getByText('Bob’s chats, projects and files are deleted with the account. This can’t be undone.')).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(callsTo('users.delete')).toEqual([{ id: 'u-bob' }]));
  });

  it('approves and rejects sign-ups', async () => {
    reset({
      'users.list': () => [ada, eve, user({ id: 'u-mal', username: 'mal', name: 'Mal', role: 'pending' })],
      'invites.list': () => [],
      'users.update': () => ({ ...eve, role: 'user' }),
      'users.delete': () => ({ ok: true }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Eve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject Mal' }));

    await waitFor(() => expect(callsTo('users.delete')).toEqual([{ id: 'u-mal' }]));
    expect(callsTo('users.update')).toEqual([{ id: 'u-eve', role: 'user' }]);
  });

  it('creates an invite code to copy, lists open codes masked and revokes them', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const invite: InviteSummary = { id: 'i-1', role: 'admin', hint: 'G7H8', createdAt: Date.now(), expiresAt: Date.now() + 7 * 86_400_000, usedAt: null, usedBy: null };
    const link: InviteSummary = { ...invite, id: 'i-0', hint: null };
    const used: InviteSummary = { ...invite, id: 'i-2', usedAt: Date.now(), usedBy: 'u-bob' };
    reset({
      'users.list': () => [ada],
      'invites.list': () => [invite, link, used],
      'invites.create': ({ role }: { role: 'admin' }) => ({ invite: { ...invite, role }, code: 'A1B2-C3D4-E5F6-G7H8' }),
      'invites.revoke': () => ({ ok: true }),
    });
    renderPage();
    const open = await screen.findByRole('table', { name: 'Open invite codes' });
    expect(within(open).getAllByRole('row')).toHaveLength(3);
    expect(within(open).getByText('••••-••••-••••-G7H8')).toBeTruthy();
    expect(within(open).getByText('Invite link')).toBeTruthy();
    expect(within(open).queryByText(/A1B2/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Invite code' }));
    fireEvent.click(dialog.getByRole('combobox'));
    pick(await screen.findByRole('option', { name: 'Admin' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Create code' }));

    const code = (await dialog.findByRole('textbox', { name: 'Invite code' })) as HTMLInputElement;
    expect(code.value).toBe('A1B2-C3D4-E5F6-G7H8');
    expect(dialog.getByText(`${location.origin}${location.pathname.replace(/\/+$/, '')}`)).toBeTruthy();
    expect(callsTo('invites.create')).toEqual([{ role: 'admin' }]);
    fireEvent.click(dialog.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('A1B2-C3D4-E5F6-G7H8'));
    fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Invite code' })).toBeNull());

    fireEvent.click(within(open).getByRole('button', { name: 'Revoke ••••-••••-••••-G7H8' }));
    await waitFor(() => expect(callsTo('invites.revoke')).toEqual([{ id: 'i-1' }]));
  });
});
