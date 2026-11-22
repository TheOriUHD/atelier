import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionQuestion, DecisionServiceConfig, ProviderConfig } from '@atelier/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RequestScheduler } from '../providers/scheduler.ts';
import { actionSummary, quickAllows } from './auto-check.ts';
import { DecisionService } from './service.ts';
import { parseSourceId, pickAutomatic, targetFor } from './sources.ts';
import { openAiBody, parseDecision, systemOneBody } from './wire.ts';

const QUESTIONS: DecisionQuestion[] = [
  { name: 'spam', type: 'yesno', instructions: 'Is this spam?', yes: 'An unasked advert' },
  { name: 'topic', type: 'choice', instructions: 'What is it about?', options: [{ value: 'billing', description: 'Payments' }, { value: 'tech' }] },
  { name: 'urgency', type: 'score', instructions: 'How urgent?', options: [{ value: 'low' }, { value: 'mid' }, { value: 'high', description: 'Today' }] },
];

/** Ollama 0.40.17's answer to these questions, as it came from the real server (numbers shortened). */
const OLLAMA_ANSWER = {
  model: 'nimble',
  answers: {
    spam: { type: 'noul', noul: 0.12 },
    topic: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, tech: 0.1 }, confidence: 0.8 },
    urgency: { type: 'score', score: 1.7, legend: { '0': 'low', '1': 'mid', '2': 'high: Today' }, probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 }, confidence: 0.55 },
  },
  usage: { input_tokens: 422, output_tokens: 0 },
};

describe('the two formats', () => {
  it('asks System One with questions by name, criteria maps and level lists', () => {
    expect(systemOneBody('nimble', 'text', QUESTIONS, { keep_alive: '30m' })).toEqual({
      model: 'nimble',
      state: 'text',
      keep_alive: '30m',
      questions: {
        spam: { type: 'noul', instructions: 'Is this spam?', criteria: { true: 'An unasked advert', false: null } },
        topic: { type: 'choice', instructions: 'What is it about?', criteria: { billing: 'Payments', tech: null } },
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'mid', 'high: Today'] },
      },
    });
  });

  it('asks OpenAI with predicates, choices and levels in a list, a JSON state as text', () => {
    const body = openAiBody('gpt-6-luna', { subject: 'Refund' }, QUESTIONS) as { input: string; questions: unknown[] };
    expect(body.input).toBe('{"subject":"Refund"}');
    expect(body.questions).toEqual([
      { type: 'predicate', name: 'spam', instructions: 'Is this spam?\nYes means: An unasked advert' },
      { type: 'choice', name: 'topic', instructions: 'What is it about?', choices: [{ value: 'billing', description: 'Payments' }, { value: 'tech' }] },
      { type: 'score', name: 'urgency', instructions: 'How urgent?', levels: [{ label: 'low' }, { label: 'mid' }, { label: 'high', description: 'Today' }] },
    ]);
  });

  it('reads a System One answer in the questions’ order', () => {
    const parsed = parseDecision(OLLAMA_ANSWER, QUESTIONS, 'systemone');
    expect(parsed.model).toBe('nimble');
    expect(parsed.usage).toEqual({ inputTokens: 422, outputTokens: 0 });
    expect(parsed.answers).toEqual([
      { type: 'yesno', name: 'spam', probability: 0.12 },
      { type: 'choice', name: 'topic', choice: 'billing', confidence: 0.8, probabilities: [{ value: 'billing', probability: 0.9 }, { value: 'tech', probability: 0.1 }] },
      { type: 'score', name: 'urgency', score: 1.7, level: 2, confidence: 0.55, probabilities: [{ value: 'low', probability: 0.1 }, { value: 'mid', probability: 0.1 }, { value: 'high', probability: 0.8 }] },
    ]);
  });

  it('reads an OpenAI answer, with a refusal among them', () => {
    const parsed = parseDecision(
      {
        model: 'gpt-6-luna',
        answers: [
          { type: 'predicate', name: 'spam', probability: 0.95 },
          { type: 'refusal', name: 'topic' },
          { type: 'score', name: 'urgency', score: 1.1, confidence: 0.6, probabilities: [{ value: 0, label: 'low', probability: 0.1 }, { value: 1, label: 'mid', probability: 0.7 }, { value: 2, label: 'high', probability: 0.2 }] },
        ],
        usage: { input_tokens: 30, output_tokens: 3 },
      },
      QUESTIONS,
      'openai-decisions',
    );
    expect(parsed.answers[0]).toEqual({ type: 'yesno', name: 'spam', probability: 0.95 });
    expect(parsed.answers[1]).toEqual({ type: 'refusal', name: 'topic' });
    expect(parsed.answers[2]).toMatchObject({ type: 'score', score: 1.1, level: 1 });
  });

  it('refuses something that isn’t an answer', () => {
    expect(() => parseDecision({ error: 'x' }, QUESTIONS, 'systemone')).toThrow(/no answers/);
  });
});

