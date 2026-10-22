/**
 * Ollama native API adapter: `/api/chat` (NDJSON), `/api/tags` + `/api/show` for discovery, `/api/version` for health.
 * Always sends `options.num_ctx` because the server default context is VRAM-dependent.
 */
import { createHash } from 'node:crypto';
import type { Effort, Part, RunPhase, StopReason, Usage } from '@atelier/protocol';
import { DEFAULT_CONTEXT, clampEffort, listedModel } from './catalog.ts';
import { contextMetadata, estimateContext, type ContextMetadata } from './context-estimator.ts';
import { withPromptedTools } from './prompted-tools.ts';
import { bearer, classifyError, guardStream, jsonHeaders, postStream, probe, requestJson } from './http.ts';
import { parseNDJSON } from './ndjson.ts';
import type { AdapterDeps, ChatRequest, ListedModel, ProviderAdapter, ProviderInstance, StreamEvent } from './types.ts';
import {
  arr,
  documentAsText,
  mapLimit,
  newCallId,
  num,
  parseToolInput,
  rec,
  rootUrl,
  str,
  strings,
  textOf,
  toBase64,
} from './util.ts';

interface ShowInfo {
  capabilities: string[];
  contextLength?: number;
  contextMetadata?: ContextMetadata;
  thinkLevels: string[];
  /**
   * Where replayed reasoning goes when the server renders the model's own Jinja template (Ollama 0.33's
   * llama-server backend), which drops an assistant message's `thinking`: `analysis` puts it in the `content` of a
   * tool-calling message, which gpt-oss's template renders as that turn's analysis; `think-tags` wraps it in
   * `<think>` ahead of the text, which Qwen-style templates split out of `content` and show for the steps since the
   * person's last message (and drop before it). Otherwise it stays in `thinking`.
   */
  replay?: 'analysis' | 'think-tags';
}

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: { id: string; function: { name: string; arguments: unknown } }[];
  tool_name?: string;
  tool_call_id?: string;
};

const EFFORT_ORDER = ['low', 'medium', 'high'];
/**
 * Families whose `think` takes a level although `/api/show` may not list any (Ollama 0.33 lists none): gpt-oss
 * reasons at low, medium or high and can't stop reasoning, so `true`/`false` would hide its real control.
 */
const LEVELED_FAMILIES: Record<string, string[]> = { 'gpt-oss': EFFORT_ORDER };

export function parseShow(json: unknown): ShowInfo {
  const body = rec(json);
  const capabilities = strings(body.capabilities);
  const modelInfo = rec(body.model_info);
  const architecture = str(modelInfo['general.architecture']);
  const ctxKey = architecture ? `${architecture}.context_length` : Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
  const contextLength = ctxKey ? num(modelInfo[ctxKey]) : undefined;
  const metadata = contextMetadata(modelInfo);
  const listed = strings(rec(body.thinking).values);
  const details = rec(body.details);
  const families = [str(details.family), ...strings(details.families)].filter((f): f is string => !!f);
  const known = families.map((f) => LEVELED_FAMILIES[f]).find((levels) => levels !== undefined);
  const thinkLevels = listed.length > 0 ? listed : capabilities.includes('thinking') && known ? [...known] : [];
  const template = str(body.template) ?? '';
  const jinja = template.includes('{%');
  const replay = !jinja
    ? undefined
    : families.includes('gpt-oss')
      ? 'analysis'
      : /'<\/think>' in (?:message\.)?content/.test(template)
        ? 'think-tags'
        : undefined;
  return { capabilities, thinkLevels, ...(contextLength ? { contextLength } : {}), ...(metadata ? { contextMetadata: metadata } : {}), ...(replay ? { replay } : {}) };
}

/**
 * `think` value: a level when the model accepts levels, `true` for plain thinking models, `false` for those with the
 * switch off (they think when it's left out: qwen3.6 wrote 2,600 characters of reasoning for a one-line answer), and
 * omitted for models without thinking or whose reasoning can't be turned off (gpt-oss).
 */
