/**
 * The Decide window (ARCHITECTURE §28): anyone can put questions about a text to the decision model by hand and see
 * how likely each answer is. Reached from the sidebar's More, the command palette and Settings › Decision models.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import { DECISION_MAX_LEVELS, DECISION_MAX_OPTIONS, type DecideInput, type DecideResult, type DecisionQuestionType } from '@atelier/protocol';
import { Button, Dialog, DialogContent, Field, Icon, IconButton, Kbd, SegmentedControl, Select, TextArea, TextField, cn, type SelectOption } from '../../components/ui/index.ts';
import { isMac } from '../../lib/platform.ts';
import { useAccount, useDecisionStatus, useDecisionsOffered } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { DecisionAnswers } from './decision-answers.tsx';
import { MAX_QUESTIONS_HERE, hasErrors, newDecideForm, newOption, newQuestion, toDecideInput, validateDecideForm, withType, type DecideErrors, type DecideForm, type QuestionDraft } from './decide-form.ts';

/** The window can be offered: this backend has a decision model to ask. Asks `decisions.status` once the settings say it knows them. */
export function useDecideOffered(): boolean {
  const offered = useDecisionsOffered();
  const { data } = useDecisionStatus({ enabled: offered });
  return offered && !!data?.enabled && !!data.source;
}

const TYPES: { value: DecisionQuestionType; label: string }[] = [
  { value: 'yesno', label: 'Yes or no' },
  { value: 'choice', label: 'Pick one' },
  { value: 'score', label: 'Score' },
];

const PLACEHOLDERS: Record<DecisionQuestionType, string> = {
  yesno: 'Does it ask for a reply?',
  choice: 'What is it mostly about?',
  score: 'How urgent is it?',
};

/** The Select value for the backend's own decision model; source ids always have a colon. */
const USUAL = 'usual';

type Outcome = { state: 'idle' } | { state: 'deciding' } | { state: 'failed'; message: string } | { state: 'done'; input: DecideInput; result: DecideResult };

