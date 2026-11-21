import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RpcError, RpcErrorCode, type ModelInfo, type ProviderStatus } from '@atelier/protocol';
import { expect, it, vi } from 'vitest';
import { Toaster, TooltipProvider } from '../../components/ui/index.ts';
import { ModelsPage } from './models-page.tsx';
import { callsTo, model, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

it('opens a compact library and lets admins search, page, and enable catalog models', async () => {
  const models = Array.from({ length: 105 }, (_, i) => model('router', `model-${String(i).padStart(3, '0')}`, { hidden: true }));
  resetBackend({
    'settings.get': () => snapshot({ providers: [{ id: 'router', name: 'OpenRouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, headers: {} }] }),
    'models.list': () => models,
    'settings.set': () => snapshot(),
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><ModelsPage /></TooltipProvider></QueryClientProvider>);
  expect(await screen.findByText('0 enabled · 105 available')).toBeTruthy();
  expect(screen.queryByLabelText('Display name for model-000')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Browse catalog' }));
  const table = screen.getByRole('table', { name: 'OpenRouter' });
  expect(within(table).getAllByRole('row')).toHaveLength(21);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByLabelText('Display name for model-020')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search OpenRouter models' }), { target: { value: 'model-104' } });
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  fireEvent.click(screen.getByRole('switch', { name: 'Show model-104 in the model picker' }));
  await waitFor(() => expect(callsTo('settings.set')).toContainEqual(expect.objectContaining({ path: ['models', 'overrides', 'router/model-104', 'hidden'], value: false })));
});

const GPU = { id: 'gpu', name: 'GPU', type: 'ollama' as const, baseUrl: 'http://localhost:11434', enabled: true, headers: {}, vramGiB: 29.8 };
const CPP = { id: 'cpp', name: 'llama.cpp', type: 'llamacpp' as const, baseUrl: 'http://localhost:8080', enabled: true, headers: {}, vramGiB: 29.8 };
const status = (providerId: string, ok = true): ProviderStatus => ({ providerId, ok, latencyMs: ok ? 4 : null, modelCount: 1, warnings: [], checkedAt: 0 });

const FITS = model('gpu', 'fits', { contextLength: 100_000, calculatedContextLength: 100_000, calculation: { state: 'calculated' } });
const HUGE = model('gpu', 'huge', { calculation: { state: 'too-large', detail: 'Its weights are 42.9 GB, which leaves too little of the 32 GB memory budget for a usable context.' } });
const STRANGE = model('gpu', 'strange', { calculation: { state: 'unsupported', detail: 'Atelier can’t read the memory use of the mamba9 architecture from its metadata.' }, contextUnsized: { reason: 'architecture', architecture: 'mamba9' } });
const NOSIZE = model('gpu', 'nosize', { calculation: { state: 'unknown-size', detail: 'The server didn’t say how large its weights are.' } });
const LOCAL = model('cpp', 'local', { calculation: { state: 'not-applicable', detail: 'Only Ollama models are sized from a memory budget; this server sets its own context.' } });

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ModelsPage />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

it('says in words why a model has no calculated context, and Calculate all tells how many it calculated', async () => {
  const models: ModelInfo[] = [FITS, HUGE, STRANGE, NOSIZE, LOCAL];
  resetBackend({
    'settings.get': () => snapshot({ providers: [GPU, CPP] }),
    'models.list': () => models,
    'providers.refresh': () => [status('gpu'), status('cpp')],
  });
  renderPage();
  expect(await screen.findByText('Calculated')).toBeTruthy();
  expect(screen.getByText('Doesn’t fit the budget').getAttribute('title')).toContain('Its weights are 42.9 GB');
  expect(screen.getByText('mamba9 not supported').getAttribute('title')).toContain('mamba9 architecture');
  expect(screen.getByText('Size unknown')).toBeTruthy();
  expect(screen.getByText('Not applicable')).toBeTruthy();
  expect(screen.queryByText('Not calculated')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Calculate all' }));
  expect(await screen.findByText('Calculated 1 of 4 models')).toBeTruthy();
  expect(screen.getByText(/1 doesn’t fit the memory budget; 1 can’t be read \(mamba9\); 1 has no size from the server\./)).toBeTruthy();
  expect(callsTo('providers.refresh')).toEqual([{}]);
});

it('does not claim success when no provider has a memory budget, or a provider could not be reached', async () => {
  resetBackend({
    'settings.get': () => snapshot({ providers: [{ ...GPU, vramGiB: undefined }] }),
    'models.list': () => [model('gpu', 'plain')],
    'providers.refresh': () => [status('gpu')],
  });
  renderPage();
  await screen.findByLabelText('Display name for plain');
  fireEvent.click(screen.getByRole('button', { name: 'Calculate all' }));
  expect(await screen.findByText('No memory budget is set')).toBeTruthy();
  // The old toast said so whatever happened.
  expect(screen.queryByText('Recalculated all models')).toBeNull();
});

it('names the provider that could not be reached next to what was calculated', async () => {
  resetBackend({
    'settings.get': () => snapshot({ providers: [GPU] }),
    'models.list': () => [FITS],
    'providers.refresh': () => [status('gpu', false)],
  });
  renderPage();
  await screen.findByLabelText('Display name for fits');
  fireEvent.click(screen.getByRole('button', { name: 'Calculate all' }));
  expect(await screen.findByText('Calculated 1 of 1 models')).toBeTruthy();
  expect(screen.getByText(/GPU couldn’t be reached; its models keep the last calculation\./)).toBeTruthy();
});

it('calculates one model from its menu and says what came out', async () => {
  const updated = { ...HUGE, contextLength: 61_440, calculatedContextLength: 61_440, calculation: { state: 'calculated' as const } };
  resetBackend({
    'settings.get': () => snapshot({ providers: [GPU] }),
    'models.list': () => [FITS, HUGE],
    'models.calculate': () => updated,
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'huge options' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Calculate context' }));
  expect(await screen.findByText(/huge: .* tokens of context fit the memory budget\./)).toBeTruthy();
  expect(callsTo('models.calculate')).toEqual([{ ref: 'gpu/huge' }]);
  expect(callsTo('providers.refresh')).toEqual([]);
});

it('refreshes the provider instead when the server is too old to calculate one model', async () => {
  resetBackend({
    'settings.get': () => snapshot({ providers: [GPU] }),
    'models.list': () => [HUGE],
    'models.calculate': () => {
      throw new RpcError(RpcErrorCode.MethodNotFound, 'Unknown method models.calculate');
    },
    'providers.refresh': () => [status('gpu')],
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'huge options' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Calculate context' }));
  expect(await screen.findByText(/huge: Its weights are 42\.9 GB/)).toBeTruthy();
  expect(callsTo('providers.refresh')).toEqual([{ id: 'gpu' }]);
});

it('tells a model of a provider without a memory budget to set one, without asking the server', async () => {
  resetBackend({ 'settings.get': () => snapshot({ providers: [{ ...GPU, vramGiB: undefined }] }), 'models.list': () => [model('gpu', 'plain')] });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'plain options' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Calculate context' }));
  expect(await screen.findByText('No memory budget for GPU')).toBeTruthy();
  expect(callsTo('models.calculate')).toEqual([]);
});

it('keeps the plain label for a server that sends no calculation state', async () => {
  resetBackend({ 'settings.get': () => snapshot({ providers: [GPU] }), 'models.list': () => [model('gpu', 'old')] });
  renderPage();
  const label = await screen.findByText('Not calculated');
  expect(label.getAttribute('title')).toContain('update it to see the reason');
});
