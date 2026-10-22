import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DetectedProvider, ProviderStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, model, resetBackend, snapshot } from '../settings/test-backend.ts';
import { Onboarding } from './onboarding.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const ollama: DetectedProvider = { type: 'ollama', baseUrl: 'http://localhost:11434', label: 'Ollama', via: 'port' };
const status = (modelCount: number): ProviderStatus => ({ providerId: 'ollama', ok: true, latencyMs: 3, modelCount, warnings: [], checkedAt: 1 });
const draft = { id: 'ollama', type: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', headers: {}, enabled: true };

function renderOnboarding() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Onboarding />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('Onboarding', () => {
  it('connects a detected provider in one click: tests, saves and picks the default chat model', async () => {
    resetBackend({
      'settings.get': () => snapshot(),
      'secrets.list': () => [],
      'providers.detect': () => [ollama],
      'providers.test': () => ({ status: status(2), models: [] }),
      'providers.save': () => draft,
      'models.list': () => [model('ollama', 'qwen3:8b', { hidden: true }), model('ollama', 'llama3.2')],
      'settings.set': () => ({ ok: true }),
    });
    renderOnboarding();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(callsTo('settings.set')).toEqual([{ layer: 'global', path: ['models', 'defaults', 'chat'], value: 'ollama/llama3.2' }]));
    expect(callsTo('providers.test')).toEqual([draft]);
    expect(callsTo('providers.save')).toEqual([draft]);
  });

  it('keeps an existing default chat model', async () => {
    resetBackend({
      'settings.get': () => snapshot({ models: { defaults: { chat: 'anthropic/claude' }, aliases: {}, overrides: {} } }),
      'secrets.list': () => [],
      'providers.detect': () => [ollama],
      'providers.test': () => ({ status: status(1), models: [] }),
      'providers.save': () => draft,
    });
    renderOnboarding();
    await screen.findByText('Welcome to Atelier');
    await waitFor(() => expect(callsTo('settings.get').length).toBe(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(callsTo('providers.save')).toEqual([draft]));
    expect(callsTo('settings.set')).toEqual([]);
  });

  it('does not save a provider that has no models, and says how to fix it', async () => {
    resetBackend({
      'settings.get': () => snapshot(),
      'secrets.list': () => [],
      'providers.detect': () => [ollama],
      'providers.test': () => ({ status: status(0), models: [] }),
    });
    renderOnboarding();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(/Ollama is running but has no models yet/)).toBeTruthy();
    expect(callsTo('providers.save')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    expect(await screen.findByRole('dialog', { name: 'Add Ollama' })).toBeTruthy();
  });

  it('explains what was scanned when nothing is found and offers manual setup', async () => {
    resetBackend({ 'settings.get': () => snapshot(), 'secrets.list': () => [], 'providers.detect': () => [] });
    renderOnboarding();

    expect(await screen.findByText(/Nothing found on the usual ports/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add manually' }));
    expect(await screen.findByRole('dialog', { name: 'Add provider' })).toBeTruthy();
  });
});
