import { describe, expect, it } from 'vitest';
import type { ProviderType } from '@atelier/protocol';
import { API_KEY, deps, offlineFetch, providerInstance } from './__fixtures__/harness.ts';
import { anthropicCatalog, anthropicRecommendedEffort, clampEffort, openaiCatalog, tierFor } from './catalog.ts';
import { classifyError, extractErrorMessage, redact } from './http.ts';
import { createAdapter } from './index.ts';
import { apiUrl, parseJsonLoose, rootUrl, toBase64 } from './util.ts';

describe('URL joining', () => {
  it.each([
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/chat/completions'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1/chat/completions'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
    [
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
  ])('apiUrl(%s)', (base, expected) => {
    expect(apiUrl(base, '/v1/chat/completions')).toBe(expected);
  });

  it('rootUrl drops a pasted /v1 suffix', () => {
    expect(rootUrl('http://localhost:8080/v1/', '/props')).toBe('http://localhost:8080/props');
    expect(rootUrl('http://localhost:11434', '/api/chat')).toBe('http://localhost:11434/api/chat');
  });
});

describe('error mapping', () => {
  const instance = {
    ...providerInstance('openai', 'https://api.openai.com', API_KEY),
    headers: { 'x-org-token': 'org-secret-123' },
  };

  it.each([
    [401, '', 'invalid key', 'provider_auth', false],
    [403, 'permission_error', 'no access', 'provider_auth', false],
    [404, '', 'model foo not found', 'model_not_found', false],
    [404, '', 'Cannot POST /v2/chat', 'provider_error', false],
    [429, '', 'slow down', 'provider_busy', true],
    [529, 'overloaded_error', 'Overloaded', 'provider_busy', true],
    [503, '', 'down', 'provider_busy', true],
    [400, 'invalid_request_error', 'prompt is too long', 'context_overflow', false],
    [400, 'invalid_request_error', 'input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000', 'context_overflow', false],
    [400, 'context_length_exceeded', 'Input too long', 'context_overflow', false],
    [400, 'exceed_context_size_error', 'the request exceeds the available context size, try increasing it', 'context_overflow', false],
    [500, '', 'input length exceeds the context length', 'context_overflow', false],
    [400, '', 'The number of tokens to keep from the initial prompt is greater than the context length', 'context_overflow', false],
    [400, '', "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens", 'context_overflow', false],
    [429, 'rate_limit_exceeded', 'too many tokens per minute', 'provider_busy', true],
    [400, '', 'bad field', 'provider_error', false],
    [null, 'overloaded_error', 'Overloaded', 'provider_busy', true],
    // Captured from Ollama 0.33 (llama-server backend) when gpt-oss wrote a malformed channel header.
    [500, '', 'llama-server chat error: map[code:500 message:The model produced output that does not match the expected peg-native format type:server_error]', 'model_output_invalid', true],
    [null, '', 'llama-server chat error: map[code:500 message:The model produced output that does not match the expected peg-native format type:server_error]', 'model_output_invalid', true],
    [500, '', 'error parsing tool call: raw=\'{"a":\', err=unexpected end of JSON input', 'model_output_invalid', true],
  ] as const)('%s %s → %s', (status, kind, message, code, retryable) => {
    expect(classifyError(instance, status, kind, message)).toMatchObject({ code, retryable });
  });

  it("says a reply in the wrong format is the model's, not a busy server", () => {
    const error = classifyError(
      providerInstance('ollama', 'http://localhost:11434'),
      500,
      '',
      'llama-server chat error: map[code:500 message:The model produced output that does not match the expected peg-native format type:server_error]',
    );
    expect(error.message).toMatch(/^The model's reply didn't follow its own format/);
    expect(error.message).not.toMatch(/busy/);
  });

  it('redacts the API key and secret header values from messages', () => {
    const error = classifyError(instance, 401, '', `key ${API_KEY} with org-secret-123 rejected`);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain('org-secret-123');
    expect(redact('nothing secret', instance)).toBe('nothing secret');
  });

  it('extracts messages from common error body shapes', () => {
    expect(extractErrorMessage('{"error":{"message":"a"}}')).toBe('a');
    expect(extractErrorMessage('{"error":"b"}')).toBe('b');
    expect(extractErrorMessage('{"detail":"c"}')).toBe('c');
    expect(extractErrorMessage('<html>502</html>')).toBe('');
  });
});

describe('catalog', () => {
  it('matches dated snapshots by longest prefix', () => {
    expect(openaiCatalog('gpt-5-mini-2025-08-07')?.displayName).toBe('GPT-5 mini');
    expect(openaiCatalog('gpt-5-2025-08-07')?.displayName).toBe('GPT-5');
    expect(anthropicCatalog('claude-sonnet-4-5-20250929')?.capabilities.reasoning).toBe('budget');
    expect(anthropicCatalog('claude-opus-5-5')?.contextLength).toBe(1_000_000);
    expect(openaiCatalog('gpt-unknown')).toBeUndefined();
  });

  it('assigns the full tier to hosted frontier models and routed frontier ids', () => {
    expect(tierFor('anthropic', 'anything')).toBe('full');
    expect(tierFor('openai-compatible', 'openai/gpt-6-astra')).toBe('full');
    expect(tierFor('ollama', 'gpt-oss:120b')).toBe('full');
    expect(tierFor('ollama', 'qwen3:8b')).toBe('compact');
    expect(tierFor('llamacpp', 'glm-4.5-air')).toBe('compact');
  });

  it('knows the effort Anthropic recommends per model family and mode', () => {
    expect(anthropicRecommendedEffort('claude-opus-5-5')).toEqual({ code: 'medium', chat: 'medium', work: 'medium' });
    expect(anthropicRecommendedEffort('claude-opus-5-20260601')).toEqual({ code: 'high', chat: 'high', work: 'high' });
    expect(anthropicRecommendedEffort('claude-fable-5-1')).toEqual({ code: 'high', chat: 'medium', work: 'medium' });
    expect(anthropicRecommendedEffort('claude-opus-4-7')?.code).toBe('xhigh');
    expect(anthropicRecommendedEffort('claude-sonnet-4-6')).toEqual({ code: 'high', chat: 'low', work: 'medium' });
    expect(anthropicRecommendedEffort('claude-haiku-4-5')).toBeUndefined();
  });

  it('clamps effort to the nearest supported level', () => {
    const order = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(clampEffort('max', ['low', 'medium', 'high'], order)).toBe('high');
    expect(clampEffort('low', ['medium', 'high'], order)).toBe('medium');
    expect(clampEffort('xhigh', undefined, order)).toBe('xhigh');
  });
});

describe('util', () => {
  it('base64-encodes bytes without Buffer', () => {
    expect(toBase64(new TextEncoder().encode('hello world'))).toBe('aGVsbG8gd29ybGQ=');
    expect(toBase64(new Uint8Array(100_000)).length).toBe(133_336);
  });

  it('repairs loose JSON', () => {
    expect(parseJsonLoose("{'a': 1,}")).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonLoose('').ok).toBe(false);
  });
});