export function thinkParam(effort: Effort | null | undefined, info: ShowInfo | null): string | boolean | undefined {
  if (info && info.capabilities.length > 0 && !info.capabilities.includes('thinking')) return undefined;
  if (!effort) return info?.capabilities.includes('thinking') && info.thinkLevels.length === 0 ? false : undefined;
  if (info && info.thinkLevels.length > 0) {
    const mapped = effort === 'low' || effort === 'medium' ? effort : 'high';
    return clampEffort(mapped, info.thinkLevels, EFFORT_ORDER);
  }
  return true;
}

/**
 * Reasoning replayed inside `content`, kept from closing or opening the template's own markers: a `</think>` in it
 * would end the reasoning early for Qwen's template, and `<|channel|>…` makes gpt-oss's template refuse the request.
 */
function asText(reasoning: string): string {
  return reasoning.replace(/<(\/?)think>/g, '<$1 think>').replaceAll('<|', '< |');
}

/**
 * The id a call is sent back under: nine letters and digits, derived from Atelier's id so a call and its result
 * still match. Mistral's template refuses anything else ("Tool call IDs should be alphanumeric strings with length
 * 9"), although Ollama's llama-server backend hands out 32-character ids itself; other templates ignore ids.
 */
export function historyCallId(id: string): string {
  if (/^[A-Za-z0-9]{9}$/.test(id)) return id;
  return createHash('sha256')
    .update(id)
    .digest('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 9);
}

async function userContent(parts: readonly Part[], deps: AdapterDeps): Promise<{ content: string; images: string[] }> {
  const texts = [textOf(parts)];
  const images: string[] = [];
  for (const part of parts) {
    if (part.type === 'image') images.push(toBase64(await deps.readBlob(part.blob)));
    if (part.type === 'document') texts.push(documentAsText(part, await deps.readBlob(part.blob)));
  }
  return { content: texts.filter((t) => t !== '').join('\n\n'), images };
}

export async function toOllamaMessages(
  request: ChatRequest,
  deps: AdapterDeps,
  info?: ShowInfo | null,
): Promise<OllamaMessage[]> {
  const out: OllamaMessage[] = [];
  const system = request.system.map((b) => b.text).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  const toolNames = new Map<string, string>();

  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const msg: OllamaMessage = { role: 'assistant', content: textOf(message.parts) };
      // Only Ollama's own reasoning goes back (another provider's may be a summary, or belong to another model).
      const thinking = message.parts
        .flatMap((p) => (p.type === 'thinking' && !p.redacted && p.provider === 'ollama' ? [p.text] : []))
        .join('');
      const calls = message.parts.flatMap((p) => (p.type === 'tool_call' ? [p] : []));
      // Without its reasoning a tool-calling gpt-oss turn is a bare call, and gpt-oss then often writes a malformed
      // channel header the server can't parse (7 of 30 replays of failing turns worked; 28 of 28 with this).
      if (thinking && info?.replay === 'analysis' && calls.length > 0 && msg.content === '')
        msg.content = asText(thinking);
      else if (thinking && info?.replay === 'think-tags')
        msg.content = `<think>\n${asText(thinking)}\n</think>\n\n${msg.content}`;
      else if (thinking) msg.thinking = thinking;
      if (calls.length > 0) {
        msg.tool_calls = calls.map((c) => ({
          id: historyCallId(c.id),
          function: { name: c.name, arguments: c.input ?? {} },
        }));
        for (const c of calls) toolNames.set(c.id, c.name);
      }
      out.push(msg);
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== 'tool_result') continue;
      const { content, images } = await userContent(part.content, deps);
      const tool: OllamaMessage = { role: 'tool', content: part.isError ? `Error: ${content}` : content };
      const name = toolNames.get(part.callId);
      if (name) tool.tool_name = name;
      tool.tool_call_id = historyCallId(part.callId);
      if (images.length > 0) tool.images = images;
      out.push(tool);
    }
    const rest = message.parts.filter((p) => p.type !== 'tool_result');
    if (rest.length === 0) continue;
    const { content, images } = await userContent(rest, deps);
    out.push(images.length > 0 ? { role: 'user', content, images } : { role: 'user', content });
  }
  return out;
}

