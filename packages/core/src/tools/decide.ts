/**
 * Decide (ARCHITECTURE §28): the assistant hands many texts to the decision model and gets for each the likeliest
 * answer to its questions, a tenth of a second apiece, without reading them itself. For triage and filtering: which
 * of 300 issues are bugs, which emails need an answer today, which search results are about the question.
 */
import { DecideInput, type DecideResult, type DecisionAnswer, type DecisionQuestion } from '@atelier/protocol';
import { textOutput, type Tool } from './types.ts';

export interface DecideToolDeps {
  decide(input: DecideInput, signal: AbortSignal): Promise<DecideResult>;
}

interface Input {
  text?: string;
  items?: string[];
  questions: { name?: string; type: 'yesno' | 'choice' | 'score'; question: string; options?: string[] }[];
}

/** Most items one call sorts, and how many go to the decision model at once. */
export const DECIDE_MAX_ITEMS = 200;
const AT_ONCE = 6;
/** An item longer than this is cut: the decision model reads its start. */
const ITEM_CHARS = 20_000;

const DESCRIPTION = [
  'Sorts or judges texts with the decision model: for each text it answers your questions with the likeliest option and its probability, in about a tenth of a second per text, without you reading them.',
  '- Use it to triage or filter many things at once (issues, emails, log lines, search results, files, rows): pass them as `items`, up to 200, and read only the ones that matter yourself. For one text, pass `text`.',
  '- Each question is `yesno` (answered with the probability of yes), `choice` (one of `options`), or `score` (a level among `options`, lowest first). An option can say what it means after a colon: "bug: something that worked and broke".',
  '- Up to 8 questions per call; they all apply to every item. Write each question so it can be answered from the item alone.',
  '- It answers only with options and probabilities, never with text or reasons. A probability near 0.5 means it isn’t sure: look at those yourself.',
].join('\n');

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** One answer in a few words: "topic: billing 93%", "spam: yes 88%", "urgency: high (2 of 0-2, 1.7)". */
function brief(a: DecisionAnswer, q: DecisionQuestion): string {
  if (a.type === 'refusal') return `${a.name}: no answer`;
  if (a.type === 'yesno') return `${a.name}: ${a.probability >= 0.5 ? 'yes' : 'no'} ${pct(a.probability >= 0.5 ? a.probability : 1 - a.probability)}`;
  if (a.type === 'choice') return `${a.name}: ${a.choice} ${pct(a.probabilities.find((p) => p.value === a.choice)?.probability ?? 0)}`;
  const levels = q.options?.length ?? a.probabilities.length;
  return `${a.name}: ${a.probabilities[a.level]?.value ?? a.level} (${a.level} of 0-${levels - 1}, ${a.score.toFixed(1)})`;
}

/** Every option's probability, for a single text. */
function full(a: DecisionAnswer, q: DecisionQuestion): string {
  if (a.type === 'refusal') return `${a.name}: the decision model didn’t answer this one.`;
  if (a.type === 'yesno') return `${a.name} (${q.instructions}): yes ${pct(a.probability)}`;
  const rows = a.probabilities.map((p) => `  ${p.value}: ${pct(p.probability)}`).join('\n');
  if (a.type === 'choice') return `${a.name} (${q.instructions}): ${a.choice}${a.confidence === null ? '' : `, confidence ${pct(a.confidence)}`}\n${rows}`;
  return `${a.name} (${q.instructions}): level ${a.level}, expected ${a.score.toFixed(2)}${a.confidence === null ? '' : `, confidence ${pct(a.confidence)}`}\n${rows}`;
}

/** An option given as "name: what it means". */
function option(text: string): { value: string; description?: string } {
  const at = text.indexOf(':');
  if (at > 0 && at <= 60) return { value: text.slice(0, at).trim(), description: text.slice(at + 1).trim() };
  return { value: text.trim() };
}

const excerpt = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