describe('health probe', () => {
  it('says nothing is listening when the connection is refused, naming the host and port', async () => {
    const refused = (cause: unknown) => async () => {
      throw new TypeError('fetch failed', { cause });
    };
    const socketError = Object.assign(new Error('connect ECONNREFUSED 192.168.1.50:11434'), { code: 'ECONNREFUSED' });
    const ollama = createAdapter(providerInstance('ollama', 'http://192.168.1.50:11434'), deps(refused(socketError)));
    expect(await ollama.health()).toMatchObject({ ok: false, error: 'Nothing is listening at 192.168.1.50:11434.' });
    // Both of localhost's addresses refused, and a URL without a port.
    const both = new AggregateError([socketError, socketError]);
    const openai = createAdapter(providerInstance('openai-compatible', 'http://localhost/v1'), deps(refused(both)));
    expect(await openai.health()).toMatchObject({ ok: false, error: 'Nothing is listening at localhost:80.' });
    // Other network failures keep their words.
    expect(await createAdapter(providerInstance('ollama', 'http://192.168.1.50:11434'), deps(offlineFetch())).health()).toMatchObject({ ok: false, error: expect.stringMatching(/^Cannot reach/) });
  });
});

describe('createAdapter', () => {
  it.each(['ollama', 'llamacpp', 'anthropic', 'openai', 'openai-compatible'] satisfies ProviderType[])(
    'creates %s',
    (type) => {
      const adapter = createAdapter(providerInstance(type, 'http://localhost:1'), deps(offlineFetch()));
      expect(adapter.type).toBe(type);
    },
  );
});
