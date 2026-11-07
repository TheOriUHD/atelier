/**
 * Live smoke tests against real endpoints. Skipped unless configured, through the environment or a
 * gitignored `.env.local` at the repo root (in a git worktree, the main checkout's, since worktrees have none):
 *   ANTHROPIC_API_KEY  [ATELIER_LIVE_ANTHROPIC_MODEL=claude-haiku-5-5]
 *   OPENAI_API_KEY     [ATELIER_LIVE_OPENAI_MODEL=gpt-5-mini]
 *   ATELIER_LIVE_OLLAMA_URL        [ATELIER_LIVE_OLLAMA_MODEL, else the first listed]
 *   ATELIER_LIVE_LLAMACPP_URL
 *   ATELIER_LIVE_COMPAT_URL [ATELIER_LIVE_COMPAT_KEY] [ATELIER_LIVE_COMPAT_MODEL]
 *   MISTRAL_API_KEY       [ATELIER_LIVE_MISTRAL_MODEL=mistral-small-2603]
 *   MISTRAL_VIBE_API_KEY  [ATELIER_LIVE_MISTRAL_VIBE_MODEL=mistral-vibe-cli-latest] (a Vibe key: spends the plan's allowance)
 * Keys are only passed to the adapters; nothing here prints them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it, type TestContext } from 'vitest';
import type { Message, Part, ProviderType } from '@atelier/protocol';
import { createAdapter } from './index.ts';
import type { ProviderAdapter, StreamEvent } from './types.ts';

/** This checkout's `.env.local`, else the main checkout's (where the keys live) when this runs in a git worktree. */
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

// A 64×64 red PNG for the image round trip (a single pixel reads as white to some models, Mistral Small 4 among them).
const RED_PIXEL = redPng(64);

