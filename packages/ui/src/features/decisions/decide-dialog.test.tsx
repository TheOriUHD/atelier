import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RpcError, type DecideInput, type DecideResult, type DecisionSource, type DecisionStatus } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { backend, callsTo, resetBackend, snapshot, user } from '../settings/test-backend.ts';
import { DecideDialog } from './decide-dialog.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const nimble: DecisionSource = { id: 'text:ollama:nimble', label: 'nimble', provider: 'Ollama', local: true };
const jev: DecisionSource = { id: 'service:typesafe:jev-latest', label: 'jev-latest', provider: 'TypeSafe Jev', local: false };

const result = (answers: DecideResult['answers']): DecideResult => ({ answers, source: nimble, model: 'nimble-0.4', ms: 83.6, usage: { inputTokens: 1240, outputTokens: 0 } });

function renderDialog({ admin = false, status = { enabled: true, source: nimble, sources: admin ? [nimble, jev] : [], chosen: null } as DecisionStatus } = {}) {
  resetBackend({
    'account.get': () => user(admin ? {} : { role: 'user' }),
    'settings.get': () => snapshot(),
    'decisions.status': () => status,
    'decisions.decide': () => result([]),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <DecideDialog open onOpenChange={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return screen.findByRole('dialog', { name: 'Decide' });
}

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('the Decide window', () => {
  it('sends a yes-or-no, a choice with a description and a score, on Cmd/Ctrl+Enter', async () => {
    const dialog = within(await renderDialog());
    type(dialog.getByRole('textbox', { name: 'What to decide about' }), 'Hi Ada, the invoice is overdue. Can you pay by Friday?');
    type(dialog.getByRole('textbox', { name: 'Question 1' }), 'Does it ask for a reply?');

    // Each new question starts as a yes or no.
    fireEvent.click(dialog.getByRole('button', { name: 'Add question' }));
    const second = within(dialog.getByRole('region', { name: 'Question 2' }));
    fireEvent.click(second.getByRole('radio', { name: 'Pick one' }));
    type(second.getByRole('textbox', { name: 'Question 2' }), 'What is it about?');
    type(second.getByRole('textbox', { name: 'Question 2, option 1' }), 'Billing');
    type(second.getByRole('textbox', { name: 'Question 2, option 2' }), 'Support');
    const describe1 = second.getByRole('button', { name: 'Describe option 1' });
    expect(describe1.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(describe1);
    type(second.getByRole('textbox', { name: 'Description of option 1' }), 'Invoices and payments');

    fireEvent.click(dialog.getByRole('button', { name: 'Add question' }));
    const third = within(dialog.getByRole('region', { name: 'Question 3' }));
    fireEvent.click(third.getByRole('radio', { name: 'Score' }));
    expect(third.getByText('Levels, lowest first')).toBeTruthy();
    type(third.getByRole('textbox', { name: 'Question 3' }), 'How urgent is it?');
    type(third.getByRole('textbox', { name: 'Question 3, level 1' }), 'Low');
    type(third.getByRole('textbox', { name: 'Question 3, level 2' }), 'Medium');
    fireEvent.click(third.getByRole('button', { name: 'Add level' }));
    type(third.getByRole('textbox', { name: 'Question 3, level 3' }), 'High');

    fireEvent.keyDown(dialog.getByRole('textbox', { name: 'Question 3' }), { key: 'Enter', ctrlKey: true, metaKey: true });
    await waitFor(() =>
      expect(callsTo('decisions.decide')).toEqual<DecideInput[]>([
        {
          state: 'Hi Ada, the invoice is overdue. Can you pay by Friday?',
          questions: [
            { name: 'q1', type: 'yesno', instructions: 'Does it ask for a reply?' },
            { name: 'q2', type: 'choice', instructions: 'What is it about?', options: [{ value: 'Billing', description: 'Invoices and payments' }, { value: 'Support' }] },
            { name: 'q3', type: 'score', instructions: 'How urgent is it?', options: [{ value: 'Low' }, { value: 'Medium' }, { value: 'High' }] },
          ],
        },
      ]),
    );
    // People pick no other model: that is for admins.
    expect(dialog.queryByRole('combobox', { name: 'Decision model to ask' })).toBeNull();
  });

  it('shows each kind of answer, with who answered and how long it took', async () => {
    const dialog = within(await renderDialog());
    backend.handlers['decisions.decide'] = () =>
      result([
        { type: 'yesno', name: 'q1', probability: 0.92 },
        { type: 'choice', name: 'q2', choice: 'Billing', confidence: 0.81, probabilities: [{ value: 'Billing', probability: 0.88 }, { value: 'Support', probability: 0.12 }] },
        { type: 'score', name: 'q3', score: 1.7, level: 2, confidence: null, probabilities: [{ value: 'Low', probability: 0.05 }, { value: 'Medium', probability: 0.2 }, { value: 'High', probability: 0.75 }] },
        { type: 'refusal', name: 'q4' },
      ]);
    type(dialog.getByRole('textbox', { name: 'What to decide about' }), 'Overdue invoice');
    type(dialog.getByRole('textbox', { name: 'Question 1' }), 'Does it ask for a reply?');
    for (const [n, kind, text] of [[2, 'Pick one', 'Topic?'], [3, 'Score', 'Urgency?'], [4, 'Yes or no', 'Is it spam?']] as const) {
      fireEvent.click(dialog.getByRole('button', { name: 'Add question' }));
      const card = within(dialog.getByRole('region', { name: `Question ${n}` }));
      fireEvent.click(card.getByRole('radio', { name: kind }));
      type(card.getByRole('textbox', { name: `Question ${n}` }), text);
      if (kind !== 'Yes or no') {
        const noun = kind === 'Score' ? 'level' : 'option';
        type(card.getByRole('textbox', { name: `Question ${n}, ${noun} 1` }), 'A');
        type(card.getByRole('textbox', { name: `Question ${n}, ${noun} 2` }), 'B');
      }
    }
    fireEvent.click(dialog.getByRole('button', { name: 'Decide' }));

    const answers = within(await dialog.findByRole('region', { name: 'Answers' }));
    expect(answers.getByText('Yes, 92%')).toBeTruthy();
    expect(answers.getByRole('meter', { name: 'Probability of yes' }).getAttribute('aria-valuenow')).toBe('92');

    const options = within(answers.getByRole('list', { name: 'Options' }));
    expect(options.getByRole('meter', { name: 'Billing' }).getAttribute('aria-valuenow')).toBe('88');
    expect(options.getByText('Billing').className).toContain('font-medium');
    expect(options.getByText('Support').className).not.toContain('font-medium');
    expect(answers.getByText('Confidence 81%')).toBeTruthy();

    const levels = within(answers.getByRole('list', { name: 'Levels' }));
    expect(levels.getAllByRole('meter').map((m) => m.getAttribute('aria-valuenow'))).toEqual(['5', '20', '75']);
    expect(levels.getByText('High').className).toContain('font-medium');
    expect(answers.getByText('Expected level 1.7 of 0–2')).toBeTruthy();

    expect(answers.getByText('The model didn’t answer this one.')).toBeTruthy();
    expect(answers.getByText('Is it spam?')).toBeTruthy();
    expect(answers.getByText('nimble-0.4 · Ollama · 84 ms · 1,240 input tokens')).toBeTruthy();
  });

  it('says what is missing before asking, and the backend’s error in its words', async () => {
    const dialog = within(await renderDialog());
    const decide = dialog.getByRole('button', { name: 'Decide' });
    // Ready once it knows there is a decision model.
    await waitFor(() => expect(decide.hasAttribute('disabled')).toBe(false));
    fireEvent.click(decide);
    expect(dialog.getByText('Write or paste what to decide about.')).toBeTruthy();
    expect(dialog.getByText('Write the question.')).toBeTruthy();

    type(dialog.getByRole('textbox', { name: 'What to decide about' }), 'Overdue invoice');
    fireEvent.click(dialog.getByRole('radio', { name: 'Pick one' }));
    type(dialog.getByRole('textbox', { name: 'Question 1' }), 'Topic?');
    type(dialog.getByRole('textbox', { name: 'Question 1, option 1' }), 'Billing');
    type(dialog.getByRole('textbox', { name: 'Question 1, option 2' }), 'Billing');
    fireEvent.click(dialog.getByRole('button', { name: 'Decide' }));
    expect(dialog.getByText('Two options have the same name.')).toBeTruthy();
    expect(callsTo('decisions.decide')).toEqual([]);

    type(dialog.getByRole('textbox', { name: 'Question 1, option 2' }), 'Support');
    backend.handlers['decisions.decide'] = () => {
      throw new RpcError(-32000, 'Ollama didn’t answer: is it running?');
    };
    fireEvent.click(dialog.getByRole('button', { name: 'Decide' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('Ollama didn’t answer: is it running?');
  });

  it('lets an admin ask another decision model', async () => {
    const dialog = within(await renderDialog({ admin: true }));
    const picker = await dialog.findByRole('combobox', { name: 'Decision model to ask' });
    expect(picker.textContent).toContain('nimble · Ollama');
    fireEvent.click(picker);
    const option = await screen.findByRole('option', { name: 'jev-latest · TypeSafe Jev · paid' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    type(dialog.getByRole('textbox', { name: 'What to decide about' }), 'Overdue invoice');
    type(dialog.getByRole('textbox', { name: 'Question 1' }), 'Does it ask for a reply?');
    fireEvent.click(dialog.getByRole('button', { name: 'Decide' }));
    await waitFor(() => expect(callsTo('decisions.decide')).toEqual([expect.objectContaining({ source: jev.id })]));
  });

  it('can’t decide without a decision model', async () => {
    const dialog = within(await renderDialog({ status: { enabled: true, source: null, sources: [], chosen: null } }));
    expect(await dialog.findByText('There’s no decision model to ask right now.')).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'Decide' }).hasAttribute('disabled')).toBe(true);
  });
});
