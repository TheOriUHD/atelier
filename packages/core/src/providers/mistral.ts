/**
 * Mistral as a provider, in two kinds that differ only in their key: `mistral` takes a key from Mistral's console and is
 * paid per token, `mistral-vibe` takes the key a Le Chat Pro or Team plan gives for Vibe, which spends the plan's Vibe
 * allowance first. Mistral has said such a key may be used outside Vibe. Atelier takes no part in how the key is made
 * (Vibe's own sign-in is private to it): the person creates it and pastes it.
 *
 * The wire is Chat Completions, Mistral's own flavour of it:
 * - Unknown fields are refused (422), OpenAI's `stream_options`, `seed`, `max_completion_tokens` and `user` among them.
 *   Usage comes in the last chunk without asking.
 * - Reasoning is `reasoning_effort` with the values each model takes (Large 4: low to high; Small 4 and Medium 3.5:
 *   none or high). It comes back as `thinking` content chunks, which are sent back with the reply, as Mistral asks.
 * - Its own models send a tool call whole in one chunk; the models it hosts for others stream them in pieces by index.
 * - Older tokenizers take only nine-letter call ids, so ids from other providers are mapped (`historyCallId`).
 * - At most 8 images a request (`IMAGE_POLICIES`); PDFs go as `document_url`, which Mistral reads itself.
 * See docs/ARCHITECTURE.md §7 and https://docs.mistral.ai/api.
 */
import type { MessageError, Part, StopReason, Usage } from '@atelier/protocol';
import { clampEffort, DEFAULT_CONTEXT, listedModel, providerEffort, type CatalogEntry } from './catalog.ts';
import { bearer, classifyError, extractErrorMessage, guardStream, jsonHeaders, probe, requestJson } from './http.ts';
import { historyCallId } from './ollama.ts';
import { ToolCallMerger } from './openai-compatible.ts';
import { parseSSE } from './sse.ts';
import type { AdapterDeps, ChatRequest, ListedModel, PlanUsage, ProviderAdapter, ProviderInstance, StreamEvent } from './types.ts';
import { apiUrl, arr, dataUrl, documentAsText, isRecord, num, rec, str, textOf } from './util.ts';

/** How a model takes `reasoning_effort`: not at all, `none` or `high` (an on/off switch), or a set of levels. */
type Reasoning = { kind: 'none' } | { kind: 'toggle' } | { kind: 'levels'; levels: string[] };

interface MistralEntry extends CatalogEntry {
  reasoning: Reasoning;
}

/** Mistral's own scale, lowest first: what a level is clamped along. */
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const NONE: Reasoning = { kind: 'none' };
const TOGGLE: Reasoning = { kind: 'toggle' };

function entry(displayName: string, contextLength: number, maxOutput: number, vision: boolean, reasoning: Reasoning): MistralEntry {
  return {
    displayName,
    contextLength,
    maxOutput,
    reasoning,
    // Mistral reads a PDF itself (its OCR) for the models that take images.
    capabilities: { tools: 'native', vision, pdf: vision, reasoning: reasoning.kind === 'none' ? 'none' : reasoning.kind === 'toggle' ? 'toggle' : 'effort', caching: true },
    ...(reasoning.kind === 'levels' ? { effortLevels: reasoning.levels } : {}),
  };
}

const M = 1_048_576;
const K256 = 262_144;

/**
 * What `/v1/models` doesn't say: names, output limits and how each model reasons. From docs.mistral.ai's model cards and
 * reasoning guide, 2026-11-06. A listed model that isn't here still works, with what its card says.
 */
