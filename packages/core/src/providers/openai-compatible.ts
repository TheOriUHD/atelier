/**
 * OpenAI-compatible Chat Completions adapter (LM Studio, vLLM, OpenRouter, Groq, …). The request/stream core is
 * exported for the llama.cpp adapter, which speaks the same protocol plus a few server-specific endpoints.
 */
import { presetOf, type MessageError, type Part, type StopReason, type Usage } from '@atelier/protocol';
import { DEFAULT_CONTEXT, listedModel } from './catalog.ts';
import { bearer, classifyError, guardStream, jsonHeaders, postStream, probe, requestJson } from './http.ts';
import { parseSSE } from './sse.ts';
import type { AdapterDeps, ChatRequest, ListedModel, ProviderAdapter, ProviderInstance, StreamEvent } from './types.ts';
import {
  apiUrl,
  arr,
  dataUrl,
  documentAsText,
  isRecord,
  newCallId,
  num,
  parseToolInput,
  rec,
  str,
  strings,
  textOf,
} from './util.ts';

type CCMessage = Record<string, unknown>;
type ContentItem = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

async function userContent(parts: readonly Part[], deps: AdapterDeps): Promise<string | ContentItem[]> {
  const texts = [textOf(parts)];
  const images: ContentItem[] = [];
  for (const part of parts) {
    if (part.type === 'image')
      images.push({ type: 'image_url', image_url: { url: dataUrl(part.mime, await deps.readBlob(part.blob)) } });
    if (part.type === 'document') texts.push(documentAsText(part, await deps.readBlob(part.blob)));
  }
  const text = texts.filter((t) => t !== '').join('\n\n');
  if (images.length === 0) return text;
  return text ? [{ type: 'text', text }, ...images] : images;
}

function assistantMessage(parts: readonly Part[], providerType: string): CCMessage {
  const calls = parts.flatMap((p) => (p.type === 'tool_call' ? [p] : []));
  const text = textOf(parts);
  const msg: CCMessage = { role: 'assistant', content: text || (calls.length > 0 ? null : '') };
  if (calls.length > 0) {
    msg.tool_calls = calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
    }));
  }
  // OpenRouter asks for reasoning_details to be sent back verbatim to keep reasoning across tool calls.
  const details = parts.flatMap((p) =>
    p.type === 'thinking' && p.provider === providerType && Array.isArray(p.replay) ? (p.replay as unknown[]) : [],
  );
  if (details.length > 0) msg.reasoning_details = details;
  return msg;
}

export async function toChatCompletionsMessages(
  request: Pick<ChatRequest, 'system' | 'messages'>,
  deps: AdapterDeps,
  providerType: string,
): Promise<CCMessage[]> {
  const out: CCMessage[] = [];
  const system = request.system.map((b) => b.text).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  // Tool messages cannot carry images, so they follow the tool block as one user message.
  let pendingImages: ContentItem[] = [];
  const flushImages = (): void => {
    if (pendingImages.length === 0) return;
    out.push({
      role: 'user',
      content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...pendingImages],
    });
    pendingImages = [];
  };

  for (const message of request.messages) {
    const results = message.parts.flatMap((p) => (p.type === 'tool_result' ? [p] : []));
    if (results.length === 0) flushImages();
    if (message.role === 'assistant') {
      out.push(assistantMessage(message.parts, providerType));
      continue;
    }
    for (const result of results) {
      const content = await userContent(result.content, deps);
      const text =
        typeof content === 'string' ? content : content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
      if (typeof content !== 'string') pendingImages.push(...content.filter((c) => c.type === 'image_url'));
      out.push({ role: 'tool', tool_call_id: result.callId, content: result.isError ? `Error: ${text}` : text });
    }
    const rest = message.parts.filter((p) => p.type !== 'tool_result');
    if (rest.length === 0) continue;
    flushImages();
    out.push({ role: 'user', content: await userContent(rest, deps) });
  }
  flushImages();
  return out;
}

