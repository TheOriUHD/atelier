import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshPrompt } from '@atelier/protocol';
import { callsTo, emit, resetBackend } from '../settings/test-backend.ts';
import { SshConnectionDialog, validate } from './connection-dialog.tsx';
import { SshPrompts } from './ssh-prompts.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const view = (extra = {}) => ({ id: 'c1', name: 'GPU box', host: 'alice@devbox', port: null, keyPath: null, folder: null, passwordSaved: false, ...extra });

beforeEach(() =>
  resetBackend({
    'workspaces.sshHosts': () => ['devbox', 'ci'],
    'ssh.test': () => ({ ok: true, message: 'Connected: Linux x86_64.' }),
    'ssh.save': (input: object) => view(input),
    'ssh.answer': () => ({ ok: true }),
  }),
);

describe('validate', () => {
  it('names the field a problem is in, and gives the input when all is well', () => {
    const empty = validate({ name: '', host: '', port: '', keyPath: '', folder: '' });
    expect(empty.input).toBeUndefined();
    expect(empty.errors.name).toBe('Give the connection a name.');
    expect(empty.errors.host).toBeTruthy();
    expect(validate({ name: 'A', host: '-oProxyCommand=x', port: '', keyPath: '', folder: '' }).errors.host).toBeTruthy();
    expect(validate({ name: 'A', host: 'a@b', port: 'abc', keyPath: '', folder: '' }).errors.port).toBe('Use a port number, or leave it empty.');
    expect(validate({ name: 'A', host: 'a@b', port: '70000', keyPath: '', folder: '' }).errors.port).toBeTruthy();
    expect(validate({ name: ' GPU box ', host: 'alice@devbox', port: '2222', keyPath: '~/.ssh/id_ed25519', folder: '~/p' }).input).toEqual({
      name: 'GPU box',
      host: 'alice@devbox',
      port: 2222,
      keyPath: '~/.ssh/id_ed25519',
      folder: '~/p',
    });
  });
});

describe('SshConnectionDialog', () => {
  const show = (props = {}) =>
    render(
      <QueryClientProvider client={client()}>
        <SshConnectionDialog open onOpenChange={() => {}} {...props} />
      </QueryClientProvider>,
    );

  it('tests what is filled in, and adds the connection', async () => {
    const onSaved = vi.fn();
    show({ onSaved });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'GPU box' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'SSH host' }), { target: { value: 'alice@devbox' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'SSH port' }), { target: { value: '2222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connected: Linux x86_64.')).toBeTruthy();
    expect(callsTo('ssh.test')).toEqual([{ name: 'GPU box', host: 'alice@devbox', port: 2222, keyPath: null, folder: null }]);
    fireEvent.click(screen.getByRole('button', { name: 'Add SSH connection' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(callsTo('ssh.save')).toEqual([{ name: 'GPU box', host: 'alice@devbox', port: 2222, keyPath: null, folder: null }]);
  });

  it('shows what is wrong in the field and sends nothing', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Add SSH connection' }));
    expect(screen.getByText('Give the connection a name.')).toBeTruthy();
    expect(callsTo('ssh.save')).toEqual([]);
  });

  it('says why a connection failed', async () => {
    resetBackend({ 'workspaces.sshHosts': () => [], 'ssh.test': () => ({ ok: false, message: "GPU box refused the sign-in (Permission denied)." }) });
    show({ connection: view() });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/refused the sign-in/)).toBeTruthy();
    // Editing keeps the connection's id, so the test finds its saved password.
    expect(callsTo('ssh.test')).toEqual([{ id: 'c1', name: 'GPU box', host: 'alice@devbox', port: null, keyPath: null, folder: null }]);
  });
});

describe('SshPrompts', () => {
  const ask = (prompt: SshPrompt) => act(() => emit('ssh.prompt', prompt));
  const showPrompts = () =>
    render(
      <QueryClientProvider client={client()}>
        <SshPrompts />
      </QueryClientProvider>,
    );

  it('asks to trust a new host key with its fingerprint, and answers', async () => {
    showPrompts();
    ask({ id: 'p1', kind: 'hostkey', connection: 'GPU box', host: 'devbox (10.0.0.5)', keyType: 'ED25519', fingerprint: 'SHA256:abcDEF123' });
    const dialog = await screen.findByRole('dialog', { name: 'Trust GPU box?' });
    expect(dialog.textContent).toContain('SHA256:abcDEF123');
    expect(dialog.textContent).toContain('ED25519');
    fireEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
    await waitFor(() => expect(callsTo('ssh.answer')).toEqual([{ id: 'p1', accept: true }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks for a password with Save password, and sends it only when there is one', async () => {
    showPrompts();
    ask({ id: 'p2', kind: 'password', connection: 'GPU box', host: 'alice@devbox', prompt: "alice@devbox's password: ", retry: false, canSave: true });
    await screen.findByRole('dialog', { name: 'Sign in to GPU box' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(callsTo('ssh.answer')).toEqual([{ id: 'p2', password: 'hunter2', save: true }]));
  });

  it('offers no Save for a one-time code, and Cancel refuses', async () => {
    showPrompts();
    ask({ id: 'p3', kind: 'password', connection: 'GPU box', host: 'alice@devbox', prompt: 'Verification code: ', retry: false, canSave: false });
    await screen.findByRole('dialog', { name: 'Sign in to GPU box' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(callsTo('ssh.answer')).toEqual([{ id: 'p3' }]));
  });

  it('goes away when the question is closed elsewhere', async () => {
    showPrompts();
    ask({ id: 'p4', kind: 'hostkey', connection: 'GPU box', host: 'devbox', keyType: 'ED25519', fingerprint: 'SHA256:x' });
    await screen.findByRole('dialog');
    act(() => emit('ssh.promptClosed', { id: 'p4' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
