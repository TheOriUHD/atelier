import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { ProviderWizard } from './provider-wizard.tsx';
import { callsTo, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

function setup(type: ProviderConfig['type'] = 'ollama') {
  const existing: ProviderConfig = { id: 'local', name: 'Local', type, baseUrl: 'http://localhost:11434', enabled: true, headers: {}, vramGiB: 16 };
  resetBackend({ 'settings.get': () => snapshot({ providers: [existing] }), 'secrets.list': () => [], 'providers.save': (draft: ProviderConfig) => draft });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><ProviderWizard open existing={existing} onOpenChange={() => {}} /></TooltipProvider></QueryClientProvider>);
}

describe('provider memory budget', () => {
  it('shows the stored GiB budget, explains Ollama estimates, and saves fractional memory', async () => {
    setup();
    const input = await screen.findByLabelText('Available VRAM (GB)');
    expect((input as HTMLInputElement).value).toBe('17.179869184');
    expect(screen.getByText(/Automatically balances each model/)).toBeTruthy();
    fireEvent.click(screen.getByText('How allocation works'));
    expect(screen.getByText(/Weight size and KV cache/).textContent).toContain('does not change server concurrency');
    fireEvent.change(input, { target: { value: '24.5' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(callsTo('providers.save')[0]).toMatchObject({ vramGiB: 24.5 * 1e9 / 1024 ** 3 }));
  });

  it('makes other local server limits explicit instead of promising reconfiguration', async () => {
    setup('llamacpp');
    await screen.findByLabelText('Available VRAM (GB)');
    expect(screen.getByText(/Automatic memory-based context is currently supported for Ollama only/)).toBeTruthy();
  });
});

describe('ChatGPT Chat in the provider list', () => {
  function pick(status: { available: boolean; signedIn: boolean }, plan: { available: boolean }) {
    resetBackend({
      'settings.get': () => snapshot({ providers: [] }),
      'secrets.list': () => [],
      'chatgpt.status': () => ({ ...plan, signedIn: false, signingIn: false }),
      'chatgptChat.status': () => status,
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><ProviderWizard open onOpenChange={() => {}} /></TooltipProvider></QueryClientProvider>);
  }

  it('is offered where a ChatGPT window can be driven, the desktop app', async () => {
    pick({ available: true, signedIn: false }, { available: true });
    expect(await screen.findByText('ChatGPT Chat')).toBeTruthy();
  });

  it('is not offered on a server, even when the ChatGPT Plan can sign in there', async () => {
    pick({ available: false, signedIn: false }, { available: true });
    await screen.findByText('ChatGPT Plan');
    expect(screen.queryByText('ChatGPT Chat')).toBeNull();
  });
});

describe('Mistral in the provider list', () => {
  function choose(label: string) {
    resetBackend({
      'settings.get': () => snapshot({ providers: [] }),
      'secrets.list': () => [],
      'chatgpt.status': () => ({ available: false, signedIn: false, signingIn: false }),
      'chatgptChat.status': () => ({ available: false, signedIn: false }),
      'providers.save': (draft: ProviderConfig) => draft,
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><ProviderWizard open onOpenChange={() => {}} /></TooltipProvider></QueryClientProvider>);
    return screen.findByText(label).then((choice) => fireEvent.click(choice));
  }

  it('adds a Mistral Vibe key: says what it spends and where the key is made, and needs one', async () => {
    await choose('Mistral Vibe');
    expect(screen.getByText(/Vibe allowance of your Le Chat Pro or Team plan/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Vibe keys in Le Chat' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Base URL' }) as HTMLInputElement).value).toBe('https://api.mistral.ai');
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(await screen.findByText('Mistral Vibe needs an API key.')).toBeTruthy();
    expect(callsTo('providers.save')).toEqual([]);
  });

  it('adds Mistral with a console key', async () => {
    await choose('Mistral');
    expect(screen.getByText(/key from Mistral’s console/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Paste your API key'), { target: { value: 'mk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(callsTo('providers.save')[0]).toMatchObject({ type: 'mistral', id: 'mistral', baseUrl: 'https://api.mistral.ai', apiKey: 'mk-test' }));
  });
});