const CATALOG: Record<string, MistralEntry> = {
  'mistral-large-4': entry('Mistral Large 4', M, 131_072, true, { kind: 'levels', levels: ['low', 'medium', 'high'] }),
  'mistral-medium-3-5': entry('Mistral Medium 3.5', K256, 65_536, true, TOGGLE),
  'mistral-medium-2604': entry('Mistral Medium 3.5', K256, 65_536, true, TOGGLE),
  'mistral-small-2603': entry('Mistral Small 4', K256, 65_536, true, TOGGLE),
  'mistral-large-2512': entry('Mistral Large 3', K256, 65_536, true, NONE),
  'ministral-14b-2512': entry('Ministral 3 14B', K256, 32_768, true, NONE),
  'ministral-8b-2512': entry('Ministral 3 8B', K256, 32_768, true, NONE),
  'ministral-3b-2512': entry('Ministral 3 3B', K256, 32_768, true, NONE),
  'codestral-2508': entry('Codestral', 131_072, 32_768, false, NONE),
  // The models Vibe itself uses: Medium 3.5 for the main one.
  'mistral-vibe-cli-latest': entry('Mistral Vibe', K256, 65_536, true, TOGGLE),
  'mistral-vibe-cli-fast': entry('Mistral Vibe Fast', K256, 32_768, true, TOGGLE),
  'zai-glm-5-3': entry('GLM 5.3', M, 131_072, false, { kind: 'levels', levels: ['low', 'high', 'max'] }),
  'zai-glm-5-3-flash': entry('GLM 5.3 Flash', M, 131_072, true, { kind: 'levels', levels: ['low', 'high', 'max'] }),
  // It reasons by itself; the values it takes aren't published, so none is sent.
  'deepseek-v4-1-flash': entry('DeepSeek V4.1 Flash', M, 131_072, true, NONE),
  'voxtral-small-2507': entry('Voxtral Small', 32_768, 8192, false, NONE),
};

/** The catalog entry for an id, its dated or numbered forms included (`deepseek-v4-1-flash-1017`, `mistral-large-4-0`). */
export function mistralCatalog(id: string): MistralEntry | undefined {
  const exact = CATALOG[id];
  if (exact) return exact;
  const key = Object.keys(CATALOG)
    .filter((k) => id.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? undefined : CATALOG[key];
}

/** Tells a 422's validation list as a sentence: "body.stream_options: Extra inputs are not permitted". */
export function mistralErrorMessage(body: string): string {
  try {
    const json = rec(JSON.parse(body));
    const message = isRecord(json.message) ? json.message : typeof json.message === 'string' && json.message.startsWith('{') ? rec(JSON.parse(json.message)) : null;
    const detail = arr(message?.detail ?? json.detail);
    const lines = detail.map((d) => {
      const item = rec(d);
      const where = arr(item.loc).map(String).join('.');
      return [where, str(item.msg)].filter(Boolean).join(': ');
    });
    if (lines.some(Boolean)) return lines.filter(Boolean).join('; ');
  } catch {
    // not JSON, or not this shape
  }
  return extractErrorMessage(body);
}

async function mistralHttpError(res: Response, instance: ProviderInstance): Promise<MessageError> {
  const body = await res.text().catch(() => '');
  let kind = '';
  try {
    kind = str(rec(JSON.parse(body)).type) ?? '';
  } catch {
    // not JSON
  }
  const error = classifyError(instance, res.status, kind, mistralErrorMessage(body) || res.statusText);
  // A Vibe key past its plan's allowance (with pay-as-you-go off) waits for the next month; Mistral's console says when.
  if (instance.type === 'mistral-vibe' && error.code === 'provider_quota') return { ...error, message: `${error.message}. The plan's Vibe allowance starts again at the next billing period, or turn on pay-as-you-go in Mistral's console.` };
  return error;
}

type Chunk = Record<string, unknown>;
type Content = string | Chunk[];

/** A thinking part this adapter wrote, as Mistral takes it back. */
function thinkingChunk(part: Extract<Part, { type: 'thinking' }>): Chunk {
  const signature = str(rec(part.replay).signature);
  return { type: 'thinking', thinking: [{ type: 'text', text: part.text }], ...(signature ? { signature } : {}) };
}

export interface MistralModelFacts {
  /** The model reads PDFs (its card says vision). */
  pdf: boolean;
  /**
   * Earlier thinking goes back as `thinking` chunks (default true). A model that reasons takes it, GLM included, as
   * Mistral's own Vibe sends it; a model without reasoning refuses it, as after a switch from one that reasons.
   */
  thinking?: boolean;
}

async function userContent(parts: readonly Part[], deps: AdapterDeps, facts: MistralModelFacts): Promise<Content> {
  const texts = [textOf(parts)];
  const extra: Chunk[] = [];
  for (const part of parts) {
    if (part.type === 'image') extra.push({ type: 'image_url', image_url: dataUrl(part.mime, await deps.readBlob(part.blob)) });
    if (part.type === 'document') {
      const bytes = await deps.readBlob(part.blob);
      if (part.mime === 'application/pdf' && facts.pdf) extra.push({ type: 'document_url', document_url: dataUrl(part.mime, bytes), document_name: part.name });
      else texts.push(documentAsText(part, bytes));
    }
  }
  const text = texts.filter((t) => t !== '').join('\n\n');
  if (extra.length === 0) return text;
  return text ? [{ type: 'text', text }, ...extra] : extra;
}

/** The conversation as Mistral takes it. `type`: the provider type whose thinking parts are sent back. */
export async function toMistralMessages(request: Pick<ChatRequest, 'system' | 'messages'>, deps: AdapterDeps, type: string, facts: MistralModelFacts): Promise<Chunk[]> {
  const out: Chunk[] = [];
  const system = request.system.map((b) => b.text).join('\n\n');
  if (system) out.push({ role: 'system', content: system });
  const names = new Map<string, string>();
  // A tool message takes text only on older models: images a tool returned follow the tool block as one user message.
  let pending: Chunk[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...pending] });
    pending = [];
  };
  for (const message of request.messages) {
    const results = message.parts.flatMap((p) => (p.type === 'tool_result' ? [p] : []));
    if (results.length === 0) flush();
    if (message.role === 'assistant') {
      const calls = message.parts.flatMap((p) => (p.type === 'tool_call' ? [p] : []));
      const thinking = message.parts.flatMap((p) => (facts.thinking !== false && p.type === 'thinking' && p.provider === type && p.text && !p.redacted ? [thinkingChunk(p)] : []));
      const text = textOf(message.parts);
      // An empty reply (stopped before it said anything) is refused: it is left out.
      if (!text && calls.length === 0 && thinking.length === 0) continue;
      const msg: Chunk = { role: 'assistant', content: thinking.length > 0 ? [...thinking, ...(text ? [{ type: 'text', text }] : [])] : text };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((c) => {
          names.set(c.id, c.name);
          return { id: historyCallId(c.id), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } };
        });
      }
      out.push(msg);
      continue;
    }
    for (const result of results) {
      const content = await userContent(result.content, deps, { pdf: false });
      const text = typeof content === 'string' ? content : content.flatMap((c) => (c.type === 'text' ? [String(c.text)] : [])).join('\n');
      if (typeof content !== 'string') pending.push(...content.filter((c) => c.type === 'image_url'));
      const name = names.get(result.callId);
      out.push({ role: 'tool', tool_call_id: historyCallId(result.callId), ...(name ? { name } : {}), content: result.isError ? `Error: ${text}` : text });
    }
    const rest = message.parts.filter((p) => p.type !== 'tool_result');
    if (rest.length === 0) continue;
    flush();
    out.push({ role: 'user', content: await userContent(rest, deps, facts) });
  }
  flush();
  return out;
}

