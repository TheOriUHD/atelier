import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, parsePairingLink } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { PairPhoneButton, pairedDetail, pairedTitle, qrModules } from './phone-sign-in.tsx';
import { callsTo, emit, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const open = () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PairPhoneButton />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pair mobile app' }));
};

beforeEach(() => resetBackend({}));

describe('Account › Pair mobile app', () => {
  it('asks for a code when it opens and shows it as a QR code with its time left', async () => {
    resetBackend({
      'account.pairStart': () => ({
        pollToken: 'T'.repeat(43),
        addresses: ['https://atelier.example.com'],
        expiresAt: Date.now() + 300_000,
      }),
    });
    open();
    expect(await screen.findByRole('img', { name: 'QR code to sign in your phone' })).toBeTruthy();
    expect(screen.getByText(/Works once, for \d:\d\d more/)).toBeTruthy();
    expect(screen.getByText(/signs in as you/)).toBeTruthy();
    expect(callsTo('account.pairStart')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show a new code' }));
    await screen.findByRole('img', { name: 'QR code to sign in your phone' });
    expect(callsTo('account.pairStart')).toHaveLength(2);
  });

  it('says why there is no code when the server cannot give one', async () => {
    resetBackend({
      'account.pairStart': () => {
        throw appError(
          'unsupported',
          'Turn on “Share on your network” in Settings › Connection first, then show the code again.',
        );
      },
    });
    open();
    expect(await screen.findByText(/Turn on “Share on your network”/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('draws the QR code from the text it is given, with a quiet zone around it', () => {
    const { size, path } = qrModules('atelier://pair?token=abc');
    expect(size).toBeGreaterThan(21);
    expect(path.length).toBeGreaterThan(100);
    expect(parsePairingLink('atelier://pair?token=abc')).toBeNull();
  });

  it('draws the code black on white, in the picture itself, so no theme can grey it', async () => {
    resetBackend({ 'account.pairStart': () => ({ pollToken: 'T'.repeat(43), addresses: ['https://atelier.example.com'], expiresAt: Date.now() + 300_000 }) });
    open();
    const picture = await screen.findByRole('img', { name: 'QR code to sign in your phone' });
    expect(picture.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff');
    expect(picture.querySelector('path')?.getAttribute('fill')).toBe('#000000');
    expect(picture.getAttribute('style')).toContain('#ffffff');
  });

  it('turns into a confirmation with the phone and the app when the phone has signed in', async () => {
    resetBackend({
      'account.pairStart': () => ({ pollToken: 'T'.repeat(43), addresses: ['https://atelier.example.com'], expiresAt: Date.now() + 300_000 }),
    });
    open();
    await screen.findByRole('img', { name: 'QR code to sign in your phone' });
    emit('account.phonePaired', { name: 'Philipp’s iPhone', model: 'iPhone 17 Pro', appVersion: '1.0' });
    expect(await screen.findByText('Philipp’s iPhone is logged in!')).toBeTruthy();
    expect(screen.getByText('iPhone 17 Pro · Atelier 1.0')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'QR code to sign in your phone' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('names the phone by the person when it only gives its kind, and says what it can', () => {
    expect(pairedTitle({ name: 'iPhone', model: 'iPhone 17 Pro', appVersion: '1.0' }, 'Philipp Buß')).toBe('Philipp’s iPhone');
    expect(pairedTitle({ name: 'iPad', model: '', appVersion: '' }, 'Maya')).toBe('Maya’s iPad');
    expect(pairedTitle({ name: '', model: 'iPad Pro 13-inch (M5)', appVersion: '' }, 'Maya Lindqvist')).toBe('Maya’s iPad');
    expect(pairedTitle({ name: '', model: '', appVersion: '' }, '')).toBe('Phone');
    expect(pairedTitle({ name: 'Studio phone', model: 'iPhone 17', appVersion: '' }, 'Maya')).toBe('Studio phone');
    expect(pairedDetail({ name: '', model: 'iPhone 17 Pro', appVersion: '1.0' })).toBe('iPhone 17 Pro · Atelier 1.0');
    expect(pairedDetail({ name: '', model: '', appVersion: '1.0' })).toBe('Atelier 1.0');
    expect(pairedDetail({ name: '', model: '', appVersion: '' })).toBe('');
  });
});
