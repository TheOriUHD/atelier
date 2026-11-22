/**
 * Decision models (ARCHITECTURE §28): models that don't write. They read a text and answer typed questions about it
 * (yes or no, one of a few options, a level on a scale) with a probability for each answer, in a tenth of a second.
 * Two request formats exist: TypeSafe's System One (`POST /v1/systemone`, which Ollama, llama.cpp, OpenRouter and
 * others copy) and OpenAI's Decisions API (`POST /v1/decisions`). The backend speaks both and hands out one shape.
 */
import { z } from 'zod';

/** Yes or no (System One's `noul`, OpenAI's `predicate`), one of a few options, or a level on an ordered scale. */
export const DecisionQuestionType = z.enum(['yesno', 'choice', 'score']);
export type DecisionQuestionType = z.infer<typeof DecisionQuestionType>;

/** An option of a choice, or a level of a score (lowest first). */
export const DecisionOption = z.object({
  value: z.string().trim().min(1).max(200),
  /** What the option means, for the model; the value alone when absent. */
  description: z.string().max(4000).optional(),
});
export type DecisionOption = z.infer<typeof DecisionOption>;

/** Most options one choice may have, and levels one score may have, across the services. */
export const DECISION_MAX_OPTIONS = 255;
export const DECISION_MAX_LEVELS = 10;
export const DECISION_MAX_QUESTIONS = 64;

export const DecisionQuestion = z
  .object({
    /** Its answer comes back under this name; unique in a request. */
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'A question name is up to 100 letters, digits, ".", "_" or "-".'),
    type: DecisionQuestionType,
    /** The question, in words. */
    instructions: z.string().trim().min(1).max(20_000),
    /** A choice's options, or a score's levels from lowest to highest. */
    options: z.array(DecisionOption).max(DECISION_MAX_OPTIONS).optional(),
    /** Yes or no: what each answer means, when the question alone leaves it open. */
    yes: z.string().max(4000).optional(),
    no: z.string().max(4000).optional(),
  })
  .superRefine((q, ctx) => {
    const options = q.options ?? [];
    if (q.type === 'choice' && options.length < 2) ctx.addIssue({ code: 'custom', message: 'A choice needs at least two options.', path: ['options'] });
    if (q.type === 'score' && (options.length < 2 || options.length > DECISION_MAX_LEVELS))
      ctx.addIssue({ code: 'custom', message: `A score needs 2 to ${DECISION_MAX_LEVELS} levels.`, path: ['options'] });
    if (q.type === 'yesno' && options.length) ctx.addIssue({ code: 'custom', message: 'A yes-or-no question has no options.', path: ['options'] });
    if (new Set(options.map((o) => o.value)).size !== options.length) ctx.addIssue({ code: 'custom', message: 'Two options have the same name.', path: ['options'] });
  });
export type DecisionQuestion = z.infer<typeof DecisionQuestion>;

/** What to decide about: text, or a JSON value (an email with its fields, a list of results). */
export const DecisionState = z.union([z.string().max(400_000), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
export type DecisionState = z.infer<typeof DecisionState>;

export const DecideInput = z
  .object({
    state: DecisionState,
    questions: z.array(DecisionQuestion).min(1).max(DECISION_MAX_QUESTIONS),
    /** A source's id (`decisions.status`); absent uses the backend's decision model. Admins only. */
    source: z.string().max(400).optional(),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.questions.map((q) => q.name)).size !== input.questions.length) ctx.addIssue({ code: 'custom', message: 'Two questions have the same name.', path: ['questions'] });
  });
export type DecideInput = z.infer<typeof DecideInput>;