/** `reasoning_effort` for this request, or undefined to leave the model's own default. */
export function reasoningEffort(reasoning: Reasoning, effort: ChatRequest['effort']): string | undefined {
  if (reasoning.kind === 'none') return undefined;
  // Thinking off on a switch model is `none`; on, it only knows `high`.
  if (reasoning.kind === 'toggle') return effort ? 'high' : 'none';
  if (!effort) return undefined;
  return clampEffort(providerEffort(effort), reasoning.levels, LEVELS);
}

export function mistralBody(request: ChatRequest, messages: Chunk[], reasoning: Reasoning): Record<string, unknown> {
  const tools = request.toolChoice === 'none' ? undefined : request.tools;
  const body: Record<string, unknown> = { model: request.model, messages, stream: true, max_tokens: request.maxOutputTokens };
  // Mistral's range is 0 to 1.5.
  if (request.temperature !== undefined) body.temperature = Math.min(request.temperature, 1.5);
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    if (typeof request.toolChoice === 'object') body.tool_choice = { type: 'function', function: { name: request.toolChoice.name } };
  }
  const effort = reasoningEffort(reasoning, request.effort);
  if (effort) body.reasoning_effort = effort;
  // One conversation's requests share a prefix: the key makes Mistral's cache more likely to keep it.
  if (request.queue?.owner) body.prompt_cache_key = request.queue.owner;
  return body;
}

/**
 * The thinking text of one content chunk. Mistral's own: `{type:'thinking', thinking:[{type:'text', text}]}`. The
 * models it hosts for others may also send the thinking as a string, as strings in the list, or as a `reasoning` chunk.
 */
function thinkingTexts(piece: Chunk): string[] {
  const inner = piece.thinking;
  if (typeof inner === 'string') return inner ? [inner] : [];
  const texts = arr(inner).flatMap((i) => {
    const t = typeof i === 'string' ? i : str(rec(i).text) ?? str(rec(i).thinking);
    return t ? [t] : [];
  });
  if (texts.length > 0) return texts;
  const own = piece.type === 'reasoning' || piece.type === 'reasoning_text' ? str(piece.text) ?? str(piece.reasoning) : undefined;
  return own ? [own] : [];
}