export function chatCompletionsBody(request: ChatRequest, messages: CCMessage[]): Record<string, unknown> {
  const tools = request.toolChoice === 'none' ? undefined : request.tools;
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxOutputTokens,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    if (typeof request.toolChoice === 'object') {
      body.tool_choice = { type: 'function', function: { name: request.toolChoice.name } };
    }
  }
  // Servers that take a level know low, medium and high: everything above asks for high.
  if (request.effort) body.reasoning_effort = request.effort === 'low' || request.effort === 'medium' ? request.effort : 'high';
  return body;
}

function mapUsage(raw: Record<string, unknown>): Usage {
  const prompt = num(raw.prompt_tokens) ?? 0;
  const cached = num(rec(raw.prompt_tokens_details).cached_tokens) ?? 0;
  const usage: Usage = { input: Math.max(prompt - cached, 0), output: num(raw.completion_tokens) ?? 0 };
  if (cached > 0) usage.cacheRead = cached;
  const reasoning = num(rec(raw.completion_tokens_details).reasoning_tokens);
  if (reasoning) usage.reasoning = reasoning;
  return usage;
}

/** llama.cpp `timings` → throughput, and usage when the server did not send a usage block. */
function applyTimings(usage: Usage | undefined, timings: Record<string, unknown>): Usage {
  const out: Usage = usage
    ? { ...usage }
    : { input: num(timings.prompt_n) ?? 0, output: num(timings.predicted_n) ?? 0 };
  const tps = num(timings.predicted_per_second);
  if (tps !== undefined) out.tokensPerSecond = tps;
  const ms = (num(timings.prompt_ms) ?? 0) + (num(timings.predicted_ms) ?? 0);
  if (ms > 0) out.durationMs = ms;
  return out;
}

function mapFinishReason(reason: string | undefined, sawTool: boolean): StopReason {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  if (reason === 'tool_calls' || reason === 'function_call' || sawTool) return 'tool_use';
  return 'end';
}

