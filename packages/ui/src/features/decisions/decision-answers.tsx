/** A decision model's answers, as the Decide window shows them: a bar for each probability, the likeliest one marked. */
import type { DecideInput, DecideResult, DecisionAnswer } from '@atelier/protocol';
import { cn } from '../../components/ui/index.ts';

const clamp = (p: number) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0);

/** "92%", and "<1%" or ">99%" for what rounding would make look certain. */
export function percent(p: number): string {
  const v = clamp(p);
  if (v > 0 && v < 0.005) return '<1%';
  if (v < 1 && v > 0.995) return '>99%';
  return `${Math.round(v * 100)}%`;
}

function Meter({ label, value, strong, className }: { label: string; value: number; strong?: boolean; className?: string }) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp(value) * 100)}
      aria-valuetext={percent(value)}
      className={cn('h-2 min-w-0 overflow-hidden rounded-full bg-progress-track', className)}
    >
      <div className={cn('h-full rounded-full', strong ? 'bg-interactive' : 'bg-line-stronger')} style={{ width: `${clamp(value) * 100}%` }} />
    </div>
  );
}

/** One option or level: its name, its bar, its percentage; the likeliest one stands out. */
function Bar({ label, value, strong }: { label: string; value: number; strong: boolean }) {
  return (
    <li className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_3rem] items-center gap-3 max-md:grid-cols-[minmax(0,7rem)_minmax(0,1fr)_3rem]">
      <span title={label} className={cn('truncate text-body', strong ? 'font-medium text-fg' : 'text-fg-secondary')}>
        {label}
      </span>
      <Meter label={label} value={value} strong={strong} />
      <span className={cn('text-right text-body tabular-nums', strong ? 'font-medium text-fg' : 'text-fg-secondary')}>{percent(value)}</span>
    </li>
  );
}

function Confidence({ value }: { value: number | null }) {
  return value == null ? null : <p className="text-footnote text-fg-muted">Confidence {percent(value)}</p>;
}

/** "1.7" or "2": an expected level with one decimal at most. */
const level = (n: number) => (Math.round(n * 10) / 10).toString();

export function AnswerView({ answer }: { answer: DecisionAnswer }) {
  switch (answer.type) {
    case 'yesno':
      return (
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-body font-medium text-fg tabular-nums">Yes, {percent(answer.probability)}</span>
          <Meter label="Probability of yes" value={answer.probability} strong className="flex-1" />
        </div>
      );
    case 'choice':
      return (
        <div className="flex flex-col gap-2">
          <ul aria-label="Options" className="flex flex-col gap-1.5">
            {answer.probabilities.map((p) => (
              <Bar key={p.value} label={p.value} value={p.probability} strong={p.value === answer.choice} />
            ))}
          </ul>
          <Confidence value={answer.confidence} />
        </div>
      );
    case 'score':
      return (
        <div className="flex flex-col gap-2">
          <ul aria-label="Levels" className="flex flex-col gap-1.5">
            {answer.probabilities.map((p, i) => (
              <Bar key={p.value} label={p.value} value={p.probability} strong={i === answer.level} />
            ))}
          </ul>
          <p className="text-footnote text-fg-muted">
            Expected level {level(answer.score)} of 0–{Math.max(0, answer.probabilities.length - 1)}
            {answer.confidence != null && ` · Confidence ${percent(answer.confidence)}`}
          </p>
        </div>
      );
    case 'refusal':
      return <p className="text-body text-fg-muted">The model didn’t answer this one.</p>;
  }
}

/** Each question as it was asked, its answer, then who answered and how long it took. */
export function DecisionAnswers({ input, result }: { input: DecideInput; result: DecideResult }) {
  const asked = new Map(input.questions.map((q) => [q.name, q]));
  const tokens = result.usage.inputTokens;
  return (
    <section aria-label="Answers" className="flex flex-col gap-4">
      {result.answers.map((answer, i) => (
        <div key={answer.name} className="flex flex-col gap-2">
          <h3 className="text-body-strong text-fg">{asked.get(answer.name)?.instructions ?? `Question ${i + 1}`}</h3>
          <AnswerView answer={answer} />
        </div>
      ))}
      <p className="text-footnote text-fg-muted">
        {[result.model, result.source.provider, `${Math.round(result.ms)} ms`, `${tokens.toLocaleString()} input token${tokens === 1 ? '' : 's'}`].join(' · ')}
      </p>
    </section>
  );
}