/** What a delta carries besides `content`: the OpenAI-style reasoning fields (`reasoning_content`, `reasoning`, `reasoning_details`). */
function deltaReasoning(delta: Record<string, unknown>): string[] {
  const direct = delta.reasoning_content ?? delta.reasoning;
  if (typeof direct === 'string') return direct ? [direct] : [];
  const fromObject = isRecord(direct) ? thinkingTexts({ type: 'reasoning', ...direct }) : [];
  if (fromObject.length > 0) return fromObject;
  return arr(delta.reasoning_details).flatMap((f) => {
    const t = str(rec(f).text) ?? str(rec(f).summary);
    return t ? [t] : [];
  });
}

function mapUsage(raw: Record<string, unknown>): Usage {
  const prompt = num(raw.prompt_tokens) ?? 0;
  const cached = num(rec(raw.prompt_tokens_details).cached_tokens) ?? num(raw.num_cached_tokens) ?? num(rec(raw.prompt_token_details).cached_tokens) ?? 0;
  const usage: Usage = { input: Math.max(prompt - cached, 0), output: num(raw.completion_tokens) ?? 0 };
  if (cached > 0) usage.cacheRead = cached;
  const reasoning = num(rec(raw.completion_tokens_details).reasoning_tokens);
  if (reasoning) usage.reasoning = reasoning;
  return usage;
}

function stopReason(reason: string | undefined, sawTool: boolean): StopReason {
  if (reason === 'length' || reason === 'model_length') return 'max_tokens';
  if (reason === 'tool_calls' || sawTool) return 'tool_use';
  return 'end';
}

/** The model's id as Mistral lists it, with what Atelier needs to talk to it. */
interface Known {
  reasoning: Reasoning;
  pdf: boolean;
}

/** A card from `/v1/models` as a model, or null when it can't chat or is retired. */
export function mistralModel(instance: ProviderInstance, raw: unknown, now = Date.now()): ListedModel | null {
  const m = rec(raw);
  const id = str(m.id);
  const caps = rec(m.capabilities);
  if (!id || caps.completion_chat !== true || m.archived === true) return null;
  const deprecation = str(m.deprecation);
  if (deprecation && Date.parse(deprecation) <= now) return null;
  const known = mistralCatalog(id) ?? (str(m.name) ? mistralCatalog(str(m.name)!) : undefined);
  const contextLength = num(m.max_context_length) ?? known?.contextLength ?? DEFAULT_CONTEXT;
  const vision = caps.vision === true || (known?.capabilities.vision ?? false);
  const reasoning = known ? known.capabilities.reasoning : caps.reasoning === true ? 'effort' : 'none';
  return listedModel(instance, id, {
    displayName: known?.displayName ?? id,
    contextLength,
    maxOutput: Math.min(known?.maxOutput ?? 32_768, contextLength),
    capabilities: { tools: caps.function_calling === false ? 'prompted' : 'native', vision, pdf: vision, reasoning, caching: true },
    source: 'detected',
    // A reasoning model Atelier doesn't know yet gets `high` only, the level every Mistral reasoning model takes.
    ...(known?.effortLevels ? { effortLevels: known.effortLevels } : reasoning === 'effort' ? { effortLevels: ['high'] } : {}),
  });
}

/**
 * The list without its aliases: `/v1/models` has a card for every name of a model (`mistral-small-latest` as well as
 * `mistral-small-2603`), whose `name` is the model's own. One card per model, under its own name where it has one.
 */
export function uniqueModels(cards: unknown[]): unknown[] {
  const byModel = new Map<string, unknown>();
  for (const card of cards) {
    const m = rec(card);
    const id = str(m.id);
    if (!id) continue;
    const own = str(m.name) ?? id;
    if (!byModel.has(own) || id === own) byModel.set(own, card);
  }
  return [...byModel.values()];
}