/** Merge streamed `reasoning_details` fragments by index, concatenating their text fields. */
function mergeReasoningDetails(into: Record<string, unknown>[], fragments: unknown[]): void {
  for (const fragment of fragments) {
    if (!isRecord(fragment)) continue;
    const index = num(fragment.index) ?? into.length;
    const target = into[index];
    if (!target) {
      into[index] = { ...fragment };
      continue;
    }
    for (const [key, value] of Object.entries(fragment)) {
      const prev = target[key];
      const concat = (key === 'text' || key === 'summary' || key === 'data') && typeof prev === 'string';
      target[key] = concat && typeof value === 'string' ? prev + value : value;
    }
  }
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

/** Accumulates tool-call deltas by `index`, emitting start once the name is known. */
class ToolCallMerger {
  private readonly calls = new Map<number, PendingCall>();

  get size(): number {
    return this.calls.size;
  }

  *add(raw: unknown): Generator<StreamEvent> {
    const delta = rec(raw);
    const fn = rec(delta.function);
    const id = str(delta.id);
    const index = num(delta.index) ?? this.indexWithout(id, str(fn.name));
    let call = this.calls.get(index);
    if (!call) {
      call = { id: id || newCallId(), name: '', args: '', started: false };
      this.calls.set(index, call);
    }
    if (!call.started) {
      if (id) call.id = id;
      const name = str(fn.name);
      if (name) call.name = name;
    }
    const args = str(fn.arguments) ?? (isRecord(fn.arguments) ? JSON.stringify(fn.arguments) : '');
    call.args += args;
    if (!call.started && call.name) {
      call.started = true;
      yield { type: 'tool_call_start', id: call.id, name: call.name };
      if (call.args) yield { type: 'tool_call_delta', id: call.id, json: call.args };
    } else if (call.started && args) {
      yield { type: 'tool_call_delta', id: call.id, json: args };
    }
  }

  *finish(): Generator<StreamEvent> {
    for (const index of [...this.calls.keys()].sort((a, b) => a - b)) {
      const call = this.calls.get(index)!;
      if (!call.started) yield { type: 'tool_call_start', id: call.id, name: call.name };
      yield { type: 'tool_call_end', id: call.id, input: parseToolInput(call.args) };
    }
    this.calls.clear();
  }

  /** Servers that omit `index`: a new id or a second name opens a new call, anything else continues the latest. */
  private indexWithout(id: string | undefined, name: string | undefined): number {
    const known = [...this.calls.entries()].find(([, c]) => c.id === id);
    if (known) return known[0];
    const latest = this.calls.get(this.calls.size - 1);
    const opensNew = !latest || !!id || (!!name && latest.started);
    return opensNew ? this.calls.size : this.calls.size - 1;
  }
}

export interface ChatCompletionsConfig {
  instance: ProviderInstance;
  deps: AdapterDeps;
  url: string;
  headers: () => Record<string, string>;
  /** Replace the default HTTP error (e.g. llama.cpp's missing `--jinja`); return null to keep it. */
  mapHttpError?: (status: number, error: MessageError, request: ChatRequest) => MessageError | null;
  /** Fields for this server that go over the body's (a key set to `undefined` drops it): llama.cpp's template switches. */
  extraBody?: (request: ChatRequest) => Record<string, unknown> | undefined;
}

async function* runChatCompletions(config: ChatCompletionsConfig, request: ChatRequest): AsyncGenerator<StreamEvent> {
  const { instance, deps } = config;
  const messages = await toChatCompletionsMessages(request, deps, instance.type);
  const res = await postStream(
    deps,
    instance,
    config.url,
    config.headers(),
    { ...chatCompletionsBody(request, messages), ...config.extraBody?.(request) },
    request.signal,
  );
  if (!res.ok) {
    yield {
      type: 'finish',
      reason: 'error',
      error: config.mapHttpError?.(res.status, res.error, request) ?? res.error,
    };
    return;
  }

  const calls = new ToolCallMerger();
  const details: Record<string, unknown>[] = [];
  let usage: Usage | undefined;
  let timings: Record<string, unknown> | undefined;
  let finishReason: string | undefined;

  for await (const event of parseSSE(res.body, request.signal)) {
    let chunk: Record<string, unknown>;
    try {
      chunk = rec(JSON.parse(event.data));
    } catch {
      continue;
    }
    if (chunk.error !== undefined) {
      const error = rec(chunk.error);
      const kind = str(error.type) ?? str(error.code) ?? '';
      const message = str(error.message) ?? str(chunk.error) ?? 'stream error';
      // OpenRouter reports upstream failures mid-stream with an HTTP-like numeric code.
      const code = num(error.code);
      const status = code !== undefined && code >= 400 && code < 600 ? code : null;
      yield { type: 'finish', reason: 'error', error: classifyError(instance, status, kind, message) };
      return;
    }
    if (isRecord(chunk.usage)) usage = mapUsage(chunk.usage);
    if (isRecord(chunk.timings)) timings = chunk.timings;

    const choice = rec(arr(chunk.choices)[0]);
    const delta = rec(choice.delta);
    const reasoning = str(delta.reasoning_content) || str(delta.reasoning);
    if (reasoning) yield { type: 'thinking', delta: reasoning };
    const fragments = arr(delta.reasoning_details);
    if (fragments.length > 0) {
      mergeReasoningDetails(details, fragments);
      if (!reasoning) {
        for (const f of fragments) {
          const text = str(rec(f).text) ?? str(rec(f).summary);
          if (text) yield { type: 'thinking', delta: text };
        }
      }
    }
    const content = str(delta.content);
    if (content) yield { type: 'text', delta: content };
    for (const call of arr(delta.tool_calls)) yield* calls.add(call);
    finishReason = str(choice.finish_reason) ?? finishReason;
  }

  // A stream without a finish_reason or usage block was cut off; the guard reports it as truncated.
  if (finishReason === undefined && usage === undefined && timings === undefined) return;
  const sawTool = calls.size > 0;
  yield* calls.finish();
  if (details.length > 0) yield { type: 'thinking_replay', data: details.filter(isRecord) };
  const finalUsage = timings ? applyTimings(usage, timings) : usage;
  if (finalUsage) yield { type: 'usage', usage: finalUsage };
  yield { type: 'finish', reason: mapFinishReason(finishReason, sawTool) };
}

export function streamChatCompletions(config: ChatCompletionsConfig, request: ChatRequest): AsyncIterable<StreamEvent> {
  return guardStream(request, config.instance, () => runChatCompletions(config, request));
}

const NON_CHAT = /embed|whisper|tts|dall-e|moderation|rerank|transcri/i;

/** Model entry from `/v1/models`, enriched by OpenRouter/vLLM/Groq metadata when present. */
export function modelFromMetadata(instance: ProviderInstance, raw: unknown): ListedModel | null {
  const m = rec(raw);
  const id = str(m.id);
  if (!id || NON_CHAT.test(id)) return null;
  const top = rec(m.top_provider);
  const declared =
    num(m.context_length) ??
    num(m.max_model_len) ??
    num(m.context_window) ??
    num(m.max_context_length) ??
    num(top.context_length);
  const inputs = strings(rec(m.architecture).input_modalities);
  const params = strings(m.supported_parameters);
  const openrouter = presetOf(instance.baseUrl) === 'openrouter';
  const pricing = rec(m.pricing);
  const free = id.endsWith(':free') || (str(pricing.prompt) === '0' && str(pricing.completion) === '0');
  const contextLength = declared ?? DEFAULT_CONTEXT;
  const effort = params.includes('reasoning') || params.includes('reasoning_effort');
  const hasMeta = declared !== undefined || inputs.length > 0 || params.length > 0;
  return listedModel(instance, id, {
    displayName: str(m.name) ?? id,
    contextLength,
    maxOutput: num(top.max_completion_tokens) ?? Math.min(contextLength, 8192),
    capabilities: {
      // OpenRouter routes a request with tools only to endpoints that take them: a model it lists without them has none.
      tools: params.length === 0 || params.includes('tools') ? 'native' : openrouter ? 'none' : 'prompted',
      vision: inputs.includes('image'),
      pdf: inputs.includes('file'),
      reasoning: effort ? 'effort' : 'none',
      caching: false,
    },
    source: hasMeta ? 'detected' : 'default',
    ...(effort ? { effortLevels: ['low', 'medium', 'high'] } : {}),
    ...(free ? { free: true } : {}),
  });
}

/** OpenRouter's app attribution: who sends the requests, shown in the person's activity. */
export const OPENROUTER_ATTRIBUTION = { 'HTTP-Referer': 'https://atelierhq.dev', 'X-OpenRouter-Title': 'Atelier', 'X-Title': 'Atelier' };

/** OpenCode Zen lists its models outside the OpenAI-shaped path it serves them on. */
function modelsUrlOf(baseUrl: string): string {
  if (presetOf(baseUrl) === 'opencode-zen') return apiUrl(baseUrl.replace(/\/openai(?=\/v\d|\/?$)/, ''), '/v1/models');
  return apiUrl(baseUrl, '/v1/models');
}

export function createOpenAICompatibleAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const attribution = presetOf(instance.baseUrl) === 'openrouter' ? OPENROUTER_ATTRIBUTION : {};
  const headers = (): Record<string, string> => ({ ...attribution, ...jsonHeaders(instance, bearer(instance)) });
  const modelsUrl = modelsUrlOf(instance.baseUrl);
  const config: ChatCompletionsConfig = {
    instance,
    deps,
    url: apiUrl(instance.baseUrl, '/v1/chat/completions'),
    headers,
  };

  return {
    type: instance.type,

    async listModels(signal) {
      const json = await requestJson(deps, instance, modelsUrl, { headers: headers(), ...(signal ? { signal } : {}) });
      return arr(rec(json).data)
        .map((m) => modelFromMetadata(instance, m))
        .filter((m): m is ListedModel => m !== null);
    },

    health(signal) {
      return probe(deps, instance, modelsUrl, headers(), signal);
    },

    stream(request) {
      return streamChatCompletions(config, request);
    },
  };
}
