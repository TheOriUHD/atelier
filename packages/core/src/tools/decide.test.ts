import type { DecideInput, DecideResult } from '@atelier/protocol';
import { describe, expect, it } from 'vitest';
import { createDecideTool } from './decide.ts';
import type { ToolContext } from './types.ts';

const ctx = { signal: new AbortController().signal, sessionId: 's' } as unknown as ToolContext;
const source = { id: 'text:gpu:nimble', label: 'nimble', provider: 'Ollama', local: true };

/** Answers "bug" for texts with "crash", else "question"; urgent when it says "now". */
function fake(asked: DecideInput[] = []) {
  return createDecideTool({
    async decide(input) {
      asked.push(input);
      const text = String(input.state);
      const bug = text.includes('crash');
      return {
        answers: input.questions.map((q) =>
          q.type === 'choice'
            ? { type: 'choice' as const, name: q.name, choice: bug ? 'bug' : 'question', confidence: 0.8, probabilities: [{ value: 'bug', probability: bug ? 0.9 : 0.2 }, { value: 'question', probability: bug ? 0.1 : 0.8 }] }
            : q.type === 'yesno'
              ? { type: 'yesno' as const, name: q.name, probability: text.includes('now') ? 0.93 : 0.1 }
              : { type: 'score' as const, name: q.name, score: 1.6, level: 2, confidence: 0.5, probabilities: [{ value: 'low', probability: 0.1 }, { value: 'mid', probability: 0.2 }, { value: 'high', probability: 0.7 }] },
        ),
        source,
        model: 'nimble',
        ms: 110,
        usage: { inputTokens: 50, outputTokens: 0 },
      } satisfies DecideResult;
    },
  });
}

const text = (out: Awaited<ReturnType<ReturnType<typeof fake>['run']>>) => out.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

describe('Decide', () => {
  it('sorts many items with counts first and one line each', async () => {
    const asked: DecideInput[] = [];
    const out = await fake(asked).run(
      {
        items: ['The app crashes on start', 'How do I export?', 'It crashes now, fix it now'],
        questions: [
          { name: 'kind', type: 'choice', question: 'What is this?', options: ['bug: something broke', 'question'] },
          { name: 'urgent', type: 'yesno', question: 'Does it need an answer today?' },
        ],
      },
      ctx,
    );
    expect(asked).toHaveLength(3);
    expect(asked[0]!.questions[0]).toEqual({ name: 'kind', type: 'choice', instructions: 'What is this?', options: [{ value: 'bug', description: 'something broke' }, { value: 'question' }] });
    expect(text(out)).toBe(
      [
        '3 of 3 decided by nimble (Ollama).',
        'kind: bug 2, question 1',
        'urgent: no 2, yes 1',
        '',
        '1. The app crashes on start',
        '   kind: bug 90% · urgent: no 90%',
        '2. How do I export?',
        '   kind: question 80% · urgent: no 90%',
        '3. It crashes now, fix it now',
        '   kind: bug 90% · urgent: yes 93%',
      ].join('\n'),
    );
  });

  it('answers one text with every option’s probability', async () => {
    const out = await fake().run({ text: 'Is the export broken?', questions: [{ type: 'score', question: 'How urgent?', options: ['low', 'mid', 'high'] }] }, ctx);
    expect(text(out)).toContain('q1 (How urgent?): level 2, expected 1.60, confidence 50%\n  low: 10%\n  mid: 20%\n  high: 70%');
    expect(text(out)).toContain('Decided by nimble (Ollama) in 110 ms.');
  });

  it('refuses questions the decision model can’t take, and nothing to judge', async () => {
    expect((await fake().run({ text: 'x', questions: [{ type: 'choice', question: 'Which?', options: ['only'] }] }, ctx)).isError).toBe(true);
    expect(text(await fake().run({ questions: [{ type: 'yesno', question: 'Spam?' }] }, ctx))).toMatch(/Give the texts/);
  });

  it('says which items failed and keeps the rest', async () => {
    let n = 0;
    const tool = createDecideTool({
      async decide(input) {
        if (n++ === 1) throw new Error('Ollama answered 500.');
        return { answers: [{ type: 'yesno', name: input.questions[0]!.name, probability: 0.7 }], source, model: 'nimble', ms: 90, usage: { inputTokens: 5, outputTokens: 0 } };
      },
    });
    const out = text(await tool.run({ items: ['a', 'b', 'c'], questions: [{ type: 'yesno', question: 'Spam?' }] }, ctx));
    expect(out).toContain('2 of 3 decided by nimble (Ollama), 1 failed.');
    expect(out).toContain('failed: Ollama answered 500.');
  });
});