/** Vibe's allowance, from Mistral's billing API (`/v1/billing/budget`, what Vibe itself reads); null where it isn't served. */
export async function vibeBudget(instance: ProviderInstance, deps: AdapterDeps, signal?: AbortSignal): Promise<PlanUsage | null> {
  const headers = jsonHeaders(instance, bearer(instance));
  const read = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      return rec(await requestJson(deps, instance, apiUrl(instance.baseUrl, path), { headers, ...(signal ? { signal } : {}) }));
    } catch {
      // A member without the usage permission (403), or a platform that doesn't serve billing (404).
      return null;
    }
  };
  const [budget, subscription] = await Promise.all([read('/v1/billing/budget'), read('/v1/billing/subscription')]);
  const detail = rec(budget?.vibe_budget);
  const used = num(detail.usage_percentage);
  if (used === undefined) return null;
  const resets = str(detail.reset_at) ? Date.parse(str(detail.reset_at)!) : NaN;
  const plan = str(subscription?.plan_name);
  const overage = detail.payg_enabled === true || subscription?.vibe_payg_enabled === true;
  return { usedPercent: Math.max(0, used), resetsAt: Number.isFinite(resets) ? resets : null, ...(plan ? { plan } : {}), ...(overage ? { overage } : {}) };
}

/**
 * What a reply looked like, without a word of it: which fields and chunk types came, how much text and thinking, the
 * tool calls and their ids, how it ended. Logged when a reply fails or shows nothing, so Copy diagnostics can say what
 * Mistral sent.
 */
class ReplyOutline {
  events = 0;
  readonly fields = new Set<string>();
  readonly chunks = new Set<string>();
  text = 0;
  thinking = 0;
  callPieces = 0;
  nullIds = 0;

  constructor(
    private readonly instance: ProviderInstance,
    private readonly request: ChatRequest,
    private readonly body: Record<string, unknown>,
  ) {}

  see(delta: Record<string, unknown>): void {
    this.events++;
    for (const key of Object.keys(delta)) this.fields.add(key);
    const content = delta.content;
    if (typeof content === 'string') this.chunks.add(content ? 'string' : 'empty string');
    for (const item of arr(content)) this.chunks.add(typeof item === 'string' ? 'string' : (str(rec(item).type) ?? 'untyped'));
    for (const call of arr(delta.tool_calls)) {
      this.callPieces++;
      if (rec(call).id === 'null' || rec(call).id === null) this.nullIds++;
    }
  }

  line(how: string, extra = ''): string {
    const sent = `effort=${String(this.body.reasoning_effort ?? '-')} max_tokens=${String(this.body.max_tokens ?? '-')} tools=${arr(this.body.tools).length} messages=${arr(this.body.messages).length}`;
    const got = `events=${this.events} fields=[${[...this.fields].join(',')}] content=[${[...this.chunks].join(',')}] text=${this.text} thinking=${this.thinking} tool_call_pieces=${this.callPieces} null_ids=${this.nullIds}`;
    return `mistral ${this.request.model} (${this.instance.type}): ${how}; sent ${sent}; got ${got}${extra ? `; ${extra}` : ''}`;
  }
}

