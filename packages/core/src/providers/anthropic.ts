/**
 * Anthropic Messages API adapter (`/v1/messages` SSE, `/v1/messages/count_tokens`, `/v1/models`).
 * Request rules: adaptive thinking with summarized display and `output_config.effort` on current models, budget
 * thinking on ≤4.5, no sampling parameters on 4.7+/5.x, never a forced tool_choice, ≤4 cache breakpoints, and
 * signed thinking blocks replayed verbatim.
 */
import type { DocumentPart, Effort, Part, StopReason, Usage } from '@atelier/protocol';
import { ANTHROPIC_EFFORTS, anthropicCatalog, anthropicRecommendedEffort, clampEffort, listedModel, providerEffort } from './catalog.ts';
import { classifyError, guardStream, jsonHeaders, postStream, probe, requestJson } from './http.ts';
import { parseSSE } from './sse.ts';
import type { AdapterDeps, ChatRequest, ListedModel, ProviderAdapter, ProviderInstance, StreamEvent } from './types.ts';
import { apiUrl, arr, isRecord, isTextDocument, num, parseToolInput, rec, str, strings, toBase64 } from './util.ts';

export const ANTHROPIC_VERSION = '2023-06-01';
const MAX_BREAKPOINTS = 4;
const EPHEMERAL = { type: 'ephemeral' } as const;

type Block = Record<string, unknown>;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

/** `claude-3-7-sonnet-…` → 3.7, `claude-sonnet-4-5-20250929` → 4.5, `claude-opus-4-20250514` → 4.0. */
export function claudeVersion(id: string): { major: number; minor: number } | null {
  const legacy = /^claude-(\d+)(?:[-.](\d))?-[a-z]/.exec(id);
  const modern = legacy ? null : /^claude-[a-z]+-(\d+)(?:[-.](\d{1,2}))?(?=$|[-@:])/.exec(id);
  const m = legacy ?? modern;
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : 0 };
}

/** Models up to 4.5 only know `thinking: {type: "enabled", budget_tokens}`. Unknown ids are treated as current. */
export function usesBudgetThinking(id: string): boolean {
  const v = claudeVersion(id);
  return v !== null && (v.major < 4 || (v.major === 4 && v.minor <= 5));
}

/** 4.7+ and 5.x reject temperature/top_p/top_k. Unknown ids are treated as current. */
export function allowsSampling(id: string): boolean {
  const v = claudeVersion(id);
  return v !== null && (v.major < 4 || (v.major === 4 && v.minor < 7));
}

/** count_tokens takes the prompt-shaping fields only (no max_tokens, stream or sampling). */
const COUNT_TOKENS_FIELDS = new Set(['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking']);

const BUDGETS: Record<Exclude<Effort, 'ultracode'>, number> = { low: 4_000, medium: 10_000, high: 20_000, xhigh: 32_000, max: 48_000 };
const MIN_BUDGET = 1_024;

function signatureOf(replay: unknown): string | undefined {
  return str(replay) ?? str(rec(replay).signature);
}

function redactedDataOf(replay: unknown): string | undefined {
  return str(replay) ?? str(rec(replay).data);
}

async function documentBlock(part: DocumentPart, deps: AdapterDeps): Promise<Block> {
  const bytes = await deps.readBlob(part.blob);
  if (part.mime === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: part.mime, data: toBase64(bytes) },
      title: part.name,
    };
  }
  if (isTextDocument(part.mime)) {
    const data = new TextDecoder().decode(bytes);
    return { type: 'document', source: { type: 'text', media_type: 'text/plain', data }, title: part.name };
  }
  return { type: 'text', text: `[Attached file "${part.name}" (${part.mime}) is not supported by this model.]` };
}

async function userBlocks(parts: readonly Part[], deps: AdapterDeps): Promise<Block[]> {
  const blocks: Block[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
      case 'context':
        if (part.text !== '') blocks.push({ type: 'text', text: part.text });
        break;
      case 'image':
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mime, data: toBase64(await deps.readBlob(part.blob)) },
        });
        break;
      case 'document':
        blocks.push(await documentBlock(part, deps));
        break;
      case 'tool_result': {
        const content = await userBlocks(part.content, deps);
        blocks.push({
          type: 'tool_result',
          tool_use_id: part.callId,
          ...(content.length > 0 ? { content } : {}),
          ...(part.isError ? { is_error: true } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function assistantBlocks(parts: readonly Part[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.type === 'thinking') {
      // Only Anthropic-signed thinking can be replayed; anything else would be rejected or is meaningless.
      if (part.provider !== 'anthropic') continue;
      if (part.redacted) {
        const data = redactedDataOf(part.replay);
        if (data) blocks.push({ type: 'redacted_thinking', data });
        continue;
      }
      const signature = signatureOf(part.replay);
      if (signature) blocks.push({ type: 'thinking', thinking: part.text, signature });
    } else if (part.type === 'text' && part.text !== '') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'tool_call') {
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} });
    }
  }
  return blocks;
}

