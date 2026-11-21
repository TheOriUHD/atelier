/**
 * A reliability sweep of Mistral's API as Atelier talks to it: many small real requests with the shapes Atelier really
 * sends (tool schemas of every flavour, histories with tool results, images and interrupted turns), repeated, in
 * parallel and across every chat model, and a table of what failed. A request counts as accepted when it ends without an
 * error; Group D also checks that a tool was actually called with valid arguments. Only on request, as it spends tokens:
 *   LIVE_STRESS=1 [LIVE_STRESS_KEY=vibe|api] [LIVE_STRESS_MODELS=a,b] [LIVE_STRESS_GROUPS=A,B,C,D] [LIVE_STRESS_REPEAT=10] \
 *     npx vitest run packages/core/src/providers/live-stress.test.ts --disable-console-intercept
 * Keys come from `.env.local` (the main checkout's from a worktree); nothing here prints them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import type { Message, Part } from '@atelier/protocol';
import { createAdapter } from './index.ts';
import type { ChatRequest, ProviderAdapter, StreamEvent, ToolDef } from './types.ts';

function findEnvFile(): string | null {
  const here = join(import.meta.dirname, '../../../../.env.local');
  if (existsSync(here)) return here;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
    const main = join(dirname(common), '.env.local');
    return existsSync(main) ? main : null;
  } catch {
    return null;
  }
}
const envFile = findEnvFile();
const fileEnv: Record<string, string> = envFile
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
    )
  : {};
const env = (name: string): string | undefined => process.env[name] || fileEnv[name] || undefined;

const which = (process.env.LIVE_STRESS_KEY ?? 'vibe') as 'vibe' | 'api';
const type = which === 'api' ? 'mistral' : 'mistral-vibe';
const key = env(which === 'api' ? 'MISTRAL_API_KEY' : 'MISTRAL_VIBE_API_KEY');
const groups = new Set((process.env.LIVE_STRESS_GROUPS ?? 'A,B,C,D').split(','));
const repeat = Number(process.env.LIVE_STRESS_REPEAT ?? 8);
const DEFAULT_MODELS = ['mistral-large-4', 'zai-glm-5-3-flash', 'zai-glm-5-3', 'mistral-medium-latest', 'mistral-small-2603', 'deepseek-v4-1-flash-1017', 'glm-5-2', 'codestral-2508', 'ministral-14b-2512', 'mistral-large-2512'];
const models = (process.env.LIVE_STRESS_MODELS ?? DEFAULT_MODELS.join(',')).split(',').filter(Boolean);

function png(size: number): Uint8Array {
  const chunk = (t: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(t, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]));
}
const IMAGE = png(64);

const logs: string[] = [];
function adapter(): ProviderAdapter {
  return createAdapter(
    { id: 'live', type, name: 'Mistral', baseUrl: 'https://api.mistral.ai', headers: {}, apiKey: key! } as never,
    { fetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init), readBlob: async (sha: string) => (sha === 'bad' ? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) : IMAGE), log: (line: string) => logs.push(line) } as never,
  );
}

let seq = 0;
const base = { sessionId: 's', parentId: null, model: null, usage: null, stopReason: null, error: null, kind: 'normal' as const, summarizesThroughId: null, createdAt: 0 };
const msg = (role: Message['role'], parts: Part[]): Message => ({ ...base, id: `m${seq++}`, role, parts });
const user = (text: string) => msg('user', [{ type: 'text', text }]);
const assistant = (parts: Part[]) => msg('assistant', parts);
const call = (id: string, name: string, input: unknown): Part => ({ type: 'tool_call', id, name, input });
const result = (callId: string, text: string, isError = false): Part => ({ type: 'tool_result', callId, content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
const toolMsg = (parts: Part[]) => msg('tool', parts);

const WEATHER: ToolDef = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'The city name' } }, required: ['city'], additionalProperties: false },
};
const NOOP: ToolDef = { name: 'noop', description: 'Does nothing.', inputSchema: { type: 'object', properties: {} } };

interface Outcome {
  ok: boolean;
  note: string;
  ms: number;
  text: number;
  calls: number;
  badArgs: number;
  stop: string;
}

async function run(model: string, request: Partial<ChatRequest> & Pick<ChatRequest, 'messages'>, effort: ChatRequest['effort'] = null): Promise<Outcome> {
  const a = adapter();
  const events: StreamEvent[] = [];
  const started = Date.now();
  try {
    for await (const ev of a.stream({
      model,
      system: [{ text: 'You are a terse test assistant.' }],
      maxOutputTokens: 4096,
      effort,
      signal: AbortSignal.timeout(180_000),
      ...request,
    })) events.push(ev);
  } catch (e) {
    return { ok: false, note: `threw ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), ms: Date.now() - started, text: 0, calls: 0, badArgs: 0, stop: '-' };
  }
  const finish = events.find((e) => e.type === 'finish');
  const text = events.reduce((n, e) => n + (e.type === 'text' ? e.delta.length : 0), 0);
  const ends = events.filter((e): e is Extract<StreamEvent, { type: 'tool_call_end' }> => e.type === 'tool_call_end');
  const starts = events.filter((e) => e.type === 'tool_call_start');
  const badArgs = ends.filter((e) => typeof e.input !== 'object' || e.input === null).length;
  const stop = finish?.type === 'finish' ? finish.reason : '-';
  const error = finish?.type === 'finish' ? finish.error : undefined;
  return {
    ok: !error && finish?.type === 'finish',
    note: error ? `${error.code}: ${error.message}`.replace(/\s+/g, ' ').slice(0, 220) : '',
    ms: Date.now() - started,
    text,
    calls: Math.max(ends.length, starts.length),
    badArgs,
    stop,
  };
}

const rows: string[] = [];
const fails: string[] = [];
function record(model: string, label: string, o: Outcome, extra = ''): void {
  const line = `${o.ok ? 'ok  ' : 'FAIL'} ${model.padEnd(26)} ${label.padEnd(34)} ${String(o.ms).padStart(6)}ms stop=${o.stop} text=${o.text} calls=${o.calls}${o.badArgs ? ` badArgs=${o.badArgs}` : ''}${extra ? ` ${extra}` : ''}${o.note ? ` — ${o.note}` : ''}`;
  rows.push(line);
  if (!o.ok) fails.push(line);
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

const say = (extra: Partial<ChatRequest> = {}) => ({ messages: [user('Reply with the single word OK. Do not call any tool.')], ...extra });

// ------------------------------------------------------------------ Group A: tool schemas and names
const schemaCases: Array<[string, ToolDef[]]> = [
  ['A1 plain', [WEATHER]],
  ['A2 anyOf/oneOf/allOf', [{ name: 't_any', description: 'x', inputSchema: { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }] }, w: { oneOf: [{ type: 'string' }, { type: 'null' }] }, z: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] } } } }]],
  ['A3 $ref and $defs', [{ name: 't_ref', description: 'x', inputSchema: { type: 'object', $defs: { Pt: { type: 'object', properties: { x: { type: 'number' } } } }, properties: { p: { $ref: '#/$defs/Pt' } } } }]],
  ['A4 type array with null', [{ name: 't_null', description: 'x', inputSchema: { type: 'object', properties: { v: { type: ['string', 'null'] }, n: { type: ['integer', 'null'], minimum: 0 } } } }]],
  ['A5 enum and const', [{ name: 't_enum', description: 'x', inputSchema: { type: 'object', properties: { a: { enum: [1, 2, 3] }, b: { const: 'fixed' }, c: { type: 'string', enum: ['x', 'y'], default: 'x' } } } }]],
  ['A6 format pattern bounds', [{ name: 't_fmt', description: 'x', inputSchema: { type: 'object', properties: { u: { type: 'string', format: 'uri' }, p: { type: 'string', pattern: '^[a-z]+$', minLength: 1, maxLength: 10 }, n: { type: 'number', minimum: 0, maximum: 5, multipleOf: 0.5 } } } }]],
  ['A7 additionalProperties schema', [{ name: 't_add', description: 'x', inputSchema: { type: 'object', properties: {}, additionalProperties: { type: 'string' } } }]],
  ['A8 array no items/ object bare', [{ name: 't_bare', description: 'x', inputSchema: { type: 'object', properties: { a: { type: 'array' }, o: { type: 'object' }, any: {} } } }]],
  ['A9 deep nesting', [{ name: 't_deep', description: 'x', inputSchema: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'array', items: { type: 'object', properties: { e: { type: 'string' } } } } } } } } } } } } }]],
  ['A10 20k char description', [{ name: 't_long', description: 'Long. '.repeat(3400), inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'd '.repeat(2000) } } } }]],
  ['A11 required not in properties', [{ name: 't_req', description: 'x', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'missing'] } }]],
  ['A12 $schema and title keys', [{ name: 't_meta', description: 'x', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', title: 'T', type: 'object', properties: { a: { type: 'string', title: 'A', examples: ['e'] } } } }]],
  ['A13 unicode and quotes', [{ name: 't_uni', description: 'Zeichen "ä" \\ \n tab\t emoji 🚀', inputSchema: { type: 'object', properties: { 'naïve key': { type: 'string', description: 'çé' } } } }]],
  ['A14 64 tools', Array.from({ length: 64 }, (_, i) => ({ name: `tool_${i}`, description: `Tool number ${i}.`, inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }))],
  ['A15 128 tools', Array.from({ length: 128 }, (_, i) => ({ name: `tool_${i}`, description: `Tool number ${i}.`, inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }))],
  ['A16 name with dot', [{ name: 'server.tool', description: 'x', inputSchema: { type: 'object', properties: {} } }]],
  ['A17 name with colon', [{ name: 'server:tool', description: 'x', inputSchema: { type: 'object', properties: {} } }]],
  ['A18 name 64 chars', [{ name: 'a'.repeat(64), description: 'x', inputSchema: { type: 'object', properties: {} } }]],
  ['A19 name 65 chars', [{ name: 'a'.repeat(65), description: 'x', inputSchema: { type: 'object', properties: {} } }]],
  ['A20 mcp__ style name', [{ name: 'mcp__github__create_pull_request_review', description: 'x', inputSchema: { type: 'object', properties: {} } }]],
  ['A21 empty description', [{ name: 't_nodesc', description: '', inputSchema: { type: 'object', properties: {} } }]],
  ['A22 duplicate tool names', [WEATHER, WEATHER]],
  ['A23 no type at root', [{ name: 't_notype', description: 'x', inputSchema: { properties: { a: { type: 'string' } } } as never }]],
];

// ------------------------------------------------------------------ Group B: histories
const png1: Part = { type: 'image', mime: 'image/png', blob: 'x' };
const histories: Array<[string, () => Message[], ToolDef[]]> = [
  ['B1 tool then user', () => [user('Weather in Paris?'), assistant([call('c1', 'get_weather', { city: 'Paris' })]), toolMsg([result('c1', '18C, cloudy')]), user('Thanks. Now say OK.')], [WEATHER]],
  ['B2 image from a tool', () => [user('Look at it.'), assistant([call('c1', 'get_weather', { city: 'Paris' })]), toolMsg([{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'screenshot' }, { type: 'image', mime: 'image/png', blob: 'x' }] }])], [WEATHER]],
  ['B3 call without a result', () => [user('Weather in Paris?'), assistant([call('c1', 'get_weather', { city: 'Paris' })]), user('Never mind, say OK.')], [WEATHER]],
  ['B4 two user messages', () => [user('Context: the sky is blue.'), user('Reply with OK.')], []],
  ['B5 two assistant messages', () => [user('Hi'), assistant([{ type: 'text', text: 'Hello.' }]), assistant([{ type: 'text', text: 'Anything else?' }]), user('Say OK.')], []],
  ['B6 empty tool result', () => [user('Do it.'), assistant([call('c1', 'noop', {})]), toolMsg([result('c1', '')])], [NOOP]],
  ['B7 thinking-only assistant', () => [user('Hi'), assistant([{ type: 'thinking', text: 'Considering.', provider: type, replay: undefined }]), user('Say OK.')], []],
  ['B8 300k char tool result', () => [user('Read it.'), assistant([call('c1', 'noop', {})]), toolMsg([result('c1', 'lorem ipsum dolor sit amet. '.repeat(10_700))])], [NOOP]],
  ['B9 ends with assistant text', () => [user('Say OK.'), assistant([{ type: 'text', text: 'OK' }])], []],
  ['B10 three parallel calls', () => [user('Weather in 3 cities.'), assistant([call('c1', 'get_weather', { city: 'A' }), call('c2', 'get_weather', { city: 'B' }), call('c3', 'get_weather', { city: 'C' })]), toolMsg([result('c3', 'C: 3'), result('c1', 'A: 1'), result('c2', 'B: 2')])], [WEATHER]],
  ['B11 foreign long call id', () => [user('Weather?'), assistant([call('toolu_01A09q90qw90lq917835lq9', 'get_weather', { city: 'Paris' })]), toolMsg([result('toolu_01A09q90qw90lq917835lq9', '18C')])], [WEATHER]],
  ['B12 error tool result', () => [user('Weather?'), assistant([call('c1', 'get_weather', { city: 'Paris' })]), toolMsg([result('c1', 'No such city', true)])], [WEATHER]],
  ['B13 user image', () => [msg('user', [{ type: 'text', text: 'What colour is it? One word.' }, png1])], []],
  ['B14 8 user images', () => [msg('user', [{ type: 'text', text: 'How many images? Number only.' }, ...Array.from({ length: 8 }, () => png1)])], []],
  ['B15 200k char system', () => [user('Say OK.')], []],
  ['B16 tool call with big args', () => [user('Write.'), assistant([call('c1', 'noop', { text: 'x'.repeat(60_000) })]), toolMsg([result('c1', 'ok')])], [NOOP]],
  ['B17 empty assistant then user', () => [user('Hi'), assistant([]), user('Say OK.')], []],
  ['B19 unreadable user image', () => [msg('user', [{ type: 'text', text: 'What is in the picture? Short.' }, { type: 'image', mime: 'image/png', blob: 'bad' }])], []],
  ['B20 unreadable tool image', () => [user('Look.'), assistant([call('c1', 'get_weather', { city: 'Paris' })]), toolMsg([{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', text: 'screenshot' }, { type: 'image', mime: 'image/png', blob: 'bad' }] }])], [WEATHER]],
  ['B18 whitespace-only user text', () => [user('Hi'), assistant([{ type: 'text', text: 'Hello' }]), user('   ')], []],
];


// ------------------------------------------------------------------ Group F: a small agent loop, as a turn runs it
const FS_TOOLS: ToolDef[] = [
  { name: 'read_file', description: 'Read a text file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Write a text file, replacing it.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'list_files', description: 'List the files in the folder.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

async function agentLoop(model: string, effort: ChatRequest['effort'], task: number): Promise<Outcome & { steps: number }> {
  const files = new Map<string, string>([['notes.txt', `hello world number ${task}`], ['todo.txt', 'buy milk\ncall mum']]);
  const a = adapter();
  const history: Message[] = [user('Read notes.txt, then write its text in upper case to upper.txt, then tell me in one sentence what you did. Use the tools.')];
  const started = Date.now();
  let steps = 0;
  for (; steps < 10; steps++) {
    const events: StreamEvent[] = [];
    try {
      for await (const ev of a.stream({ model, system: [{ text: 'You are a coding agent with file tools. Work step by step.' }], messages: history, tools: FS_TOOLS, maxOutputTokens: effort ? 32_768 : 4096, effort, signal: AbortSignal.timeout(180_000) })) events.push(ev);
    } catch (e) {
      return { ok: false, note: `threw ${String(e).slice(0, 150)}`, ms: Date.now() - started, text: 0, calls: 0, badArgs: 0, stop: '-', steps };
    }
    const fin = events.find((e) => e.type === 'finish');
    if (fin?.type === 'finish' && fin.error) return { ok: false, note: `${fin.error.code}: ${fin.error.message}`.slice(0, 200), ms: Date.now() - started, text: 0, calls: 0, badArgs: 0, stop: 'error', steps };
    const parts: Part[] = [];
    let thinking = '';
    let replay: unknown;
    let text = '';
    for (const e of events) {
      if (e.type === 'thinking') thinking += e.delta;
      if (e.type === 'thinking_replay') replay = e.data;
      if (e.type === 'text') text += e.delta;
      if (e.type === 'tool_call_end') parts.push(call(e.id, '', e.input));
    }
    const names = new Map(events.flatMap((e) => (e.type === 'tool_call_start' ? [[e.id, e.name] as const] : [])));
    for (const p of parts) if (p.type === 'tool_call') p.name = names.get(p.id) ?? p.name;
    const reply: Part[] = [...(thinking ? [{ type: 'thinking' as const, text: thinking, provider: type, ...(replay !== undefined ? { replay } : {}) }] : []), ...(text ? [{ type: 'text' as const, text }] : []), ...parts];
    history.push(assistant(reply));
    if (parts.length === 0) {
      const done = text.trim() !== '' && files.get('upper.txt') === `HELLO WORLD NUMBER ${task}`;
      return { ok: done, note: done ? '' : text.trim() === '' ? 'ended with an empty reply' : `finished without the right file (${files.get('upper.txt') ?? 'none written'})`, ms: Date.now() - started, text: text.length, calls: steps, badArgs: 0, stop: 'end', steps: steps + 1 };
    }
    const results: Part[] = parts.map((p) => {
      if (p.type !== 'tool_call') return result('x', '');
      const input = (p.input ?? {}) as Record<string, unknown>;
      if (p.name === 'read_file') return files.has(String(input.path)) ? result(p.id, files.get(String(input.path))!) : result(p.id, `No such file: ${String(input.path)}`, true);
      if (p.name === 'write_file') {
        files.set(String(input.path), String(input.content));
        return result(p.id, `Wrote ${String(input.content).length} characters to ${String(input.path)}.`);
      }
      if (p.name === 'list_files') return result(p.id, [...files.keys()].join('\n'));
      return result(p.id, `Unknown tool ${p.name}`, true);
    });
    history.push(toolMsg(results));
  }
  return { ok: false, note: 'no end after 10 steps', ms: Date.now() - started, text: 0, calls: steps, badArgs: 0, stop: '-', steps };
}

// ------------------------------------------------------------------ the sweep
it.skipIf(!key || !process.env.LIVE_STRESS)(`Mistral sweep (${type}) across ${models.length} models`, { timeout: 40 * 60_000 }, async () => {
  const started = Date.now();
  if (groups.has('A')) {
    await pool(models.flatMap((m) => schemaCases.map((c) => [m, c] as const)), 6, async ([model, [label, tools]]) => {
      record(model, label, await run(model, { ...say(), tools }));
    });
  }
  if (groups.has('B')) {
    await pool(models.flatMap((m) => histories.map((h) => [m, h] as const)), 6, async ([model, [label, make, tools]]) => {
      const system = label.startsWith('B15') ? [{ text: 'You are a terse test assistant. ' + 'Background fact. '.repeat(11_000) }] : undefined;
      record(model, label, await run(model, { messages: make(), ...(tools.length ? { tools } : {}), ...(system ? { system } : {}) }));
    });
  }
  if (groups.has('C')) {
    for (const model of models) {
      const t0 = Date.now();
      const outcomes: Outcome[] = [];
      await Promise.all(Array.from({ length: 16 }, async () => void outcomes.push(await run(model, { ...say(), maxOutputTokens: 512 }))));
      const bad = outcomes.filter((o) => !o.ok);
      record(model, 'C1 16 requests at once', { ok: bad.length === 0, note: [...new Set(bad.map((o) => o.note.slice(0, 90)))].join(' | '), ms: Date.now() - t0, text: 0, calls: 0, badArgs: 0, stop: `${outcomes.length - bad.length}/16 ok` });
    }
  }
  if (groups.has('D')) {
    const efforts: Array<ChatRequest['effort']> = [null, 'medium'];
    await pool(
      models.flatMap((m) => efforts.flatMap((e) => Array.from({ length: repeat }, (_, i) => [m, e, i] as const))),
      6,
      async ([model, effort, i]) => {
        const o = await run(
          model,
          { messages: [user(`Use the get_weather tool for the city number ${i + 1} on this list: Paris, Berlin, Rome, Madrid, Vienna, Oslo, Lisbon, Prague, Dublin, Athens.`)], tools: [WEATHER, NOOP], maxOutputTokens: effort ? 16_384 : 2048 },
          effort,
        );
        // Calling the tool is what was asked for: a reply without a call, or with unreadable arguments, is a failure of the model-and-harness pair.
        const good = o.ok && o.calls > 0 && o.badArgs === 0;
        record(model, `D tool call (effort ${effort ?? 'off'})`, { ...o, ok: good, note: o.ok && !good ? 'no usable tool call' : o.note });
      },
    );
  }

  if (groups.has('F')) {
    const efforts: Array<ChatRequest['effort']> = [null, 'medium'];
    await pool(
      models.flatMap((m) => efforts.flatMap((e) => Array.from({ length: repeat }, (_, i) => [m, e, i] as const))),
      4,
      async ([model, effort, i]) => {
        const o = await agentLoop(model, effort, i);
        record(model, `F agent loop (effort ${effort ?? 'off'})`, o, `steps=${o.steps}`);
      },
    );
  }

  if (groups.has('G')) {
    // How many requests at once a model takes without a rate limit: the same small request in bursts of N, three bursts each.
    const sizes = (process.env.LIVE_STRESS_BURSTS ?? '4,8,12').split(',').map(Number);
    for (const model of models) {
      for (const n of sizes) {
        let limited = 0;
        const notes = new Set<string>();
        for (let round = 0; round < 3; round++) {
          const outcomes: Outcome[] = [];
          await Promise.all(Array.from({ length: n }, async () => void outcomes.push(await run(model, { ...say(), maxOutputTokens: 512 }))));
          for (const o of outcomes) if (!o.ok) { limited++; notes.add(o.note.slice(0, 80)); }
          await new Promise((r) => setTimeout(r, 4000));
        }
        record(model, `G ${n} at once x3`, { ok: limited === 0, note: [...notes].join(' | '), ms: 0, text: 0, calls: 0, badArgs: 0, stop: `${limited} of ${n * 3} failed` });
      }
    }
  }
  console.log(`\n=== ${type}: ${rows.length} requests in ${Math.round((Date.now() - started) / 1000)} s, ${fails.length} failed`);
  const byModel = new Map<string, { n: number; bad: number }>();
  for (const r of rows) {
    const model = r.slice(5, 31).trim();
    const s = byModel.get(model) ?? { n: 0, bad: 0 };
    s.n++;
    if (r.startsWith('FAIL')) s.bad++;
    byModel.set(model, s);
  }
  for (const [m, s] of byModel) console.log(`  ${m.padEnd(26)} ${s.n - s.bad}/${s.n} ok`);
  console.log('\nFAILURES\n' + (fails.length ? fails.sort().join('\n') : '(none)'));
  console.log('\nADAPTER LOG (last 40)\n' + logs.slice(-40).join('\n'));
  expect(rows.length).toBeGreaterThan(0);
});