/** How long the adapter asks `/api/ps` before giving up on telling loading from reading. */
export const PS_TIMEOUT_MS = 800;

/** `llama3` and `llama3:latest` name the same model. */
const withTag = (name: string): string => (name.includes(':') ? name : `${name}:latest`);

function mapDoneReason(reason: string | undefined, sawTool: boolean): StopReason {
  if (sawTool) return 'tool_use';
  return reason === 'length' ? 'max_tokens' : 'end';
}

function usageFrom(chunk: Record<string, unknown>): Usage {
  const output = num(chunk.eval_count) ?? 0;
  const prompt = num(chunk.prompt_eval_count) ?? 0;
  // Ollama 0.33 counts the whole prompt and reports the part its prompt cache served apart; older servers count
  // only the evaluated part and leave the field out.
  const cached = Math.min(num(chunk.prompt_eval_cached_count) ?? 0, prompt);
  const usage: Usage = { input: prompt - cached, output };
  if (cached > 0) usage.cacheRead = cached;
  const total = num(chunk.total_duration);
  if (total !== undefined) usage.durationMs = total / 1e6;
  const evalNs = num(chunk.eval_duration);
  if (evalNs) usage.tokensPerSecond = (output / evalNs) * 1e9;
  return usage;
}

export function createOllamaAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const headers = (): Record<string, string> => jsonHeaders(instance, bearer(instance));
  const url = (path: string): string => rootUrl(instance.baseUrl, path);
  const shows = new Map<string, Promise<ShowInfo | null>>();
  const promptedModels = new Set<string>();

  function show(model: string, signal?: AbortSignal): Promise<ShowInfo | null> {
    const cached = shows.get(model);
    if (cached) return cached;
    const pending = requestJson(deps, instance, url('/api/show'), {
      method: 'POST',
      headers: headers(),
      body: { model },
      ...(signal ? { signal } : {}),
    }).then(parseShow, () => null);
    shows.set(model, pending);
    void pending.then((info) => {
      if (!info) shows.delete(model);
    });
    return pending;
  }

  /**
   * Whether the server holds `model` in memory now (`/api/ps`): `reading` when it does, `loading` when the request
   * will load it first; null when the server doesn't answer in time or the answer is unreadable.
   */
  async function phaseOf(model: string, signal: AbortSignal): Promise<RunPhase | null> {
    try {
      const json = await requestJson(deps, instance, url('/api/ps'), {
        headers: headers(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(PS_TIMEOUT_MS)]),
      });
      const models = rec(json).models;
      if (!Array.isArray(models)) return null;
      const wanted = withTag(model);
      const loaded = models.some((m) => [str(rec(m).name), str(rec(m).model)].some((n) => n !== undefined && withTag(n) === wanted));
      return loaded ? 'reading' : 'loading';
    } catch {
      return null;
    }
  }

  async function* run(request: ChatRequest): AsyncGenerator<StreamEvent> {
    if (request.tools?.length && promptedModels.has(request.model)) {
      yield* prompted.stream(request);
      return;
    }
    // What the model accepts decides `think` and where replayed reasoning goes (looked up once per model).
    const info = await show(request.model, request.signal);
    const think = thinkParam(request.effort, info);
    const tools = request.toolChoice === 'none' ? undefined : request.tools;
    const body = {
      model: request.model,
      messages: await toOllamaMessages(request, deps, info),
      stream: true,
      options: {
        num_ctx: request.contextLength ?? DEFAULT_CONTEXT,
        num_predict: request.maxOutputTokens,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      },
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(think === undefined ? {} : { think }),
    };

    const phase = await phaseOf(request.model, request.signal);
    if (phase) yield { type: 'phase', phase };
    const res = await postStream(deps, instance, url('/api/chat'), headers(), body, request.signal);
    if (!res.ok) {
      // Some Ollama/llama.cpp backends cannot compile otherwise valid tool schemas into a grammar.
      if (tools?.length && /failed to parse grammar|failed to initialize samplers/i.test(res.error.message)) {
        promptedModels.add(request.model);
        yield* prompted.stream(request);
        return;
      }
      yield { type: 'finish', reason: 'error', error: res.error };
      return;
    }

    let sawTool = false;
    for await (const value of parseNDJSON(res.body, request.signal)) {
      const chunk = rec(value);
      const error = str(chunk.error);
      if (error) {
        yield { type: 'finish', reason: 'error', error: classifyError(instance, null, '', error) };
        return;
      }
      const message = rec(chunk.message);
      const thinking = str(message.thinking);
      if (thinking) yield { type: 'thinking', delta: thinking };
      const content = str(message.content);
      if (content) yield { type: 'text', delta: content };
      for (const call of arr(message.tool_calls)) {
        const fn = rec(rec(call).function);
        const raw = fn.arguments;
        const input = typeof raw === 'string' ? parseToolInput(raw) : (raw ?? {});
        const id = str(rec(call).id) || newCallId();
        sawTool = true;
        yield { type: 'tool_call_start', id, name: str(fn.name) ?? '' };
        yield { type: 'tool_call_delta', id, json: JSON.stringify(input) };
        yield { type: 'tool_call_end', id, input };
      }
      if (chunk.done === true) {
        yield { type: 'usage', usage: usageFrom(chunk) };
        yield { type: 'finish', reason: mapDoneReason(str(chunk.done_reason), sawTool) };
        return;
      }
    }
  }

  function toListed(name: string, info: ShowInfo | null, modelBytes?: number): ListedModel {
    const caps = info?.capabilities ?? [];
    // Estimate from real weights + architecture when a budget is supplied. Otherwise retain the existing
    // at-most-32k default (ARCHITECTURE §9-A). Settings › Admin › Models overrides this after discovery.
    const contextLength = estimateContext({ ...instance, modelBytes, metadata: info?.contextMetadata })
      ?? Math.min(info?.contextLength ?? DEFAULT_CONTEXT, DEFAULT_CONTEXT);
    const thinking = caps.includes('thinking');
    return listedModel(instance, name, {
      displayName: name,
      contextLength,
      maxOutput: Math.min(contextLength, DEFAULT_CONTEXT),
      ...(modelBytes && info?.contextMetadata ? { contextEstimate: { modelBytes, metadata: info.contextMetadata } } : {}),
      capabilities: {
        // Without a capabilities list (old servers) native support is assumed but unverified (source 'default').
        tools: caps.length === 0 || caps.includes('tools') ? 'native' : 'prompted',
        vision: caps.includes('vision'),
        pdf: false,
        reasoning: !thinking ? 'none' : info && info.thinkLevels.length > 0 ? 'effort' : 'toggle',
        caching: false,
      },
      source: caps.length > 0 ? 'detected' : 'default',
      ...(thinking && info && info.thinkLevels.length > 0 ? { effortLevels: info.thinkLevels } : {}),
    });
  }

  const adapter: ProviderAdapter = {
    type: instance.type,

    async listModels(signal) {
      shows.clear();
      const tags = await requestJson(deps, instance, url('/api/tags'), {
        headers: headers(),
        ...(signal ? { signal } : {}),
      });
      const models = arr(rec(tags).models).flatMap((m) => {
        const tag = rec(m);
        const name = str(tag.name) ?? str(tag.model);
        return name ? [{ name, modelBytes: num(tag.size) }] : [];
      });
      const infos = await mapLimit(models, 4, async (model) => ({ ...model, info: await show(model.name, signal) }));
      return infos
        .filter(({ info }) => !info || info.capabilities.length === 0 || info.capabilities.includes('completion'))
        .map(({ name, info, modelBytes }) => toListed(name, info, modelBytes));
    },

    health(signal) {
      return probe(deps, instance, url('/api/version'), headers(), signal, async (res, latencyMs) => {
        if (!res.ok) return null;
        const version = str(rec(await res.json().catch(() => null)).version);
        return { ok: true, latencyMs, warnings: [], ...(version ? { version } : {}) };
      });
    },

    stream(request) {
      return guardStream(request, instance, () => run(request));
    },
  };
  const prompted = withPromptedTools(adapter);
  return adapter;
}