const Name = z.string();
export const DecisionAnswer = z.discriminatedUnion('type', [
  /** The probability of yes. */
  z.object({ type: z.literal('yesno'), name: Name, probability: z.number() }),
  z.object({
    type: z.literal('choice'),
    name: Name,
    /** The likeliest option. */
    choice: z.string(),
    /** How sure the model is (0 = no idea, 1 = certain); null when the service doesn't say. */
    confidence: z.number().nullable(),
    /** Every option's probability, in the question's order. */
    probabilities: z.array(z.object({ value: z.string(), probability: z.number() })),
  }),
  z.object({
    type: z.literal('score'),
    name: Name,
    /** The expected level (0 = lowest), a fraction: 1.7 leans to the third level of three. */
    score: z.number(),
    /** The likeliest level. */
    level: z.number().int(),
    confidence: z.number().nullable(),
    probabilities: z.array(z.object({ value: z.string(), probability: z.number() })),
  }),
  /** The service declined to answer this one. */
  z.object({ type: z.literal('refusal'), name: Name }),
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

/** A decision model the backend can ask: one model of one provider or service. */
export const DecisionSource = z.object({
  /** `text:<provider id>:<model>` for a model of a text provider, `service:<service id>:<model>` for a decision service. */
  id: z.string(),
  /** The model, as people know it. */
  label: z.string(),
  /** The provider's or service's name in Settings. */
  provider: z.string(),
  /** Runs on a server someone runs (Ollama, llama.cpp), not on a service that bills per request. */
  local: z.boolean(),
});
export type DecisionSource = z.infer<typeof DecisionSource>;

export const DecideResult = z.object({
  /** In the questions' order. */
  answers: z.array(DecisionAnswer),
  source: DecisionSource,
  /** The model that answered, as the service names it (`jev-1.14.0`). */
  model: z.string(),
  /** How long the service took, in milliseconds. */
  ms: z.number(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
});
export type DecideResult = z.infer<typeof DecideResult>;

/** How a decision service is spoken to. */
export const DecisionServiceType = z.enum(['systemone', 'openai-decisions']);
export type DecisionServiceType = z.infer<typeof DecisionServiceType>;

/**
 * A service added only for decisions (Settings › Admin › Decision models): TypeSafe, decisionmodels.io, or any server
 * that speaks System One. Models of text providers set up already (Ollama, llama.cpp, OpenAI, OpenRouter) need none.
 */
export const DecisionServiceConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(80),
  type: DecisionServiceType.default('systemone'),
  /** The address without `/v1` (`https://api.typesafe.ai`). */
  baseUrl: z.string().url(),
  /** Usually `${secret:<id>}`. */
  apiKey: z.string().optional(),
  /** Models to offer; absent asks the service for its list. */
  models: z.array(z.string().min(1).max(200)).max(50).optional(),
  /** The preset it was added from. */
  preset: z.string().max(40).optional(),
  enabled: z.boolean().default(true),
});
export type DecisionServiceConfig = z.infer<typeof DecisionServiceConfig>;

/** A service as the Settings form sends it: a new key in plain text (stored as a secret), or none to keep the saved one. */
export const DecisionServiceDraft = z.object({
  /** Absent for a new one. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  name: z.string().trim().min(1).max(80),
  type: DecisionServiceType.default('systemone'),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().trim().max(2000).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  preset: z.string().max(40).optional(),
});
export type DecisionServiceDraft = z.infer<typeof DecisionServiceDraft>;

export const DecisionServiceTest = z.object({
  ok: z.boolean(),
  /** The models it offers (listed by the service, or the ones typed in). */
  models: z.array(z.string()),
  /** A one-question decision's time, when it answered. */
  ms: z.number().optional(),
  error: z.string().optional(),
});
export type DecisionServiceTest = z.infer<typeof DecisionServiceTest>;

/** A service to add with a click: its address, format and the models it has. */
export interface DecisionServicePreset {
  key: string;
  name: string;
  type: DecisionServiceType;
  baseUrl: string;
  /** Where people get a key. */
  keyUrl?: string;
  /** Its models when it can't list them. */
  models?: string[];
  /** One line under the name. */
  help: string;
  /** Dollars per million input tokens (output is free on all of them), when known. */
  inputPrice?: number;
}

export const DECISION_SERVICE_PRESETS: readonly DecisionServicePreset[] = [
  {
    key: 'typesafe',
    name: 'TypeSafe Jev',
    type: 'systemone',
    baseUrl: 'https://api.typesafe.ai',
    keyUrl: 'https://console.typesafe.ai/keys',
    models: ['jev-latest'],
    help: 'Jev, the decision model this format comes from. About a tenth of a second; you pay for what it reads.',
    inputPrice: 0.042,
  },
  {
    key: 'decisionmodels',
    name: 'Decision Models',
    type: 'systemone',
    baseUrl: 'https://api.decisionmodels.io',
    keyUrl: 'https://decisionmodels.io/',
    models: ['s1-fast', 's1-pro'],
    help: 'Open-weight decision models in Jev’s format, with servers in the EU.',
  },
  {
    key: 'custom',
    name: 'Another System One server',
    type: 'systemone',
    baseUrl: '',
    help: 'Any server that answers POST /v1/systemone: llama.cpp’s llama-server, NVIDIA Dynamo, your own.',
  },
];

/** Auto mode's quick check by the decision model: none, side by side with the reviewer to compare, or approving. */
export const DecisionAutoMode = z.enum(['off', 'compare', 'approve']);
export type DecisionAutoMode = z.infer<typeof DecisionAutoMode>;

/** How the quick check compared with Auto mode's reviewer, in compare mode (and on the samples it checks in approve). */
export const DecisionComparison = z.object({
  /** Actions both looked at. */
  checked: z.number().int(),
  /** The decision model would have let it run, and the reviewer allowed it too. */
  bothAllowed: z.number().int(),
  /** The decision model would have let it run, and the reviewer did not: the number that matters. */
  wronglyAllowed: z.number().int(),
  /** The decision model left it to the reviewer. */
  leftToReviewer: z.number().int(),
  /** Actions the decision model let run on its own (approve). */
  approved: z.number().int(),
  /** Its usual answer time, in milliseconds. */
  medianMs: z.number().nullable(),
  /** Since when (epoch ms). */
  since: z.number(),
  /** The last few it would have let through and the reviewer stopped, so an admin can see what went wrong. */
  misses: z.array(z.object({ at: z.number(), tool: z.string(), summary: z.string(), verdict: z.string() })),
});
export type DecisionComparison = z.infer<typeof DecisionComparison>;

export const DecisionStatus = z.object({
  /** Off for everyone (Settings › Admin › Decision models). */
  enabled: z.boolean(),
  /** What decisions use now; null when nothing offers a decision model (or it's off). */
  source: DecisionSource.nullable(),
  /** Admins: every decision model to choose from. Others: none. */
  sources: z.array(DecisionSource),
  /** The admin's choice by id; null picks one by itself (a local model first). */
  chosen: z.string().nullable(),
  /** Admins: Auto mode's quick check measured against the reviewer. */
  comparison: DecisionComparison.optional(),
  /** Admins: a service or provider that couldn't be asked for its models, by name. */
  problems: z.array(z.object({ provider: z.string(), error: z.string() })).optional(),
  /** Admins: the providers set up here whose models can be named as the decision model (`text:<id>:<model>`). */
  providers: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});
export type DecisionStatus = z.infer<typeof DecisionStatus>;
