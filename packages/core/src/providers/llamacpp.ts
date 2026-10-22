/**
 * llama.cpp `llama-server` adapter. Chat streaming is the OpenAI-compatible core; discovery uses `/props`
 * (context, modalities, chat template caps) or router mode's `/models`, health uses `/health`, and token
 * counts come from `/tokenize`.
 */
import type { MessageError, Part, ToolSupport } from '@atelier/protocol';
import { DEFAULT_CONTEXT, listedModel } from './catalog.ts';
import { bearer, jsonHeaders, probe, requestJson } from './http.ts';
import { streamChatCompletions, type ChatCompletionsConfig } from './openai-compatible.ts';
import type { AdapterDeps, ChatRequest, ListedModel, ProviderAdapter, ProviderInstance, StreamEvent } from './types.ts';
import { arr, isRecord, mapLimit, num, rec, rootUrl, str } from './util.ts';

/**
 * How the model's chat template can be told to think, read from the template text: a switch (`enable_thinking`, as
 * Qwen3's) or a level (`reasoning_effort`, as gpt-oss's). Both go in the request's `chat_template_kwargs`.
 */
export type ThinkStyle = 'toggle' | 'effort';

interface PropsInfo {
  contextLength?: number;
  think?: ThinkStyle;
  vision: boolean;
  tools: ToolSupport;
  /** Whether `chat_template_caps` was present, i.e. tool support was actually detected. */
  toolsDetected: boolean;
  modelPath?: string;
}

export function parseProps(json: unknown): PropsInfo {
  const props = rec(json);
  const contextLength = num(rec(props.default_generation_settings).n_ctx) ?? num(props.n_ctx);
  const caps = props.chat_template_caps;
  const tools: ToolSupport = !isRecord(caps)
    ? 'native'
    : caps.supports_tools === true || caps.supports_tool_calls === true
      ? 'native'
      : 'prompted';
  const modelPath = str(props.model_path);
  const template = str(props.chat_template) ?? '';
  const think: ThinkStyle | undefined = /enable_thinking/.test(template) ? 'toggle' : /reasoning_effort/.test(template) ? 'effort' : undefined;
  return {
    vision: rec(props.modalities).vision === true,
    ...(think ? { think } : {}),
    tools,
    toolsDetected: isRecord(caps),
    ...(contextLength ? { contextLength } : {}),
    ...(modelPath ? { modelPath } : {}),
  };
}

/** A tool request that failed because the server rendered tools without a Jinja template. */
export function jinjaHint(status: number, error: MessageError, request: ChatRequest): MessageError | null {
  if ((status !== 400 && status !== 500) || !request.tools?.length) return null;
  if (!/jinja|template/i.test(error.message)) return null;
  return {
    code: 'llamacpp_no_jinja',
    message:
      'llama-server cannot render tool calls with its chat template. Start llama-server with --jinja ' +
      '(or a tool-capable --chat-template-file), or switch this model to prompted tools.',
    fix: 'settings/models',
    retryable: false,
  };
}

function partText(part: Part): string {
  switch (part.type) {
    case 'text':
    case 'context':
    case 'thinking':
      return part.text;
    case 'tool_call':
      return JSON.stringify({ name: part.name, arguments: part.input });
    case 'tool_result':
      return part.content.map(partText).join('\n');
    default:
      return '';
  }
}

/** Flatten a request into one prompt-like string; `/tokenize` on it approximates the real templated prompt. */
export function flattenPrompt(request: Pick<ChatRequest, 'system' | 'messages' | 'tools'>): string {
  const sections = [request.system.map((b) => b.text).join('\n\n')];
  if (request.tools?.length) sections.push(JSON.stringify(request.tools));
  for (const message of request.messages) sections.push(`${message.role}: ${message.parts.map(partText).join('\n')}`);
  return sections.filter((s) => s !== '').join('\n\n');
}

/** Per-message template overhead (role markers, separators) not present in the flattened text. */
const MESSAGE_OVERHEAD = 4;

/**
 * What a request tells the model's template, from its effort: a thinking switch is set either way (off when no level
 * is sent), a level is passed when there is one. Servers ignore a key their template doesn't read.
 */