/** The form is kept while the window is closed, so it opens again on what was asked. */
export function DecideDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [form, setForm] = useState<DecideForm>(newDecideForm);
  const [attempted, setAttempted] = useState(false);
  const [chosen, setChosen] = useState(USUAL);
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });
  const run = useRef(0);
  // The answers come in below the questions, often under the window's fold: they are brought into view.
  const answers = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (outcome.state === 'done' || outcome.state === 'failed') answers.current?.scrollIntoView?.({ block: 'nearest' });
  }, [outcome]);
  const { data: status } = useDecisionStatus({ enabled: open });
  const { account } = useAccount();
  const admin = account?.role === 'admin';
  const sources = admin ? (status?.sources ?? []) : [];
  const source = chosen !== USUAL && sources.some((s) => s.id === chosen) ? chosen : undefined;
  const canDecide = !!status?.enabled && (!!status.source || !!source);
  const errors = validateDecideForm(form);
  const shown: DecideErrors = attempted ? errors : { questions: {} };
  const deciding = outcome.state === 'deciding';

  const decide = async () => {
    setAttempted(true);
    if (hasErrors(errors) || !canDecide || deciding) return;
    const input = toDecideInput(form, source);
    const id = ++run.current;
    setOutcome({ state: 'deciding' });
    try {
      const result = await rpc().call('decisions.decide', input);
      if (id === run.current) setOutcome({ state: 'done', input, result });
    } catch (e) {
      if (id === run.current) setOutcome({ state: 'failed', message: describeError(e).message });
    }
  };

  const setQuestion = (key: number, change: (q: QuestionDraft) => QuestionDraft) => setForm((f) => ({ ...f, questions: f.questions.map((q) => (q.key === key ? change(q) : q)) }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void decide();
  };

  const sourceOptions: SelectOption[] = [
    { value: USUAL, label: status?.source ? `${status.source.label} · ${status.source.provider}` : 'The usual one' },
    ...sources.filter((s) => s.id !== status?.source?.id).map((s) => ({ value: s.id, label: `${s.label} · ${s.provider}${s.local ? '' : ' · paid'}` })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Decide"
        description="Ask the decision model questions about a text. Each answer comes with how likely it is."
        width={640}
        onKeyDown={onKeyDown}
      >
        <div className="flex flex-col gap-4">
          <Field label="What to decide about" error={shown.state}>
            <TextArea
              autoFocus
              rows={5}
              value={form.state}
              placeholder="Paste an email, a message, a review…"
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
            />
          </Field>
          {form.questions.map((q, i) => (
            <QuestionCard
              key={q.key}
              index={i}
              question={q}
              removable={form.questions.length > 1}
              errors={shown.questions[q.key]}
              onChange={(change) => setQuestion(q.key, change)}
              onRemove={() => setForm((f) => ({ ...f, questions: f.questions.filter((other) => other.key !== q.key) }))}
            />
          ))}
          <div className="flex items-center gap-3">
            <Button size="sm" leadingIcon={Plus} disabled={form.questions.length >= MAX_QUESTIONS_HERE} onClick={() => setForm((f) => ({ ...f, questions: [...f.questions, newQuestion()] }))}>
              Add question
            </Button>
            {form.questions.length >= MAX_QUESTIONS_HERE && <span className="text-footnote text-fg-muted">Up to {MAX_QUESTIONS_HERE} questions here.</span>}
          </div>
        </div>
        {shown.general && (
          <p role="alert" className="mt-4 text-body text-danger-text">
            {shown.general}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {sourceOptions.length > 1 && (
            <Select aria-label="Decision model to ask" variant="field" className="w-64 max-w-full" options={sourceOptions} value={source ?? USUAL} onValueChange={setChosen} />
          )}
          {status && !canDecide && <span className="text-footnote text-fg-muted">There’s no decision model to ask right now.</span>}
          <Button variant="primary" className="ml-auto" loading={deciding} disabled={!canDecide} onClick={() => void decide()}>
            Decide
            <span aria-hidden className="flex items-center gap-1 max-md:hidden">
              <Kbd className="text-current/70">{isMac ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd className="text-current/70">{isMac ? '↵' : 'Enter'}</Kbd>
            </span>
          </Button>
        </div>
        <div ref={answers} aria-live="polite">
          {outcome.state === 'failed' && (
            <p role="alert" className="mt-4 text-body text-danger-text">
              {outcome.message}
            </p>
          )}
          {outcome.state === 'done' && (
            <div className="mt-6 border-t border-line-subtle pt-5">
              <DecisionAnswers input={outcome.input} result={outcome.result} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QuestionCard({
  index,
  question,
  removable,
  errors,
  onChange,
  onRemove,
}: {
  index: number;
  question: QuestionDraft;
  removable: boolean;
  errors: { instructions?: string; options?: string } | undefined;
  onChange(change: (q: QuestionDraft) => QuestionDraft): void;
  onRemove(): void;
}) {
  const heading = useId();
  const name = `Question ${index + 1}`;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id={heading} className="text-body-strong text-fg">
          {name}
        </h3>
        <SegmentedControl size="xs" aria-label={`${name} type`} items={TYPES} value={question.type} onValueChange={(type) => onChange((q) => withType(q, type))} className="ml-auto" />
        {removable && <IconButton icon={X} size="sm" label={`Remove ${name.toLowerCase()}`} onClick={onRemove} />}
      </div>
      <div className="flex flex-col gap-1.5">
        <TextField aria-label={name} placeholder={PLACEHOLDERS[question.type]} value={question.instructions} invalid={!!errors?.instructions} onChange={(e) => onChange((q) => ({ ...q, instructions: e.target.value }))} />
        {errors?.instructions && <p className="text-footnote text-danger-text">{errors.instructions}</p>}
      </div>
      {question.type !== 'yesno' && <OptionsEditor question={question} index={index} error={errors?.options} onChange={onChange} />}
    </section>
  );
}

/** A choice's options or a score's levels: a row each, with an optional description behind a small disclosure. */
function OptionsEditor({ question, index, error, onChange }: { question: QuestionDraft; index: number; error: string | undefined; onChange(change: (q: QuestionDraft) => QuestionDraft): void }) {
  const list = useId();
  const score = question.type === 'score';
  const noun = score ? 'level' : 'option';
  const max = score ? DECISION_MAX_LEVELS : DECISION_MAX_OPTIONS;
  const count = question.options.length;
  const setOption = (key: number, patch: Partial<QuestionDraft['options'][number]>) => onChange((q) => ({ ...q, options: q.options.map((o) => (o.key === key ? { ...o, ...patch } : o)) }));
  const placeholder = (i: number) => (score ? (i === 0 ? 'Lowest level' : i === count - 1 ? 'Highest level' : `Level ${i + 1}`) : `Option ${i + 1}`);
  return (
    <div className="flex flex-col gap-2">
      <span id={list} className="text-footnote text-fg-muted">
        {score ? 'Levels, lowest first' : 'Options'}
      </span>
      <ul aria-labelledby={list} className="flex flex-col gap-2">
        {question.options.map((o, i) => {
          const label = `Question ${index + 1}, ${noun} ${i + 1}`;
          return (
            <li key={o.key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <TextField aria-label={label} placeholder={placeholder(i)} value={o.value} className="flex-1" onChange={(e) => setOption(o.key, { value: e.target.value })} />
                <Button size="sm" variant="ghost" aria-expanded={o.described} aria-label={`Describe ${noun} ${i + 1}`} onClick={() => setOption(o.key, { described: !o.described })}>
                  <Icon icon={ChevronRight} size="sm" className={cn('transition-transform duration-(--at-duration-fast) ease-standard', o.described && 'rotate-90')} />
                  Describe
                  {/* A description stays when its field is closed: a dot says there is one. */}
                  {o.description.trim() && !o.described && <span aria-hidden className="size-1.5 rounded-full bg-interactive" />}
                </Button>
                <IconButton icon={X} size="sm" label={`Remove ${noun} ${i + 1}`} disabled={count <= 2} onClick={() => onChange((q) => ({ ...q, options: q.options.filter((other) => other.key !== o.key) }))} />
              </div>
              {o.described && (
                <TextField
                  autoFocus
                  aria-label={`Description of ${noun} ${i + 1}`}
                  placeholder="What it means, for the model"
                  value={o.description}
                  className="ml-4 w-auto"
                  onChange={(e) => setOption(o.key, { description: e.target.value })}
                />
              )}
            </li>
          );
        })}
      </ul>
      <div>
        <Button size="xs" variant="ghost" leadingIcon={Plus} disabled={count >= max} onClick={() => onChange((q) => ({ ...q, options: [...q.options, newOption()] }))}>
          Add {noun}
        </Button>
      </div>
      {error && <p className="text-footnote text-danger-text">{error}</p>}
    </div>
  );
}
