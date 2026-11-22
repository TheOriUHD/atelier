/**
 * The Decide window's form: a text, and up to eight questions about it. It is checked here the way the backend's schema
 * checks it (`DecideInput`), so a mistake shows next to the question it is in, before anything is sent.
 */
import { DECISION_MAX_LEVELS, DECISION_MAX_OPTIONS, DecideInput, type DecisionQuestionType } from '@atelier/protocol';

/** Questions one Decide window holds; the backend takes more, from the CLI and the Decide tool. */
export const MAX_QUESTIONS_HERE = 8;
/** The longest text the backend takes. */
export const MAX_STATE = 400_000;

export interface OptionDraft {
  /** Stable for React while rows are added and removed. */
  key: number;
  value: string;
  description: string;
  /** The description field is open. */
  described: boolean;
}

export interface QuestionDraft {
  key: number;
  type: DecisionQuestionType;
  instructions: string;
  /** Kept while the question is a yes or no, so switching back finds them again; only sent for a choice or a score. */
  options: OptionDraft[];
}

export interface DecideForm {
  state: string;
  questions: QuestionDraft[];
}

let nextKey = 1;
const key = () => nextKey++;

export const newOption = (value = ''): OptionDraft => ({ key: key(), value, description: '', described: false });

export function newQuestion(type: DecisionQuestionType = 'yesno'): QuestionDraft {
  return { key: key(), type, instructions: '', options: type === 'yesno' ? [] : [newOption(), newOption()] };
}

export const newDecideForm = (): DecideForm => ({ state: '', questions: [newQuestion()] });

/** A choice or a score needs rows to fill in: two empty ones when it has none yet. */
export function withType(question: QuestionDraft, type: DecisionQuestionType): QuestionDraft {
  const options = type !== 'yesno' && question.options.length === 0 ? [newOption(), newOption()] : question.options;
  return { ...question, type, options };
}

/** The rows that say something: a row left empty is not an option. */
const filled = (q: QuestionDraft) => q.options.filter((o) => o.value.trim() || o.description.trim());

export interface DecideErrors {
  state?: string;
  /** By question key. */
  questions: Record<number, { instructions?: string; options?: string }>;
  /** Anything the checks above missed, in the backend schema's words. */
  general?: string;
}

export const hasErrors = (errors: DecideErrors): boolean => !!errors.state || !!errors.general || Object.keys(errors.questions).length > 0;

export function validateDecideForm(form: DecideForm): DecideErrors {
  const errors: DecideErrors = { questions: {} };
  if (!form.state.trim()) errors.state = 'Write or paste what to decide about.';
  else if (form.state.length > MAX_STATE) errors.state = `That is too long: up to ${MAX_STATE.toLocaleString('en-US')} characters.`;
  for (const q of form.questions) {
    const problem: { instructions?: string; options?: string } = {};
    if (!q.instructions.trim()) problem.instructions = 'Write the question.';
    else if (q.instructions.trim().length > 20_000) problem.instructions = 'The question is too long: up to 20,000 characters.';
    if (q.type !== 'yesno') {
      const rows = filled(q);
      const noun = q.type === 'score' ? 'level' : 'option';
      const values = rows.map((o) => o.value.trim());
      if (values.some((v) => !v)) problem.options = `Give every ${noun} with a description a name too.`;
      else if (q.type === 'choice' && rows.length < 2) problem.options = 'A choice needs at least two options.';
      else if (q.type === 'choice' && rows.length > DECISION_MAX_OPTIONS) problem.options = `A choice has up to ${DECISION_MAX_OPTIONS} options.`;
      else if (q.type === 'score' && (rows.length < 2 || rows.length > DECISION_MAX_LEVELS)) problem.options = `A score needs 2 to ${DECISION_MAX_LEVELS} levels.`;
      else if (new Set(values).size !== values.length) problem.options = `Two ${noun}s have the same name.`;
      else if (values.some((v) => v.length > 200)) problem.options = `${q.type === 'score' ? 'A level' : 'An option'}’s name is up to 200 characters.`;
      else if (rows.some((o) => o.description.trim().length > 4000)) problem.options = 'A description is up to 4,000 characters.';
    }
    if (problem.instructions || problem.options) errors.questions[q.key] = problem;
  }
  if (!hasErrors(errors)) {
    const parsed = DecideInput.safeParse(toDecideInput(form));
    if (!parsed.success) errors.general = parsed.error.issues[0]?.message ?? 'Something in the questions is not right.';
  }
  return errors;
}

/** What `decisions.decide` gets: the questions named q1, q2… in their order, empty rows left out. */
export function toDecideInput(form: DecideForm, source?: string): DecideInput {
  return {
    state: form.state,
    questions: form.questions.map((q, i) => ({
      name: `q${i + 1}`,
      type: q.type,
      instructions: q.instructions.trim(),
      ...(q.type === 'yesno' ? {} : { options: filled(q).map((o) => (o.description.trim() ? { value: o.value.trim(), description: o.description.trim() } : { value: o.value.trim() })) }),
    })),
    ...(source ? { source } : {}),
  };
}