export function templateKwargs(style: ThinkStyle | undefined, effort: ChatRequest['effort']): Record<string, unknown> | undefined {
  if (style === 'toggle') return { chat_template_kwargs: { enable_thinking: !!effort }, reasoning_effort: undefined };
  if (style === 'effort' && effort) {
    return { chat_template_kwargs: { reasoning_effort: effort === 'low' || effort === 'medium' ? effort : 'high' } };
  }
  return undefined;
}

export function createLlamaCppAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const headers = (): Record<string, string> => jsonHeaders(instance, bearer(instance));
  const url = (path: string): string => rootUrl(instance.baseUrl, path);
  /** How each listed model thinks, learned when the models were listed. */
  const thinking = new Map<string, ThinkStyle>();
  const config: ChatCompletionsConfig = {
    instance,
    deps,
    url: url('/v1/chat/completions'),
    headers,
    mapHttpError: jinjaHint,
    extraBody: (request) => templateKwargs(thinking.get(request.model), request.effort),
  };
  const get = (path: string, signal?: AbortSignal): Promise<unknown> =>
    requestJson(deps, instance, url(path), { headers: headers(), ...(signal ? { signal } : {}) });

  function toListed(id: string, props: PropsInfo | null, trainedCtx?: number): ListedModel {
    const contextLength = props?.contextLength ?? trainedCtx ?? DEFAULT_CONTEXT;
    if (props?.think) thinking.set(id, props.think);
    else thinking.delete(id);
    return listedModel(instance, id, {
      displayName: id,
      contextLength,
      maxOutput: Math.min(contextLength, DEFAULT_CONTEXT),
      capabilities: {
        tools: props?.tools ?? 'native',
        vision: props?.vision ?? false,
        pdf: false,
        reasoning: props?.think === 'toggle' ? 'toggle' : props?.think === 'effort' ? 'effort' : 'none',
        caching: false,
      },
      ...(props?.think === 'effort' ? { effortLevels: ['low', 'medium', 'high'] as const } : {}),
      source: props?.toolsDetected ? 'detected' : 'default',
    });
  }

  /** Router mode lists many models with a load status; a single-model server's `/models` has no status. */
  async function routerModels(signal?: AbortSignal): Promise<ListedModel[] | null> {
    let json: unknown;
    try {
      json = await get('/models', signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    }
    const entries = arr(rec(json).data).map(rec);
    if (entries.length === 0 || !entries.every((e) => e.status !== undefined)) return null;
    return mapLimit(entries, 4, async (entry) => {
      const id = str(entry.id) ?? 'model';
      const status = str(entry.status) ?? str(rec(entry.status).value);
      // Only loaded models are asked for props; asking an unloaded one could trigger a load.
      const props =
        status === 'loaded'
          ? await get(`/props?model=${encodeURIComponent(id)}`, signal).then(parseProps, () => null)
          : null;
      return toListed(id, props);
    });
  }

  return {
    type: instance.type,

    async listModels(signal) {
      const routed = await routerModels(signal);
      if (routed) return routed;
      const [props, models] = await Promise.all([
        get('/props', signal).then(parseProps),
        get('/v1/models', signal).catch(() => null),
      ]);
      const first = rec(arr(rec(models).data)[0]);
      const id = str(first.id) ?? props.modelPath?.split(/[\\/]/).pop() ?? 'default';
      return [toListed(id, props, num(rec(first.meta).n_ctx_train))];
    },

    health(signal) {
      return probe(deps, instance, url('/health'), headers(), signal, async (res, latencyMs) => {
        if (res.status !== 503) return null;
        return { ok: false, latencyMs, warnings: ['llama-server is still loading the model'] };
      });
    },

    stream(request) {
      return readingFirst(streamChatCompletions(config, request));
    },

    async serverLimits(signal) {
      // `--parallel` slots, all for the one model this server holds. A router's own /props has no slots.
      const slots = num(rec(await get('/props', signal)).total_slots);
      return slots ? { parallel: slots, modelsAtOnce: 1 } : {};
    },

    async countTokens(request) {
      const json = await requestJson(deps, instance, url('/tokenize'), {
        method: 'POST',
        headers: headers(),
        body: { content: flattenPrompt(request) },
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return arr(rec(json).tokens).length + request.messages.length * MESSAGE_OVERHEAD;
    },
  };
}

/** A llama-server holds the one model it serves: before any output it is reading the prompt. */
async function* readingFirst(events: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
  yield { type: 'phase', phase: 'reading' };
  yield* events;
}