async function* runMistral(instance: ProviderInstance, deps: AdapterDeps, request: ChatRequest, known: Known): AsyncGenerator<StreamEvent> {
  const messages = await toMistralMessages(request, deps, instance.type, { pdf: known.pdf, thinking: known.reasoning.kind !== 'none' });
  const body = mistralBody(request, messages, known.reasoning);
  const outline = new ReplyOutline(instance, request, body);
  const res = await deps.fetch(apiUrl(instance.baseUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers: jsonHeaders(instance, bearer(instance)),
    body: JSON.stringify(body),
    signal: request.signal,
  });
  if (!res.ok || !res.body) {
    const error = res.ok ? classifyError(instance, null, '', 'empty response body') : await mistralHttpError(res, instance);
    deps.log?.(outline.line(`HTTP ${res.status}`, `error=${error.code}: ${error.message.slice(0, 500)}`));
    yield { type: 'finish', reason: 'error', error };
    return;
  }

  const calls = new ToolCallMerger();
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  let signature: string | undefined;

  for await (const event of parseSSE(res.body, request.signal)) {
    let chunk: Record<string, unknown>;
    try {
      chunk = rec(JSON.parse(event.data));
    } catch {
      continue; // `[DONE]`
    }
    // A stream error is an object of its own (`"error": null` on an ordinary chunk is no error).
    if (chunk.object === 'error' || (chunk.error !== undefined && chunk.error !== null)) {
      const error = isRecord(chunk.error) ? chunk.error : chunk;
      const message = str(error.message) || mistralErrorMessage(JSON.stringify(error)) || 'stream error';
      const code = num(error.code) ?? num(error.raw_status_code);
      deps.log?.(outline.line('error in the stream', `error=${String(code ?? '-')} ${str(error.type) ?? ''}: ${message.slice(0, 500)}`));
      yield { type: 'finish', reason: 'error', error: classifyError(instance, code !== undefined && code >= 400 && code < 600 ? code : null, str(error.type) ?? '', message) };
      return;
    }
    if (isRecord(chunk.usage)) usage = mapUsage(chunk.usage);
    const choice = rec(arr(chunk.choices)[0]);
    const delta = rec(choice.delta);
    outline.see(delta);
    for (const text of deltaReasoning(delta)) {
      outline.thinking += text.length;
      yield { type: 'thinking', delta: text };
    }
    const content = delta.content;
    if (typeof content === 'string' && content) {
      outline.text += content.length;
      yield { type: 'text', delta: content };
    }
    for (const item of arr(content)) {
      if (typeof item === 'string') {
        if (item) {
          outline.text += item.length;
          yield { type: 'text', delta: item };
        }
        continue;
      }
      const piece = rec(item);
      if (piece.type === 'text' && str(piece.text)) {
        outline.text += str(piece.text)!.length;
        yield { type: 'text', delta: str(piece.text)! };
      }
      if (piece.type === 'thinking' || piece.type === 'reasoning' || piece.type === 'reasoning_text') {
        for (const text of thinkingTexts(piece)) {
          outline.thinking += text.length;
          yield { type: 'thinking', delta: text };
        }
        signature = str(piece.signature) ?? signature;
      }
    }
    for (const call of arr(delta.tool_calls)) yield* calls.add(call);
    finishReason = str(choice.finish_reason) ?? finishReason;
  }

  const sawTool = calls.size > 0;
  const usageNote = usage ? `usage in=${usage.input} out=${usage.output}${usage.reasoning ? ` reasoning=${usage.reasoning}` : ''}` : 'no usage';
  // Without a finish reason or usage the stream was cut off; the guard reports it.
  if (finishReason === undefined && usage === undefined) {
    deps.log?.(outline.line('the stream ended with no finish reason and no usage'));
    return;
  }
  if (finishReason === 'error') {
    deps.log?.(outline.line('finish_reason error', usageNote));
    yield { type: 'finish', reason: 'error', error: classifyError(instance, null, 'error', 'Mistral stopped the reply with an error') };
    return;
  }
  if ((outline.text === 0 && !sawTool) || finishReason === undefined || finishReason === 'length' || finishReason === 'model_length') {
    deps.log?.(outline.line(`finish_reason ${finishReason ?? 'none'}${outline.text === 0 && !sawTool ? ', nothing to show' : ''}`, usageNote));
  }
  yield* calls.finish();
  if (signature) yield { type: 'thinking_replay', data: { signature } };
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: stopReason(finishReason, sawTool) };
}

export function createMistralAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const headers = () => jsonHeaders(instance, bearer(instance));
  const modelsUrl = apiUrl(instance.baseUrl, '/v1/models');
  /** What the last listing said, by every name a model has: how a request for it reasons and whether it reads PDFs. */
  const listed = new Map<string, Known>();

  const knownOf = (model: string): Known => {
    const seen = listed.get(model);
    if (seen) return seen;
    const entry = mistralCatalog(model);
    return { reasoning: entry?.reasoning ?? NONE, pdf: entry?.capabilities.pdf ?? false };
  };

  return {
    type: instance.type,

    async listModels(signal) {
      const json = await requestJson(deps, instance, modelsUrl, { headers: headers(), ...(signal ? { signal } : {}) });
      const cards = arr(rec(json).data);
      const models: ListedModel[] = [];
      for (const card of uniqueModels(cards)) {
        const model = mistralModel(instance, card);
        if (!model) continue;
        models.push(model);
        const catalog = mistralCatalog(model.modelId);
        const known: Known = {
          reasoning: catalog?.reasoning ?? (model.capabilities.reasoning === 'effort' ? { kind: 'levels', levels: model.effortLevels ?? ['high'] } : NONE),
          pdf: model.capabilities.pdf,
        };
        const names = [model.modelId, ...arr(rec(card).aliases).map(String)];
        for (const name of names) listed.set(name, known);
      }
      return models;
    },

    health(signal) {
      return probe(deps, instance, modelsUrl, headers(), signal);
    },

    stream(request) {
      return guardStream(request, instance, () => runMistral(instance, deps, request, knownOf(request.model)));
    },

    ...(instance.type === 'mistral-vibe' ? { planUsage: (signal?: AbortSignal) => vibeBudget(instance, deps, signal) } : {}),
  };
}
