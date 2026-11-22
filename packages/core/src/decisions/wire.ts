/**
 * The two request formats of decision models (ARCHITECTURE §28), turned into one shape. System One (TypeSafe's, copied by
 * Ollama, llama.cpp, OpenRouter, Requesty and others) takes questions as a map with `criteria`; OpenAI's Decisions API
 * takes a list with `choices` and `levels`. Both answer with probabilities and nothing written.
 */
import type { DecisionAnswer, DecisionQuestion, DecisionState } from '@atelier/protocol';

export type DecisionDialect = 'systemone' | 'openai-decisions';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** System One's question for ours. */
function systemOneQuestion(q: DecisionQuestion): Record<string, unknown> {
  if (q.type === 'yesno') {
    const criteria = q.yes || q.no ? { true: q.yes ?? null, false: q.no ?? null } : undefined;
    return { type: 'noul', instructions: q.instructions, ...(criteria ? { criteria } : {}) };
  }
  const options = q.options ?? [];
  if (q.type === 'choice') return { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(options.map((o) => [o.value, o.description ?? null])) };
  // A level's name and its meaning in one line: System One's levels are a list of descriptions.
  return { type: 'score', instructions: q.instructions, criteria: options.map((o) => (o.description ? `${o.value}: ${o.description}` : o.value)) };
}

/** The body of `POST /v1/systemone`. Ollama alone takes `keep_alive`; the others ignore fields they don't know. */
export function systemOneBody(model: string, state: DecisionState, questions: readonly DecisionQuestion[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model, state, questions: Object.fromEntries(questions.map((q) => [q.name, systemOneQuestion(q)])), ...extra };
}

/** The body of OpenAI's `POST /v1/decisions`: its input is text, so a JSON state goes as JSON text. */
export function openAiBody(model: string, state: DecisionState, questions: readonly DecisionQuestion[]): Record<string, unknown> {
  return {
    model,
    input: typeof state === 'string' ? state : JSON.stringify(state),
    questions: questions.map((q) => {
      if (q.type === 'yesno') {
        const meaning = [q.yes ? `Yes means: ${q.yes}` : '', q.no ? `No means: ${q.no}` : ''].filter(Boolean).join('\n');
        return { type: 'predicate', name: q.name, instructions: meaning ? `${q.instructions}\n${meaning}` : q.instructions };
      }
      const options = q.options ?? [];
      if (q.type === 'choice') return { type: 'choice', name: q.name, instructions: q.instructions, choices: options.map((o) => ({ value: o.value, ...(o.description ? { description: o.description } : {}) })) };
      return { type: 'score', name: q.name, instructions: q.instructions, levels: options.map((o) => ({ label: o.value, ...(o.description ? { description: o.description } : {}) })) };
    }),
  };
}

export class DecisionWireError extends Error {}

/** Probabilities as the question lists its options; a missing one is 0. */
function ordered(options: readonly string[], probability: (value: string, index: number) => number | undefined) {
  return options.map((value, i) => ({ value, probability: probability(value, i) ?? 0 }));
}

const likeliest = (list: readonly { value: string; probability: number }[]) => list.reduce((best, p, i) => (p.probability > list[best]!.probability ? i : best), 0);

/** One answer of either format in ours; a refusal or an answer of the wrong type is a refusal. */
function answer(q: DecisionQuestion, raw: unknown, dialect: DecisionDialect): DecisionAnswer {
  const a = isRecord(raw) ? raw : {};
  const type = str(a.type);
  const refusal: DecisionAnswer = { type: 'refusal', name: q.name };
  const options = (q.options ?? []).map((o) => o.value);
  if (q.type === 'yesno') {
    const p = num(dialect === 'systemone' ? a.noul : a.probability);
    return p === undefined ? refusal : { type: 'yesno', name: q.name, probability: clamp(p) };
  }
  if (type !== q.type) return refusal;
  const confidence = num(a.confidence) ?? null;
  // System One: probabilities by option name (a choice) or by level number (a score); OpenAI: a list of values.
  const map = isRecord(a.probabilities) ? a.probabilities : null;
  const list = Array.isArray(a.probabilities) ? a.probabilities.filter(isRecord) : null;
  if (q.type === 'choice') {
    const probabilities = ordered(options, (value) => (map ? num(map[value]) : num(list?.find((p) => String(p.value) === value)?.probability)));
    const choice = str(a.choice) ?? (typeof a.choice === 'boolean' ? String(a.choice) : undefined);
    const chosen = choice && options.includes(choice) ? choice : probabilities[likeliest(probabilities)]?.value;
    return chosen ? { type: 'choice', name: q.name, choice: chosen, confidence, probabilities } : refusal;
  }
  const probabilities = ordered(options, (_value, i) => (map ? num(map[String(i)]) : num(list?.find((p) => p.value === i)?.probability)));
  const score = num(a.score) ?? probabilities.reduce((sum, p, i) => sum + p.probability * i, 0);
  return { type: 'score', name: q.name, score, level: likeliest(probabilities), confidence, probabilities };
}

const clamp = (p: number) => Math.min(1, Math.max(0, p));

export interface ParsedDecision {
  answers: DecisionAnswer[];
  model: string | undefined;
  usage: { inputTokens: number; outputTokens: number };
}

/** A service's answer in ours, in the questions' order. Throws when it isn't an answer at all. */
export function parseDecision(json: unknown, questions: readonly DecisionQuestion[], dialect: DecisionDialect): ParsedDecision {
  if (!isRecord(json)) throw new DecisionWireError('The decision service sent something that isn’t an answer.');
  const raw = json.answers;
  // System One: a map by question name; OpenAI: a list in the questions' order, each with its name.
  const byName = isRecord(raw) ? raw : Array.isArray(raw) ? Object.fromEntries(raw.filter(isRecord).map((a, i) => [str(a.name) ?? questions[i]?.name ?? '', a])) : null;
  if (!byName) throw new DecisionWireError('The decision service’s answer has no answers.');
  const usage = isRecord(json.usage) ? json.usage : {};
  return {
    answers: questions.map((q) => answer(q, byName[q.name], dialect)),
    model: str(json.model),
    usage: { inputTokens: Math.round(num(usage.input_tokens) ?? 0), outputTokens: Math.round(num(usage.output_tokens) ?? 0) },
  };
}

/** The service's own words for a failed request, when it sent any. */
export function errorText(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const e = json.error;
  if (typeof e === 'string') return e;
  if (isRecord(e)) return str(e.message) ?? str(e.detail);
  return str(json.detail) ?? str(json.message);
}
