/**
 * Live smoke tests against real endpoints. Skipped unless configured, through the environment or a
 * gitignored `.env.local` at the repo root:
 *   ANTHROPIC_API_KEY  [ATELIER_LIVE_ANTHROPIC_MODEL=claude-haiku-5-5]
 *   OPENAI_API_KEY     [ATELIER_LIVE_OPENAI_MODEL=gpt-5-mini]
 *   ATELIER_LIVE_OLLAMA_URL        [ATELIER_LIVE_OLLAMA_MODEL, else the first listed]
 *   ATELIER_LIVE_LLAMACPP_URL
 *   ATELIER_LIVE_COMPAT_URL [ATELIER_LIVE_COMPAT_KEY] [ATELIER_LIVE_COMPAT_MODEL]
 * Keys are only passed to the adapters; nothing here prints them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, type TestContext } from 'vitest';
import type { Message, Part, ProviderType } from '@atelier/protocol';
import { createAdapter } from './index.ts';
import type { ProviderAdapter, StreamEvent } from './types.ts';

const envFile = join(import.meta.dirname, '../../../../.env.local');
const fileEnv: Record<string, string> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
    )
  : {};
const env = (name: string): string | undefined => process.env[name] || fileEnv[name] || undefined;

// 1×1 red PNG for the image round trip.
const RED_PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

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
];

for (const t of targets) {
  const configured = t.type === 'anthropic' || t.type === 'openai' ? !!t.key : !!t.url;
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
  });
}