function redPng(size: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
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

function adapter(type: ProviderType, baseUrl: string, apiKey?: string): ProviderAdapter {
  return createAdapter(
    { id: 'live', type, name: 'Live', baseUrl, headers: {}, ...(apiKey ? { apiKey } : {}) },
    { fetch: (url, init) => fetch(url, init), readBlob: async () => RED_PIXEL },
  );
}

const userMessage = (parts: Part[]): Message => ({
  id: 'u',
  sessionId: 'live',
  parentId: null,
  role: 'user',
  parts,
  model: null,
  usage: null,
  stopReason: null,
  error: null,
  kind: 'normal',
  summarizesThroughId: null,
  createdAt: Date.now(),
});

/** The account behind the key has no credit left (or its plan's limit is reached): nothing is wrong with Atelier. */
class OutOfCredit extends Error {}

/** A live test that is skipped, not failed, when the provider says it has no credit to answer with. */
const live_ = (run: (ctx: TestContext) => Promise<void>) => async (ctx: TestContext) => {
  try {
    await run(ctx);
  } catch (error) {
    if (error instanceof OutOfCredit) ctx.skip(error.message);
    throw error;
  }
};

async function collect(a: ProviderAdapter, model: string, parts: Part[], effort: 'low' | null = null): Promise<{ text: string; thinking: string; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  for await (const ev of a.stream({
    model,
    system: [{ text: 'You are a terse test assistant.' }],
    messages: [userMessage(parts)],
    maxOutputTokens: 2048,
    effort,
    signal: AbortSignal.timeout(90_000),
  })) events.push(ev);
  const finish = events.find((e) => e.type === 'finish');
  if (finish?.type === 'finish' && finish.error) {
    const error = new Error(`${finish.error.code}: ${finish.error.message}`);
    throw finish.error.code === 'provider_quota' ? new OutOfCredit(error.message) : error;
  }
  return {
    text: events.map((e) => (e.type === 'text' ? e.delta : '')).join(''),
    thinking: events.map((e) => (e.type === 'thinking' ? e.delta : '')).join(''),
    events,
  };
}

interface Target {
  name: string;
  type: ProviderType;
  url?: string;
  key?: string;
  model?: string;
  thinking: boolean;
  vision: boolean;
}

const targets: Target[] = [
  { name: 'Anthropic', type: 'anthropic', url: 'https://api.anthropic.com', key: env('ANTHROPIC_API_KEY'), model: env('ATELIER_LIVE_ANTHROPIC_MODEL') ?? 'claude-haiku-5-5', thinking: true, vision: true },
  { name: 'OpenAI', type: 'openai', url: 'https://api.openai.com', key: env('OPENAI_API_KEY'), model: env('ATELIER_LIVE_OPENAI_MODEL') ?? 'gpt-5-mini', thinking: true, vision: true },
  { name: 'Ollama', type: 'ollama', url: env('ATELIER_LIVE_OLLAMA_URL'), model: env('ATELIER_LIVE_OLLAMA_MODEL'), thinking: false, vision: false },
  { name: 'llama.cpp', type: 'llamacpp', url: env('ATELIER_LIVE_LLAMACPP_URL'), thinking: false, vision: false },
  { name: 'OpenAI-compatible', type: 'openai-compatible', url: env('ATELIER_LIVE_COMPAT_URL'), key: env('ATELIER_LIVE_COMPAT_KEY'), model: env('ATELIER_LIVE_COMPAT_MODEL'), thinking: false, vision: false },
  { name: 'Mistral', type: 'mistral', url: 'https://api.mistral.ai', key: env('MISTRAL_API_KEY'), model: env('ATELIER_LIVE_MISTRAL_MODEL') ?? 'mistral-small-2603', thinking: true, vision: true },
  { name: 'Mistral Vibe', type: 'mistral-vibe', url: 'https://api.mistral.ai', key: env('MISTRAL_VIBE_API_KEY'), model: env('ATELIER_LIVE_MISTRAL_VIBE_MODEL') ?? 'mistral-vibe-cli-latest', thinking: true, vision: true },
];

const HOSTED: ProviderType[] = ['anthropic', 'openai', 'mistral', 'mistral-vibe'];

for (const t of targets) {
  const configured = HOSTED.includes(t.type) ? !!t.key : !!t.url;
  describe.skipIf(!configured)(`live: ${t.name}`, { timeout: 120_000 }, () => {
    // Created lazily: skipped suites are still collected.
    let created: ProviderAdapter | undefined;
    const live = () => (created ??= adapter(t.type, t.url!, t.key));
    const model = async () => t.model ?? (await live().listModels())[0]!.modelId;

    it('is healthy and lists models', async () => {
      expect((await live().health()).ok).toBe(true);
      expect((await live().listModels()).length).toBeGreaterThan(0);
    });

    it('streams text and reports usage', live_(async () => {
      const { text, events } = await collect(live(), await model(), [{ type: 'text', text: 'Reply with the single word: pong' }]);
      expect(text.toLowerCase()).toContain('pong');
      expect(events.some((e) => e.type === 'usage')).toBe(true);
    }));

    it.skipIf(!t.thinking)('streams thinking when an effort is set', live_(async () => {
      const { thinking, text } = await collect(live(), await model(), [{ type: 'text', text: 'What is 17 * 23? Think first, then answer with the number.' }], 'low');
      expect(text).toContain('391');
      expect(thinking.length).toBeGreaterThan(0);
    }));

    it.skipIf(!t.vision)('reads an image', live_(async () => {
      const { text } = await collect(live(), await model(), [
        { type: 'image', mime: 'image/png', blob: 'red-pixel' },
        { type: 'text', text: 'What single color is this image? Answer with one word.' },
      ]);
      expect(text.toLowerCase()).toContain('red');
    }));

    // Mistral's own rules: nine-letter call ids, a tool message for every call, the tool's name with its result.
    it.skipIf(t.type !== 'mistral' && t.type !== 'mistral-vibe')('calls a tool and answers from its result, with a call id from another provider', live_(async () => {
      const tool = { name: 'lookup_capital', description: 'The capital of a country.', inputSchema: { type: 'object', properties: { country: { type: 'string' } }, required: ['country'] } };
      const ask = userMessage([{ type: 'text', text: 'Use lookup_capital to find the capital of France, then answer with just the city.' }]);
      const first: StreamEvent[] = [];
      for await (const ev of live().stream({ model: await model(), system: [{ text: 'You are a terse test assistant.' }], messages: [ask], tools: [tool], maxOutputTokens: 1024, signal: AbortSignal.timeout(90_000) })) first.push(ev);
      const end = first.find((e) => e.type === 'tool_call_end');
      expect(end?.type).toBe('tool_call_end');
      // As if another provider had made the call: Mistral only takes nine-letter ids, which the adapter maps.
      const callId = 'toolu_01AbCdEfGhIjKlMnOpQrStUv';
      const assistant: Message = { ...ask, id: 'a', role: 'assistant', parts: [{ type: 'tool_call', id: callId, name: tool.name, input: { country: 'France' } }] };
      const result: Message = { ...ask, id: 't', parts: [{ type: 'tool_result', callId, content: [{ type: 'text', text: 'Paris' }] }] };
      const text: string[] = [];
      for await (const ev of live().stream({ model: await model(), system: [{ text: 'You are a terse test assistant.' }], messages: [ask, assistant, result], tools: [tool], maxOutputTokens: 1024, signal: AbortSignal.timeout(90_000) })) {
        if (ev.type === 'text') text.push(ev.delta);
        if (ev.type === 'finish' && ev.error) throw new Error(`${ev.error.code}: ${ev.error.message}`);
      }
      expect(text.join('')).toContain('Paris');
    }));

    // GLM on Mistral ends a reply that ran out of room mid-call with `tool_calls` and the call's input cut off.
    it.skipIf(t.type !== 'mistral' && t.type !== 'mistral-vibe')('reports GLM’s reply that ran out of room in a tool call as cut off', live_(async () => {
      const tool = { name: 'write', description: 'Write a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } };
      const ask = userMessage([{ type: 'text', text: 'Create a complete Minecraft shader pack for Iris with soft sun shadows, wavy water with reflections, volumetric clouds and bloom. Write every file with the write tool.' }]);
      const events: StreamEvent[] = [];
      const limit = 600;
      for await (const ev of live().stream({ model: 'zai-glm-5-3-flash', system: [{ text: 'You are a coding agent. Use the write tool to create files.' }], messages: [ask], tools: [tool], effort: 'low', maxOutputTokens: limit, signal: AbortSignal.timeout(120_000) })) events.push(ev);
      const finish = events.find((e) => e.type === 'finish');
      const used = events.flatMap((e) => (e.type === 'usage' ? [e.usage.output] : [])).at(-1) ?? 0;
      expect(finish?.type === 'finish' && finish.error).toBeFalsy();
      // Every token of the limit used: cut off, whatever Mistral called it. Otherwise each call came whole.
      if (used >= limit) expect(finish?.type === 'finish' && finish.reason).toBe('max_tokens');
      else for (const e of events) if (e.type === 'tool_call_end') expect((e.input as { content?: unknown }).content).toBeTypeOf('string');
    }));

    it.skipIf(t.type !== 'mistral-vibe')('reads the plan’s allowance', live_(async () => {
      const usage = await live().planUsage!();
      // Null when the key may not read the workspace's usage; a reading has a share used.
      if (usage) expect(usage.usedPercent).toBeGreaterThanOrEqual(0);
    }));
  });
}
