import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError, parsePairingLink } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { PhoneSignInSection, qrModules } from './phone-sign-in.tsx';
import { callsTo, resetBackend } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const open = () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PhoneSignInSection />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show QR code' }));
};

beforeEach(() => resetBackend({}));

describe('Account › Sign in your phone', () => {
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
});
