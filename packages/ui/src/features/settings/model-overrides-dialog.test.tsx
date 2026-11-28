import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
import { ModelOverridesDialog } from './model-overrides-dialog.tsx';
import { callsTo, model, resetBackend, snapshot } from './test-backend.ts';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('./test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const QWEN = model('gpu', 'qwen');

function renderDialog() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ModelOverridesDialog model={QWEN} open onOpenChange={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

it("saves a model's own system prompt, and clearing it removes the setting", async () => {
  resetBackend({ 'settings.get': () => snapshot({}), 'settings.set': () => snapshot(), 'settings.reset': () => snapshot() });
  renderDialog();
  const prompt = await screen.findByRole('textbox', { name: 'System prompt' });
  fireEvent.change(prompt, { target: { value: '  Answer in British English.\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(callsTo('settings.set')).toContainEqual({ layer: 'global', path: ['models', 'overrides', QWEN.ref, 'systemPrompt'], value: 'Answer in British English.' }),
  );
});

it('removes the prompt when the field is emptied', async () => {
  resetBackend({ 'settings.get': () => snapshot({ models: { defaults: {}, aliases: {}, overrides: { [QWEN.ref]: { systemPrompt: 'Old text.' } } } } as never), 'settings.set': () => snapshot(), 'settings.reset': () => snapshot() });
  renderDialog();
  const prompt = await screen.findByRole('textbox', { name: 'System prompt' });
  await waitFor(() => expect((prompt as HTMLTextAreaElement).value).toBe('Old text.'));
  fireEvent.change(prompt, { target: { value: '  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(callsTo('settings.reset')).toContainEqual({ layer: 'global', path: ['models', 'overrides', QWEN.ref, 'systemPrompt'] }));
});