export function createDecideTool(deps: DecideToolDeps): Tool<Input> {
  return {
    name: 'Decide',
    readOnly: true,
    concurrent: true,
    description: DESCRIPTION,
    compactExample: { items: ['<text>', '<text>'], questions: [{ type: 'choice', question: '<question>?', options: ['<option>', '<option>'] }] },
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', maxItems: DECIDE_MAX_ITEMS, items: { type: 'string', minLength: 1 }, description: 'The texts to judge, each on its own (up to 200).' },
        text: { type: 'string', minLength: 1, description: 'One text to judge, instead of `items`.' },
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,40}$', description: 'A short name for the answer ("topic"); q1, q2… when absent.' },
              type: { type: 'string', enum: ['yesno', 'choice', 'score'] },
              question: { type: 'string', minLength: 1, maxLength: 2000 },
              options: { type: 'array', minItems: 2, maxItems: 26, items: { type: 'string', minLength: 1, maxLength: 300 }, description: 'choice: the options; score: the levels, lowest first. Not for yesno.' },
            },
            required: ['type', 'question'],
          },
        },
      },
      required: ['questions'],
    },
    async run(input, ctx) {
      const items = input.items?.length ? input.items : input.text ? [input.text] : [];
      if (!items.length) return textOutput('Give the texts to judge as `items`, or one as `text`.', true);
      if (items.length > DECIDE_MAX_ITEMS) return textOutput(`At most ${DECIDE_MAX_ITEMS} items per call: split them.`, true);
      const questions: DecisionQuestion[] = input.questions.map((q, i) => ({
        name: q.name ?? `q${i + 1}`,
        type: q.type,
        instructions: q.question,
        ...(q.type === 'yesno' ? {} : { options: (q.options ?? []).map(option) }),
      }));
      const checked = DecideInput.safeParse({ state: 'x', questions });
      if (!checked.success) return textOutput(checked.error.issues.map((i) => i.message).join(' '), true);
      const results: (DecideResult | Error)[] = new Array(items.length);
      let next = 0;
      const worker = async () => {
        while (next < items.length && !ctx.signal.aborted) {
          const i = next++;
          const text = items[i]!;
          results[i] = await deps.decide({ state: text.length > ITEM_CHARS ? text.slice(0, ITEM_CHARS) : text, questions }, ctx.signal).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
        }
      };
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));
      if (ctx.signal.aborted) return textOutput('Stopped.', true);
      const answered = results.filter((r): r is DecideResult => !(r instanceof Error));
      const first = answered[0];
      if (!first) return textOutput(`The decision model failed: ${(results[0] as Error).message}`, true);
      const by = (name: string) => questions.find((q) => q.name === name)!;
      const footer = `${first.source.label} (${first.source.provider})`;
      if (items.length === 1) return textOutput(`${first.answers.map((a) => full(a, by(a.name))).join('\n')}\n\nDecided by ${footer} in ${first.ms} ms.`);
      // Many items: a count per option first, so the shape of the whole is clear, then one line per item.
      const counts = questions
        .filter((q) => q.type !== 'score')
        .map((q) => {
          const tally = new Map<string, number>();
          for (const r of answered) {
            const a = r.answers.find((x) => x.name === q.name);
            const key = a?.type === 'choice' ? a.choice : a?.type === 'yesno' ? (a.probability >= 0.5 ? 'yes' : 'no') : 'no answer';
            tally.set(key, (tally.get(key) ?? 0) + 1);
          }
          return `${q.name}: ${[...tally].map(([k, n]) => `${k} ${n}`).join(', ')}`;
        });
      const rows = results.map((r, i) => `${i + 1}. ${excerpt(items[i]!)}\n   ${r instanceof Error ? `failed: ${r.message}` : r.answers.map((a) => brief(a, by(a.name))).join(' · ')}`);
      const failed = results.length - answered.length;
      return textOutput([`${answered.length} of ${items.length} decided by ${footer}${failed ? `, ${failed} failed` : ''}.`, ...counts, '', ...rows].join('\n'));
    },
  };
}