const ollama: ProviderConfig = { id: 'gpu', type: 'ollama', name: 'Ollama on the GPU box', baseUrl: 'http://192.168.20.25:11434', enabled: true, headers: {} } as ProviderConfig;
const openai: ProviderConfig = { id: 'oai', type: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com', apiKey: '${secret:provider-oai}', enabled: true, headers: {} } as ProviderConfig;
const together: ProviderConfig = { id: 'together', type: 'openai-compatible', name: 'Together', baseUrl: 'https://api.together.xyz/v1', enabled: true, headers: {} } as ProviderConfig;
const lmstudio: ProviderConfig = { id: 'lms', type: 'openai-compatible', name: 'LM Studio', baseUrl: 'http://192.168.20.236:1234/v1', enabled: true, headers: {} } as ProviderConfig;
/** What every address of an LM Studio from before decision models answers. */
const UNEXPECTED = (path: string) => new Response(JSON.stringify({ error: `Unexpected endpoint or method. (POST ${path})` }), { status: 200 });
const typesafe: DecisionServiceConfig = { id: 'typesafe', name: 'TypeSafe Jev', type: 'systemone', baseUrl: 'https://api.typesafe.ai', apiKey: '${secret:decision-typesafe}', preset: 'typesafe', enabled: true };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(routes: Record<string, (body: unknown) => unknown>, calls: Call[] = []) {
  return async (url: string, init: RequestInit & { signal?: AbortSignal | null }) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body });
    const route = Object.keys(routes).find((r) => url.startsWith(r));
    if (!route) return new Response(JSON.stringify({ error: 'not here' }), { status: 404 });
    const answer = routes[route]!(body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const TAGS = {
  models: [
    { name: 'qwen3-8b:q4_k_m', capabilities: ['completion', 'tools'] },
    { name: 'tev1:latest', capabilities: ['decision'] },
    { name: 'nimble:latest', capabilities: ['decision'] },
  ],
};

function make(settings: { source?: string; services?: DecisionServiceConfig[]; text?: ProviderConfig[]; enabled?: boolean }, routes: Record<string, (body: unknown) => unknown>, calls: Call[] = [], extra: Partial<ConstructorParameters<typeof DecisionService>[0]> = {}) {
  const s = { enabled: true, services: [], text: [ollama], ...settings };
  return new DecisionService({
    settings: () => s,
    credentials: async (owner) => (owner.kind === 'service' ? { apiKey: 'ts-key', headers: {} } : owner.id === 'oai' ? { apiKey: 'oai-key', headers: {} } : { headers: {} }),
    fetch: fakeFetch(routes, calls),
    ...extra,
  });
}

describe('which decision models there are', () => {
  it('finds an Ollama server’s decision models, the better one first, and leaves its chat models out', async () => {
    const service = make({}, { 'http://192.168.20.25:11434/api/tags': () => TAGS });
    const status = await service.status(true);
    expect(status.sources.map((s) => s.id)).toEqual(['text:gpu:nimble:latest', 'text:gpu:tev1:latest']);
    expect(status.sources[0]).toEqual({ id: 'text:gpu:nimble:latest', label: 'nimble', provider: 'Ollama on the GPU box', local: true });
    // Nothing chosen: a model of a server someone runs is picked by itself.
    expect(status.source?.id).toBe('text:gpu:nimble:latest');
  });

  it('asks each model’s page on an Ollama that lists no capabilities', async () => {
    const service = make({}, {
      'http://192.168.20.25:11434/api/tags': () => ({ models: [{ name: 'llama3' }, { name: 'tev1' }] }),
      'http://192.168.20.25:11434/api/show': (body) => ({ capabilities: (body as { model: string }).model === 'tev1' ? ['decision'] : ['completion'] }),
    });
    expect((await service.status(true)).sources.map((s) => s.label)).toEqual(['tev1']);
  });

  it('offers a paid provider’s model, but only uses it when an admin chose it', async () => {
    const service = make({ text: [openai] }, {});
    const status = await service.status(true);
    expect(status.sources).toEqual([{ id: 'text:oai:gpt-6-luna', label: 'gpt-6-luna', provider: 'OpenAI', local: false }]);
    expect(status.source).toBeNull();
    const chosen = make({ text: [openai], source: 'text:oai:gpt-6-luna' }, {});
    expect((await chosen.status(true)).source?.id).toBe('text:oai:gpt-6-luna');
  });

  it('puts a service added for decisions first, and uses it without being chosen', async () => {
    const service = make({ services: [typesafe] }, { 'https://api.typesafe.ai/v1/models': () => ({ data: [{ name: 'jev-latest' }, { name: 'jev-1.13.0' }] }), 'http://192.168.20.25:11434/api/tags': () => TAGS });
    const status = await service.status(true);
    expect(status.sources.map((s) => s.id)).toEqual(['service:typesafe:jev-latest', 'service:typesafe:jev-1.13.0', 'text:gpu:nimble:latest', 'text:gpu:tev1:latest']);
    expect(status.source?.id).toBe('service:typesafe:jev-latest');
  });

  it('says when a service can’t be asked for its models, and falls back on its preset’s', async () => {
    const service = make({ services: [typesafe], text: [] }, { 'https://api.typesafe.ai/v1/models': () => new Response('{"error":"bad key"}', { status: 401 }) });
    const status = await service.status(true);
    expect(status.sources.map((s) => s.id)).toEqual(['service:typesafe:jev-latest']);
  });

  it('shows others what is used, and no list', async () => {
    const service = make({}, { 'http://192.168.20.25:11434/api/tags': () => TAGS });
    const status = await service.status(false);
    expect(status).toMatchObject({ enabled: true, sources: [], chosen: null, source: { label: 'nimble' } });
    expect(status.comparison).toBeUndefined();
  });

  it('reads a source id, and builds its target from the settings alone', () => {
    expect(parseSourceId('text:gpu:nimble:latest')).toEqual({ kind: 'text', owner: 'gpu', model: 'nimble:latest' });
    expect(targetFor('text:gpu:tev1', [ollama], [])).toMatchObject({ root: 'http://192.168.20.25:11434', model: 'tev1', ollama: true, dialect: 'systemone' });
    expect(targetFor('text:oai:gpt-6-luna', [openai], [])).toMatchObject({ root: 'https://api.openai.com', dialect: 'openai-decisions' });
    expect(targetFor('service:typesafe:jev-latest', [], [typesafe])).toMatchObject({ root: 'https://api.typesafe.ai', dialect: 'systemone' });
    // Any model of an OpenAI-compatible provider can be named, wherever it runs; its format is found by asking.
    expect(targetFor('text:together:my-decider', [together], [])).toMatchObject({ root: 'https://api.together.xyz', dialect: 'auto', source: { local: false } });
    // Providers without decision models can't.
    expect(targetFor('text:claude:x', [{ id: 'claude', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', enabled: true, headers: {} } as ProviderConfig], [])).toBeNull();
    expect(targetFor('text:gone:x', [ollama], [])).toBeNull();
    expect(pickAutomatic([])).toBeNull();
  });
});

describe('asking', () => {
  it('sends the question to Ollama with its key-less request and keep_alive, and answers in one shape', async () => {
    const calls: Call[] = [];
    const service = make({ source: 'text:gpu:nimble' }, { 'http://192.168.20.25:11434/v1/systemone': () => OLLAMA_ANSWER }, calls);
    const result = await service.decide({ state: 'I was charged twice.', questions: QUESTIONS }, { admin: false });
    expect(calls[0]).toMatchObject({ url: 'http://192.168.20.25:11434/v1/systemone', method: 'POST', body: { model: 'nimble', keep_alive: '30m', state: 'I was charged twice.' } });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(result).toMatchObject({ model: 'nimble', source: { label: 'nimble', local: true }, usage: { inputTokens: 422 } });
    expect(result.answers.map((a) => a.type)).toEqual(['yesno', 'choice', 'score']);
  });

  it('sends a service’s key, and says what went wrong in its words', async () => {
    const calls: Call[] = [];
    const service = make({ services: [typesafe], text: [], source: 'service:typesafe:jev-latest' }, { 'https://api.typesafe.ai/v1/systemone': () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }) }, calls);
    await expect(service.decide({ state: 'x', questions: QUESTIONS }, { admin: false })).rejects.toThrow('TypeSafe Jev answered 401: Invalid API key Check its key in Settings.');
    expect(calls[0]!.headers.Authorization).toBe('Bearer ts-key');
  });

  it('lets only admins name another source', async () => {
    const service = make({}, { 'http://192.168.20.25:11434/api/tags': () => TAGS });
    await expect(service.decide({ state: 'x', questions: QUESTIONS, source: 'text:gpu:tev1' }, { admin: false })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('says how to get one when there is none, and does nothing when turned off', async () => {
    const none = make({ text: [] }, {});
    await expect(none.decide({ state: 'x', questions: QUESTIONS }, { admin: true })).rejects.toThrow(/No decision model is set up/);
    const off = make({ enabled: false }, { 'http://192.168.20.25:11434/api/tags': () => TAGS });
    await expect(off.decide({ state: 'x', questions: QUESTIONS }, { admin: true })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await off.ask('x', QUESTIONS, { purpose: 'test', timeoutMs: 1000 })).toBeNull();
    expect(off.ready).toBeNull();
  });

  it('answers Atelier’s own questions with null instead of failing', async () => {
    const service = make({ source: 'text:gpu:nimble' }, { 'http://192.168.20.25:11434/v1/systemone': () => new Response('{"error":"model not found"}', { status: 404 }) });
    expect(await service.ask('x', QUESTIONS, { purpose: 'test', timeoutMs: 1000 })).toBeNull();
  });

  it('waits for its turn on a local GPU shared with a chat model', async () => {
    const scheduler = new RequestScheduler();
    const limits = () => ({ parallel: 1, modelsAtOnce: 1 });
    const release = await scheduler.hold('gpu', limits, 'qwen3-8b', AbortSignal.timeout(5000));
    const calls: Call[] = [];
    const service = make({ source: 'text:gpu:nimble' }, { 'http://192.168.20.25:11434/v1/systemone': () => OLLAMA_ANSWER }, calls, { scheduler, queue: () => ({ server: 'gpu', limits }) });
    const pending = service.decide({ state: 'x', questions: QUESTIONS }, { admin: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    release();
    await pending;
    expect(calls).toHaveLength(1);
  });

  it('checks a service before it is saved', async () => {
    const service = make({}, { 'https://api.typesafe.ai/v1/models': () => ({ data: [{ name: 'jev-latest' }] }), 'https://api.typesafe.ai/v1/systemone': () => ({ model: 'jev-1.14.0', answers: { probe: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 9, output_tokens: 0 } }) });
    expect(await service.testService(typesafe, 'k')).toMatchObject({ ok: true, models: ['jev-latest'] });
    const broken = make({}, { 'https://api.typesafe.ai/v1/models': () => ({ data: [{ name: 'jev-latest' }] }), 'https://api.typesafe.ai/v1/systemone': () => new Response('{"error":"bad key"}', { status: 401 }) });
    expect(await broken.testService(typesafe, 'k')).toMatchObject({ ok: false, error: expect.stringContaining('401') });
  });
});

describe('LM Studio and other servers of providers set up already', () => {
  /** LM Studio's own list, as its docs show it: the decision model not loaded yet. */
  const LIST = {
    models: [
      { type: 'llm', key: 'google/gemma-4-26b-a4b', loaded_instances: [{ id: 'google/gemma-4-26b-a4b', config: { context_length: 4096 } }] },
      { type: 'decision', key: 'bespokelabs/nimble', decision_type: 'pplx-decider', loaded_instances: [] },
      { type: 'embedding', key: 'text-embedding-nomic-embed-text-v1.5', loaded_instances: [] },
    ],
  };
  const OPENAI_ANSWER = { model: 'bespokelabs/nimble', answers: [{ type: 'predicate', name: 'spam', probability: 0.9 }], usage: { input_tokens: 40, output_tokens: 0 } };
  const SPAM: DecisionQuestion[] = [{ name: 'spam', type: 'yesno', instructions: 'Is this spam?' }];

  it('finds LM Studio’s decision models in its own list, loads one that isn’t loaded, and asks it in OpenAI’s format', async () => {
    const calls: Call[] = [];
    const service = make({ text: [lmstudio] }, {
      'http://192.168.20.236:1234/api/v1/models/load': () => ({ type: 'decision', instance_id: 'bespokelabs/nimble', status: 'loaded' }),
      'http://192.168.20.236:1234/api/v1/models': () => LIST,
      'http://192.168.20.236:1234/v1/decisions': () => OPENAI_ANSWER,
    }, calls);
    const status = await service.status(true);
    expect(status.sources).toEqual([{ id: 'text:lms:bespokelabs/nimble', label: 'bespokelabs/nimble', provider: 'LM Studio', local: true }]);
    expect(status.source?.id).toBe('text:lms:bespokelabs/nimble');
    const result = await service.decide({ state: 'WIN A PHONE', questions: SPAM }, { admin: false });
    expect(result.answers[0]).toEqual({ type: 'yesno', name: 'spam', probability: 0.9 });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(posts).toEqual(['http://192.168.20.236:1234/api/v1/models/load', 'http://192.168.20.236:1234/v1/decisions']);
    expect(calls.at(-1)!.body).toMatchObject({ model: 'bespokelabs/nimble', input: 'WIN A PHONE', questions: [{ type: 'predicate', name: 'spam' }] });
    // Loaded once: the next decision goes straight to it.
    await service.decide({ state: 'hello', questions: SPAM }, { admin: false });
    expect(calls.filter((c) => c.url.endsWith('/load'))).toHaveLength(1);
  });

  it('says in plain words that an LM Studio from before decision models can’t answer, instead of “no answers”', async () => {
    const service = make({ text: [lmstudio] }, {
      'http://192.168.20.236:1234/api/v1/models': () => UNEXPECTED('/api/v1/models'),
      'http://192.168.20.236:1234/api/tags': () => UNEXPECTED('/api/tags'),
      'http://192.168.20.236:1234/v1/models': () => ({ data: [{ id: 'nimble-9b' }, { id: 'qwen3-8b' }] }),
      'http://192.168.20.236:1234/v1/systemone': () => UNEXPECTED('/v1/systemone'),
      'http://192.168.20.236:1234/v1/decisions': () => UNEXPECTED('/v1/decisions'),
    });
    // The model shows by its name, so the admin sees what is there; asking it says what to do.
    expect((await service.status(true)).sources.map((x) => x.label)).toEqual(['nimble-9b']);
    await expect(service.decide({ state: 'x', questions: SPAM }, { admin: false })).rejects.toThrow(
      'LM Studio doesn’t answer decision requests (“Unexpected endpoint or method. (POST /v1/systemone)”). It needs a version with decision models: Ollama 0.35 or later, a current LM Studio or llama.cpp server.',
    );
  });

  it('asks a named model of a server it doesn’t know in System One first, then in OpenAI’s format, and remembers which worked', async () => {
    const calls: Call[] = [];
    const service = make({ text: [together], source: 'text:together:my-decider' }, {
      'https://api.together.xyz/v1/systemone': () => new Response('{"error":"Not Found"}', { status: 404 }),
      'https://api.together.xyz/v1/decisions': () => OPENAI_ANSWER,
    }, calls);
    expect((await service.decide({ state: 'x', questions: SPAM }, { admin: false })).answers[0]).toMatchObject({ probability: 0.9 });
    await service.decide({ state: 'y', questions: SPAM }, { admin: false });
    expect(calls.map((c) => c.url)).toEqual(['https://api.together.xyz/v1/systemone', 'https://api.together.xyz/v1/decisions', 'https://api.together.xyz/v1/decisions']);
  });

  it('lists the providers an admin can name a decision model of', async () => {
    const service = make({ text: [ollama, together, openai, { id: 'claude', type: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', enabled: true, headers: {} } as ProviderConfig] }, { 'http://192.168.20.25:11434/api/tags': () => TAGS });
    expect((await service.status(true)).providers).toEqual([
      { id: 'gpu', name: 'Ollama on the GPU box' },
      { id: 'together', name: 'Together' },
      { id: 'oai', name: 'OpenAI' },
    ]);
    expect((await service.status(false)).providers).toBeUndefined();
  });
});

describe('Auto mode’s quick check', () => {
  const result = (run: number, harm: number) => ({
    answers: [
      { type: 'choice' as const, name: 'run', choice: run >= 0.5 ? 'run' : 'review', confidence: 0.9, probabilities: [{ value: 'run', probability: run }, { value: 'review', probability: 1 - run }] },
      { type: 'yesno' as const, name: 'harm', probability: harm },
    ],
    source: { id: 'x', label: 'nimble', provider: 'Ollama', local: true },
    model: 'nimble',
    ms: 120,
    usage: { inputTokens: 900, outputTokens: 0 },
  });

  it('lets an action through only when it is sure it is fine and harmless', () => {
    expect(quickAllows(result(0.96, 0.1))).toBe(true);
    expect(quickAllows(result(0.85, 0.1))).toBe(false);
    expect(quickAllows(result(0.99, 0.36))).toBe(false);
    expect(quickAllows(null)).toBe(false);
  });

  it('sums an action up in one line', () => {
    expect(actionSummary({ name: 'Bash', input: { command: 'rm -rf  ./dist\n' } })).toBe('Bash: rm -rf ./dist');
    expect(actionSummary({ name: 'Edit', input: { file_path: '/p/a.ts' } })).toBe('Edit: /p/a.ts');
  });

  describe('measured against the reviewer', () => {
    let dir: string;
    beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'decisions-'))));
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it('counts agreements and misses, keeps them across a restart, and starts again on reset', async () => {
      const file = join(dir, 'decisions.json');
      const service = make({}, {}, [], { stateFile: file });
      service.compared({ wouldAllow: true, reviewerAllowed: true, reviewerVerdict: 'ALLOW', tool: 'Bash', summary: 'Bash: ls', ms: 100 });
      service.compared({ wouldAllow: true, reviewerAllowed: false, reviewerVerdict: 'BLOCK: deletes the backups', tool: 'Bash', summary: 'Bash: rm -rf ~/backups', ms: 140 });
      service.compared({ wouldAllow: false, reviewerAllowed: true, reviewerVerdict: 'ALLOW', tool: 'Edit', summary: 'Edit: a.ts', ms: 90 });
      service.approvedOne(80);
      expect(service.comparison()).toMatchObject({ checked: 3, bothAllowed: 1, wronglyAllowed: 1, leftToReviewer: 1, approved: 1, medianMs: 100, misses: [{ tool: 'Bash', summary: 'Bash: rm -rf ~/backups', verdict: 'BLOCK: deletes the backups' }] });
      await new Promise((r) => setTimeout(r, 2200));
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ checked: 3, wronglyAllowed: 1 });
      const again = make({}, {}, [], { stateFile: file });
      await again.load();
      expect(again.comparison()).toMatchObject({ checked: 3, approved: 1 });
      again.resetComparison();
      expect(again.comparison()).toMatchObject({ checked: 0, misses: [] });
    });
  });
});
