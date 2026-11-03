import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultUserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, model, resetBackend, snapshot } from '../settings/test-backend.ts';
import { ModelPicker } from './model-picker.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const A = model('fake', 'alpha');
const B = model('fake', 'beta');

/** The menu is controlled by its page, as in every session view. */
function Picker({ onPick }: { onPick(ref: string): void }) {
  const [open, setOpen] = useState(false);
  return <ModelPicker model={A} mode="chat" effort={null} onModelChange={onPick} onEffortChange={() => {}} open={open} onOpenChange={setOpen} />;
}

async function pickB(prefs = defaultUserPrefs()) {
  resetBackend({ 'settings.get': () => snapshot(), 'models.list': () => [A, B], 'prefs.get': () => prefs, 'prefs.set': () => prefs });
  const picked: string[] = [];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })}>
      <TooltipProvider>
        <Picker onPick={(ref) => picked.push(ref)} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /alpha/ }));
  const option = await screen.findByRole('menuitemradio', { name: /beta/ });
  fireEvent.click(option);
  await waitFor(() => expect(picked).toEqual(['fake/beta']));
}

describe('the model picker remembers the last model', () => {
  it('saves a pick as the model new conversations start with', async () => {
    await pickB();
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['models', 'chat'], value: 'fake/beta' }]));
  });

  it('leaves the preference alone when the person turned that off', async () => {
    const prefs = defaultUserPrefs();
    prefs.models = { ...prefs.models, rememberLast: false };
    await pickB(prefs);
    expect(callsTo('prefs.set')).toEqual([]);
  });
});