/**
 * Internal messages → Anthropic turns. Tool-role messages merge into the following user turn, consecutive
 * same-role turns merge, and tool_result blocks are moved to the front of their user turn as the API requires.
 */
export async function toAnthropicMessages(
  request: Pick<ChatRequest, 'messages'>,
  deps: AdapterDeps,
): Promise<AnthropicMessage[]> {
  const out: AnthropicMessage[] = [];
  for (const message of request.messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = role === 'assistant' ? assistantBlocks(message.parts) : await userBlocks(message.parts, deps);
    if (blocks.length === 0) continue;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  for (const m of out) {
    if (m.role !== 'user') continue;
    m.content = [
      ...m.content.filter((b) => b.type === 'tool_result'),
      ...m.content.filter((b) => b.type !== 'tool_result'),
    ];
  }
  return out;
}

function cacheable(block: Block): boolean {
  return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

/**
 * Breakpoints, in priority order: the system blocks marked `cache` (the shared prefix and the session's whole prompt,
 * which also cover the tools before them), or the last tool when none is marked; the final message (rolling); and the
 * previous user turn (where the last request's rolling breakpoint sat, so it reads back what that request wrote).
 */
export function applyCacheControl(tools: Block[] | undefined, system: Block[], systemCached: number[], messages: AnthropicMessage[]): void {
  let budget = MAX_BREAKPOINTS;
  const mark = (block: Block | undefined): void => {
    if (!block || budget === 0) return;
    block.cache_control = EPHEMERAL;
    budget--;
  };
  const lastCacheable = (m: AnthropicMessage | undefined): Block | undefined => m?.content.findLast(cacheable);

  if (systemCached.length) for (const i of systemCached) mark(system[i]);
  else mark(tools?.at(-1));
  const finalIndex = messages.length - 1;
  mark(lastCacheable(messages[finalIndex]));
  const previousUser = messages.findLastIndex((m, i) => i < finalIndex && m.role === 'user');
  if (previousUser >= 0) mark(lastCacheable(messages[previousUser]));
}

interface ModelHints {
  reasoning?: string;
  effortLevels?: string[];
}

export async function buildAnthropicBody(
  request: Omit<ChatRequest, 'signal'>,
  deps: AdapterDeps,
  hints: ModelHints | undefined,
): Promise<Record<string, unknown>> {
  const system: Block[] = request.system.map((b) => ({ type: 'text', text: b.text }));
  const systemCached = request.system.flatMap((b, i) => (b.cache ? [i] : []));
  const tools: Block[] | undefined = request.tools?.length
    ? request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
    : undefined;
  const messages = await toAnthropicMessages(request, deps);
  applyCacheControl(tools, system, systemCached, messages);

  const body: Record<string, unknown> = { model: request.model, max_tokens: request.maxOutputTokens, messages };
  if (system.length > 0) body.system = system;
  if (tools) {
    body.tools = tools;
    // Forcing a specific tool is incompatible with thinking; a named choice degrades to auto.
    if (request.toolChoice === 'none') body.tool_choice = { type: 'none' };
  }

  let thinking = false;
  if (request.effort) {
    const level = providerEffort(request.effort);
    const budget = hints?.reasoning ? hints.reasoning === 'budget' : usesBudgetThinking(request.model);
    if (budget) {
      const tokens = Math.min(BUDGETS[level], request.maxOutputTokens - MIN_BUDGET);
      if (tokens >= MIN_BUDGET) {
        body.thinking = { type: 'enabled', budget_tokens: tokens };
        thinking = true;
      }
    } else if (hints?.reasoning !== 'none') {
      body.thinking = { type: 'adaptive', display: 'summarized' };
      body.output_config = { effort: clampEffort(level, hints?.effortLevels, ANTHROPIC_EFFORTS) };
      thinking = true;
    }
  }
  if (request.temperature !== undefined && !thinking && allowsSampling(request.model)) {
    body.temperature = request.temperature;
  }
  return body;
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop';
    case 'refusal':
      return 'refusal';
    default:
      return 'end';
  }
}

function mergeUsage(usage: Usage, raw: Record<string, unknown>): void {
  const input = num(raw.input_tokens);
  if (input !== undefined) usage.input = input;
  const output = num(raw.output_tokens);
  if (output !== undefined) usage.output = output;
  const read = num(raw.cache_read_input_tokens);
  if (read !== undefined) usage.cacheRead = read;
  const write = num(raw.cache_creation_input_tokens);
  if (write !== undefined) usage.cacheWrite = write;
}

interface OpenBlock {
  type: string;
  id: string;
  json: string;
  signature: string;
}

async function* parseAnthropicStream(
  instance: ProviderInstance,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const blocks = new Map<number, OpenBlock>();
  const usage: Usage = { input: 0, output: 0 };
  let stopReason: string | undefined;

  for await (const event of parseSSE(body, signal)) {
    let data: Record<string, unknown>;
    try {
      data = rec(JSON.parse(event.data));
    } catch {
      continue;
    }
    const index = num(data.index) ?? -1;
    switch (str(data.type) ?? event.event) {
      case 'message_start':
        mergeUsage(usage, rec(rec(data.message).usage));
        break;
      case 'content_block_start': {
        const cb = rec(data.content_block);
        const type = str(cb.type) ?? '';
        const block: OpenBlock = { type, id: str(cb.id) ?? '', json: '', signature: str(cb.signature) ?? '' };
        blocks.set(index, block);
        if (type === 'tool_use') yield { type: 'tool_call_start', id: block.id, name: str(cb.name) ?? '' };
        else if (type === 'redacted_thinking')
          yield { type: 'thinking_replay', data: str(cb.data) ?? '', redacted: true };
        else if (type === 'text' && str(cb.text)) yield { type: 'text', delta: str(cb.text)! };
        else if (type === 'thinking' && str(cb.thinking)) yield { type: 'thinking', delta: str(cb.thinking)! };
        break;
      }
      case 'content_block_delta': {
        const delta = rec(data.delta);
        const block = blocks.get(index);
        const kind = str(delta.type);
        if (kind === 'text_delta' && str(delta.text)) yield { type: 'text', delta: str(delta.text)! };
        else if (kind === 'thinking_delta' && str(delta.thinking))
          yield { type: 'thinking', delta: str(delta.thinking)! };
        else if (kind === 'signature_delta' && block) block.signature += str(delta.signature) ?? '';
        else if (kind === 'input_json_delta' && block?.type === 'tool_use') {
          const json = str(delta.partial_json) ?? '';
          block.json += json;
          if (json) yield { type: 'tool_call_delta', id: block.id, json };
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks.get(index);
        blocks.delete(index);
        if (block?.type === 'tool_use')
          yield { type: 'tool_call_end', id: block.id, input: parseToolInput(block.json) };
        else if (block?.type === 'thinking' && block.signature)
          yield { type: 'thinking_replay', data: block.signature };
        break;
      }
      case 'message_delta':
        stopReason = str(rec(data.delta).stop_reason) ?? stopReason;
        mergeUsage(usage, rec(data.usage));
        break;
      case 'message_stop':
        yield { type: 'usage', usage };
        yield { type: 'finish', reason: mapStopReason(stopReason) };
        return;
      case 'error': {
        const error = rec(data.error);
        const kind = str(error.type) ?? '';
        yield {
          type: 'finish',
          reason: 'error',
          error: classifyError(instance, null, kind, str(error.message) ?? kind),
        };
        return;
      }
      default:
        // ping and event/block types this adapter does not know yet
        break;
    }
  }
}

function flag(value: unknown): boolean {
  return value === true || (isRecord(value) && value.supported === true);
}

/** Accepts `["low", …]`, `{levels: […]}` or `{low: {supported: true}, …}`. */
function effortLevelsFrom(value: unknown): string[] {
  if (Array.isArray(value)) return strings(value);
  const r = rec(value);
  if (Array.isArray(r.levels)) return strings(r.levels);
  return ANTHROPIC_EFFORTS.filter((level) => flag(r[level]));
}

function thinkingTypesFrom(value: unknown): string[] {
  const r = rec(value);
  if (Array.isArray(r.types)) return strings(r.types);
  return Object.entries(rec(r.types)).flatMap(([type, v]) => (flag(v) ? [type] : []));
}

export function anthropicModel(instance: ProviderInstance, raw: unknown): ListedModel | null {
  const m = rec(raw);
  const id = str(m.id);
  if (!id) return null;
  const catalog = anthropicCatalog(id);
  const caps = isRecord(m.capabilities) ? m.capabilities : null;
  const declaredCtx = num(m.max_input_tokens);
  const levels = caps ? effortLevelsFrom(caps.effort) : [];
  const types = caps ? thinkingTypesFrom(caps.thinking) : [];
  const fallbackReasoning = catalog?.capabilities.reasoning ?? (usesBudgetThinking(id) ? 'budget' : 'effort');
  const reasoning = !caps
    ? fallbackReasoning
    : levels.length > 0 || types.includes('adaptive')
      ? 'effort'
      : types.includes('enabled') || flag(caps.thinking)
        ? 'budget'
        : fallbackReasoning;
  // A thinking budget exists for every level (`BUDGETS`).
  const effortLevels =
    reasoning === 'budget' ? ANTHROPIC_EFFORTS : levels.length > 0 ? levels : (catalog?.effortLevels ?? ANTHROPIC_EFFORTS);
  const recommendedEffort = reasoning === 'effort' ? anthropicRecommendedEffort(id) : undefined;
  return listedModel(instance, id, {
    displayName: str(m.display_name) ?? catalog?.displayName ?? id,
    contextLength: declaredCtx ?? catalog?.contextLength ?? 200_000,
    maxOutput: num(m.max_tokens) ?? catalog?.maxOutput ?? 32_000,
    capabilities: {
      tools: 'native',
      vision: caps ? flag(caps.image_input) : (catalog?.capabilities.vision ?? true),
      pdf: caps ? flag(caps.pdf_input) : (catalog?.capabilities.pdf ?? true),
      reasoning,
      caching: true,
    },
    source: caps || declaredCtx !== undefined ? 'detected' : catalog ? 'catalog' : 'default',
    effortLevels,
    ...(recommendedEffort ? { recommendedEffort } : {}),
  });
}

export function createAnthropicAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const headers = (): Record<string, string> =>
    jsonHeaders(instance, {
      ...(instance.apiKey ? { 'x-api-key': instance.apiKey } : {}),
      'anthropic-version': ANTHROPIC_VERSION,
    });
  const url = (path: string): string => apiUrl(instance.baseUrl, path);
  const discovered = new Map<string, ListedModel>();

  function hintsFor(model: string): ModelHints | undefined {
    const known = discovered.get(model);
    if (known)
      return {
        reasoning: known.capabilities.reasoning,
        ...(known.effortLevels ? { effortLevels: known.effortLevels } : {}),
      };
    const catalog = anthropicCatalog(model);
    if (catalog)
      return {
        reasoning: catalog.capabilities.reasoning,
        ...(catalog.effortLevels ? { effortLevels: catalog.effortLevels } : {}),
      };
    return undefined;
  }

  async function* run(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = { ...(await buildAnthropicBody(request, deps, hintsFor(request.model))), stream: true };
    const res = await postStream(deps, instance, url('/v1/messages'), headers(), body, request.signal);
    if (!res.ok) {
      yield { type: 'finish', reason: 'error', error: res.error };
      return;
    }
    yield* parseAnthropicStream(instance, res.body, request.signal);
  }

  return {
    type: instance.type,

    async listModels(signal) {
      const json = await requestJson(deps, instance, url('/v1/models?limit=1000'), {
        headers: headers(),
        ...(signal ? { signal } : {}),
      });
      const models = arr(rec(json).data)
        .map((m) => anthropicModel(instance, m))
        .filter((m): m is ListedModel => m !== null);
      for (const m of models) discovered.set(m.modelId, m);
      return models;
    },

    health(signal) {
      return probe(deps, instance, url('/v1/models?limit=1'), headers(), signal);
    },

    stream(request) {
      return guardStream(request, instance, () => run(request));
    },

    async countTokens(request) {
      const full = await buildAnthropicBody(request, deps, hintsFor(request.model));
      const body = Object.fromEntries(Object.entries(full).filter(([key]) => COUNT_TOKENS_FIELDS.has(key)));
      const json = await requestJson(deps, instance, url('/v1/messages/count_tokens'), {
        method: 'POST',
        headers: headers(),
        body,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const tokens = num(rec(json).input_tokens);
      if (tokens === undefined) throw new Error('count_tokens returned no input_tokens');
      return tokens;
    },
  };
}
