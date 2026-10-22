import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
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
