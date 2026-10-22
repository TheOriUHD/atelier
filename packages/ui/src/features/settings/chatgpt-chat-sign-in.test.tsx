import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatGptChatSignIn, WARNING_SECONDS } from './chatgpt-chat-sign-in.tsx';
import { callsTo, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

afterEach(() => vi.useRealTimers());

/** Seconds pass one at a time: each tick of the countdown is scheduled after the last one has rendered. */
async function wait(seconds: number) {
  for (let i = 0; i < seconds; i++) await act(async () => void vi.advanceTimersByTime(1000));
}

/** Waits out the warning that comes first. */
async function understand() {
  await wait(WARNING_SECONDS);
  fireEvent.click(screen.getByRole('button', { name: 'I understand, continue' }));
}

it('says what ChatGPT Chat is first, and lets the person on only after the countdown', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetBackend({ 'chatgptChat.hide': () => ({ ok: true }), 'chatgptChat.status': () => ({ available: true, signedIn: false }) });
  const onBack = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><ChatGptChatSignIn onBack={onBack} onAdded={() => {}} /></QueryClientProvider>);
  expect(screen.getByRole('alert').textContent).toMatch(/not an official way to use ChatGPT/);
  expect(screen.getByRole('alert').textContent).toMatch(/could limit or suspend the account/);
  const next = screen.getByRole('button', { name: `Continue in ${WARNING_SECONDS}` });
  expect((next as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(next);
  expect(screen.queryByRole('button', { name: 'Sign in to ChatGPT' })).toBeNull();
  await wait(WARNING_SECONDS - 1);
  expect((screen.getByRole('button', { name: 'Continue in 1' }) as HTMLButtonElement).disabled).toBe(true);
  await wait(1);
  const ready = screen.getByRole('button', { name: 'I understand, continue' });
  expect((ready as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(ready);
  expect(screen.getByRole('button', { name: 'Sign in to ChatGPT' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});

it('opens the managed session and adds ChatGPT Chat only after sign-in is detected', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetBackend({ 'chatgptChat.open': () => ({ ok: true }), 'chatgptChat.hide': () => ({ ok: true }), 'chatgptChat.status': () => ({ available: true, signedIn: true }), 'providers.save': (config) => config });
  const onAdded = vi.fn();
  const view = render(<QueryClientProvider client={new QueryClient()}><ChatGptChatSignIn onBack={() => {}} onAdded={onAdded} /></QueryClientProvider>);
  await understand();
  expect(screen.getByText(/Your ChatGPT Plan connection stays unchanged/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add ChatGPT Chat' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in to ChatGPT' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add ChatGPT Chat' }));
  await waitFor(() => expect(onAdded).toHaveBeenCalled());
  expect(callsTo('providers.save')[0]).toMatchObject({ type: 'chatgpt-chat', name: 'ChatGPT Chat' });
  expect(callsTo('chatgptChat.hide')).toHaveLength(1);
  expect(callsTo('chatgpt.signIn')).toEqual([]);
  view.unmount();
  expect(callsTo('chatgptChat.hide')).toHaveLength(2);
});
