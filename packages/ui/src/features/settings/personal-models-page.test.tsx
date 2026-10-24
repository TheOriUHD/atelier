import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalProvider } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { ModelMenu } from '../chat/model-picker.tsx';
import { PersonalModelsPage } from './personal-models-page.tsx';
import { model, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const provider = (extra: Partial<PersonalProvider> = {}): PersonalProvider => ({
  id: 'u-0123456789',
  type: 'ollama',
  name: 'My Ollama',
  baseUrl: 'http://localhost:11434',
  enabled: true,
  deviceId: 'laptop',
  deviceName: 'Laptop',
  online: true,
  hasKey: false,
  status: { providerId: 'u-0123456789', ok: true, latencyMs: 4, modelCount: 3, warnings: [], checkedAt: 1 },
  createdAt: 1,
  ...extra,
});

function show(node: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => resetBackend({ 'settings.get': () => snapshot({ providers: [{ id: 'cloud', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, enabled: true }] }) }));

describe('models on your computers', () => {
  it('lists the person’s own model servers with their computer, and leaves adding them to that computer', async () => {
    resetBackend({ 'personalProviders.list': () => [provider(), provider({ id: 'u-9876543210', name: 'Studio', type: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', deviceName: 'Desktop', online: false })] });
    show(<PersonalModelsPage />);
    const ollama = (await screen.findByText('My Ollama')).closest('div.flex.min-h-14') as HTMLElement;
    expect(within(ollama).getByText(/On Laptop · localhost:11434 · 3 models/)).toBeTruthy();
    expect(within(ollama).getByRole('img', { name: 'Connected' })).toBeTruthy();
    const studio = screen.getByText('Studio').closest('div.flex.min-h-14') as HTMLElement;
    expect(within(studio).getByText(/On Desktop · localhost:1234\/v1 · Not connected/)).toBeTruthy();
    // A browser, or a desktop that doesn't lend addresses to the server, has nothing of its own to add.
    expect((screen.getByRole('button', { name: 'Add model server' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Open the desktop app on the computer that runs them/)).toBeTruthy();
    expect(screen.queryByText('Found on this computer')).toBeNull();
  });
});

describe('the model menu', () => {
  it('groups the person’s own models under their computer, and holds back those whose computer is away', async () => {
    resetBackend({
      'settings.get': () => snapshot({ providers: [{ id: 'cloud', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, enabled: true }] }),
      'models.list': () => [
        model('cloud', 'claude'),
        model('u-0123456789', 'qwen3:8b', { personal: { deviceId: 'laptop', deviceName: 'Laptop' }, available: true }),
        model('u-9876543210', 'gemma', { personal: { deviceId: 'desktop', deviceName: 'Desktop' }, available: false }),
      ],
    });
    const chosen = vi.fn();
    show(<ModelMenu value={null} label="Choose a model" onChange={chosen} />);
    fireEvent.click(await screen.findByRole('button', { name: /Choose a model/ }));
    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.getByText('Desktop · Not connected')).toBeTruthy();
    expect(screen.getByText('Desktop isn’t connected')).toBeTruthy();
    const away = screen.getByRole('menuitemradio', { name: /gemma/ });
    expect(away.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /qwen3:8b/ }));
    expect(chosen).toHaveBeenCalledWith('u-0123456789/qwen3:8b');
  });
});
