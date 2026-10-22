import { describe, expect, it } from 'vitest';
import { chatRequest, collect, deps, finishOf, providerInstance } from './__fixtures__/harness.ts';
import { classifyError, exceptionError, guardStream, postStream, requestJson } from './http.ts';
import type { StreamEvent } from './types.ts';

const instance = providerInstance('openai', 'https://api.openai.com');
const timeout = () => new DOMException('Deadline exceeded', 'TimeoutError');

describe('transient provider errors', () => {
  it.each([
    [429, 'insufficient_quota', 'Quota exceeded'],
    [429, 'usage_limit_reached', 'You have reached your usage limit'],
    [400, 'error', 'Your credit balance is too low'],
    [402, '', 'Payment required'],
    [null, 'error', 'Weekly limit reached'],
  ] as const)('does not retry exhausted plan or API quota (%s %s)', (status, kind, message) => {
    expect(classifyError(instance, status, kind, message)).toMatchObject({ code: 'provider_quota', retryable: false });
  });
  it.each([
    [null, 'error', 'error', 'provider_error'],
    [null, '', 'empty response body', 'provider_error'],
    [null, 'server_error', 'Unavailable', 'provider_busy'],
    [408, '', 'Timed out', 'provider_busy'],
    [429, '', 'Slow down', 'provider_busy'],
    [503, '', 'Unavailable', 'provider_busy'],
  ] as const)('retries %s %s without a settings CTA', (status, kind, message, code) => {
    const error = classifyError(instance, status, kind, message);
    expect(error).toMatchObject({ code, retryable: true });
    expect(error).not.toHaveProperty('fix');
  });

  it.each([
    [401, 'error', 'error', 'provider_auth', 'settings/providers'],
    [null, 'authentication_error', 'Invalid credentials', 'provider_auth', 'settings/providers'],
    [null, 'model_not_found', 'Missing model', 'model_not_found', 'settings/models'],
    [404, '', 'Unknown endpoint', 'provider_error', 'settings/providers'],
    [null, 'error', 'maximum context length exceeded', 'context_overflow', undefined],
    [400, 'error', 'server_error timeout', 'provider_error', undefined],
    [422, 'error', 'failed to parse model output', 'provider_error', undefined],
    [null, 'invalid_prompt', 'Bad prompt', 'provider_error', undefined],
  ] as const)('preserves permanent %s %s failures', (status, kind, message, code, fix) => {
    const error = classifyError(instance, status, kind, message);
    expect(error).toMatchObject({ code, retryable: false });
    expect(error.fix).toBe(fix);
  });

  it.each([new TypeError('fetch failed'), timeout(), Object.assign(new Error('Idle timeout'), { name: 'NoResponseError' })])(
    'maps transport exceptions without settings actions: %s', (error) => {
      const mapped = exceptionError(error, instance);
      expect(mapped).toMatchObject({ code: error instanceof TypeError ? 'provider_offline' : 'provider_timeout', retryable: true });
      expect(mapped).not.toHaveProperty('fix');
    },
  );

  it.each(['post', 'json'] as const)('maps a %s fetch rejection through the stream guard', async (method) => {
    const adapterDeps = deps(async () => { throw new TypeError('fetch failed'); });
    const request = chatRequest();
    const events = await collect(guardStream(request, instance, async function* (): AsyncGenerator<StreamEvent> { yield* [];
      if (method === 'post') await postStream(adapterDeps, instance, instance.baseUrl, {}, {}, request.signal);
      else await requestJson(adapterDeps, instance, instance.baseUrl, { headers: {} });
    }));
    expect(finishOf(events)).toMatchObject({ reason: 'error', error: { code: 'provider_offline', retryable: true } });
    expect(finishOf(events).error).not.toHaveProperty('fix');
  });
});

describe('stream timeout versus cancellation', () => {
  it.each(['throw', 'end'] as const)('reports a composed timeout when the generator %s', async (mode) => {
    const signal = AbortSignal.any([new AbortController().signal, AbortSignal.abort(timeout())]);
    const events = await collect(guardStream(chatRequest({ signal }), instance, async function* (): AsyncGenerator<StreamEvent> { yield* [];
      if (mode === 'throw') throw new DOMException('Aborted by transport', 'AbortError');
    }));
    expect(events).toHaveLength(1);
    expect(finishOf(events)).toMatchObject({ reason: 'error', error: { code: 'provider_timeout', retryable: true } });
    expect(finishOf(events).error).not.toHaveProperty('fix');
  });

  it('reports a transport timeout even without an aborted request signal', async () => {
    const events = await collect(guardStream(chatRequest(), instance, async function* (): AsyncGenerator<StreamEvent> { yield* []; throw timeout(); }));
    expect(finishOf(events)).toMatchObject({ reason: 'error', error: { code: 'provider_timeout', retryable: true } });
  });

  it.each(['throw', 'end'] as const)('keeps caller cancellation aborted when the generator %s', async (mode) => {
    const signal = AbortSignal.abort();
    const events = await collect(guardStream(chatRequest({ signal }), instance, async function* (): AsyncGenerator<StreamEvent> { yield* [];
      if (mode === 'throw') throw timeout();
    }));
    expect(events).toEqual([{ type: 'finish', reason: 'aborted' }]);
  });

  it('does not interpret a transport AbortError as caller cancellation', async () => {
    const events = await collect(guardStream(chatRequest(), instance, async function* (): AsyncGenerator<StreamEvent> { yield* [];
      throw new DOMException('Transport aborted', 'AbortError');
    }));
    expect(finishOf(events).reason).toBe('error');
  });

  it('reports a truncated stream without a settings CTA', async () => {
    const events = await collect(guardStream(chatRequest(), instance, async function* (): AsyncGenerator<StreamEvent> { yield* [];}));
    expect(finishOf(events)).toMatchObject({ reason: 'error', error: { code: 'stream_truncated', retryable: true } });
    expect(finishOf(events).error).not.toHaveProperty('fix');
  });
});
