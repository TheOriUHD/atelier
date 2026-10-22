/**
 * OpenAI Responses API adapter (`/v1/responses` SSE, stateless with `store:false`). Reasoning items come back
 * with `encrypted_content` and are replayed verbatim before the function calls they preceded.
 * `/v1/models` carries no metadata, so capabilities come from the static catalog.
 */
import type { DocumentPart, Part, StopReason, Usage } from '@atelier/protocol';
import { DEFAULT_CONTEXT, clampEffort, listedModel, openaiCatalog, providerEffort } from './catalog.ts';
import { bearer, classifyError, guardStream, jsonHeaders, postStream, probe, requestJson } from './http.ts';
import { parseSSE } from './sse.ts';
import type { AdapterDeps, ChatRequest, ListedModel, ProviderAdapter, ProviderInstance, StreamEvent } from './types.ts';
import { apiUrl, arr, dataUrl, documentAsText, isRecord, newCallId, num, parseToolInput, rec, str } from './util.ts';

type Item = Record<string, unknown>;
type InputContent = Record<string, unknown>;

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];

async function documentContent(part: DocumentPart, deps: AdapterDeps): Promise<InputContent> {
  const bytes = await deps.readBlob(part.blob);
  if (part.mime === 'application/pdf')
    return { type: 'input_file', filename: part.name, file_data: dataUrl(part.mime, bytes) };
  return { type: 'input_text', text: documentAsText(part, bytes) };
}

async function inputContent(parts: readonly Part[], deps: AdapterDeps): Promise<InputContent[]> {
  const content: InputContent[] = [];
  for (const part of parts) {
    if ((part.type === 'text' || part.type === 'context') && part.text !== '') {
      content.push({ type: 'input_text', text: part.text });
    } else if (part.type === 'image') {
      content.push({ type: 'input_image', image_url: dataUrl(part.mime, await deps.readBlob(part.blob)) });
    } else if (part.type === 'document') {
      content.push(await documentContent(part, deps));
    }
  }
  return content;
}

function assistantItems(parts: readonly Part[]): Item[] {
  const items: Item[] = [];
  for (const part of parts) {
    if (part.type === 'thinking') {
      if (part.provider === 'openai' && isRecord(part.replay) && part.replay.type === 'reasoning')
        items.push(part.replay);
    } else if (part.type === 'text' && part.text !== '') {
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: part.text }] });
    } else if (part.type === 'tool_call') {
      items.push({
        type: 'function_call',
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      });
    }
  }
  return items;
}

export async function toResponsesInput(request: Pick<ChatRequest, 'messages'>, deps: AdapterDeps): Promise<Item[]> {
  const items: Item[] = [];
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      items.push(...assistantItems(message.parts));
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== 'tool_result') continue;
      const content = await inputContent(part.content, deps);
      const text = content.flatMap((c) => (c.type === 'input_text' ? [String(c.text)] : [])).join('\n');
      const prefixed = part.isError ? `Error: ${text}` : text;
      const media = content.filter((c) => c.type !== 'input_text');
      const output =
        media.length > 0 ? [...(prefixed ? [{ type: 'input_text', text: prefixed }] : []), ...media] : prefixed;
      items.push({ type: 'function_call_output', call_id: part.callId, output });
    }
    const content = await inputContent(
      message.parts.filter((p) => p.type !== 'tool_result'),
      deps,
    );
    if (content.length > 0) items.push({ type: 'message', role: 'user', content });
  }
  return items;
}

export async function buildResponsesBody(request: ChatRequest, deps: AdapterDeps): Promise<Record<string, unknown>> {
  const catalog = openaiCatalog(request.model);
  // Unknown ids only get reasoning parameters when the user asked for an effort.
  const reasons = catalog ? catalog.capabilities.reasoning !== 'none' : !!request.effort;
  const body: Record<string, unknown> = {
    model: request.model,
    input: await toResponsesInput(request, deps),
    stream: true,
    store: false,
    max_output_tokens: request.maxOutputTokens,
  };
  const instructions = request.system.map((b) => b.text).join('\n\n');
  if (instructions) body.instructions = instructions;
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false,
    }));
    if (request.toolChoice === 'none') body.tool_choice = 'none';
    else if (typeof request.toolChoice === 'object')
      body.tool_choice = { type: 'function', name: request.toolChoice.name };
  }
  if (request.effort && reasons) {
    const level = providerEffort(request.effort);
    const wanted = level === 'max' ? 'xhigh' : level;
    body.reasoning = { effort: clampEffort(wanted, catalog?.effortLevels, EFFORT_ORDER), summary: 'auto' };
  }
  // Stateless requests only get reasoning back for replay when asked for explicitly.
  if (reasons) body.include = ['reasoning.encrypted_content'];
  // Reasoning models reject sampling parameters; only known non-reasoning models get a temperature.
  if (request.temperature !== undefined && catalog && !reasons) body.temperature = request.temperature;
  return body;
}

function mapUsage(raw: Record<string, unknown>): Usage {
  const input = num(raw.input_tokens) ?? 0;
  const cached = num(rec(raw.input_tokens_details).cached_tokens) ?? 0;
  const usage: Usage = { input: Math.max(input - cached, 0), output: num(raw.output_tokens) ?? 0 };
  if (cached > 0) usage.cacheRead = cached;
  const reasoning = num(rec(raw.output_tokens_details).reasoning_tokens);
  if (reasoning) usage.reasoning = reasoning;
  return usage;
}

interface OpenCall {
  callId: string;
  args: string;
  ended: boolean;
}

async function* parseResponsesStream(
  instance: ProviderInstance,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const calls = new Map<string, OpenCall>();
  let summaryParts = 0;
  let refused = false;

  function* endCall(itemId: string, item: Record<string, unknown>): Generator<StreamEvent> {
    let call = calls.get(itemId);
    if (!call) {
      call = { callId: str(item.call_id) ?? newCallId(), args: '', ended: false };
      calls.set(itemId, call);
      yield { type: 'tool_call_start', id: call.callId, name: str(item.name) ?? '' };
    }
    if (call.ended) return;
    call.ended = true;
    yield { type: 'tool_call_end', id: call.callId, input: parseToolInput(str(item.arguments) ?? call.args) };
  }

  for await (const event of parseSSE(body, signal)) {
    let data: Record<string, unknown>;
    try {
      data = rec(JSON.parse(event.data));
    } catch {
      continue;
    }
    switch (str(data.type) ?? event.event) {
      case 'response.output_item.added': {
        const item = rec(data.item);
        if (item.type === 'reasoning') summaryParts = 0;
        if (item.type !== 'function_call') break;
        const callId = str(item.call_id) ?? newCallId();
        calls.set(str(item.id) ?? callId, { callId, args: '', ended: false });
        yield { type: 'tool_call_start', id: callId, name: str(item.name) ?? '' };
        break;
      }
      case 'response.function_call_arguments.delta': {
        const call = calls.get(str(data.item_id) ?? '');
        const delta = str(data.delta) ?? '';
        if (!call || !delta) break;
        call.args += delta;
        yield { type: 'tool_call_delta', id: call.callId, json: delta };
        break;
      }
      case 'response.function_call_arguments.done': {
        const call = calls.get(str(data.item_id) ?? '');
        const args = str(data.arguments);
        if (call && args !== undefined) call.args = args;
        break;
      }
      case 'response.output_item.done': {
        const item = rec(data.item);
        if (item.type === 'function_call') yield* endCall(str(item.id) ?? str(item.call_id) ?? '', item);
        else if (item.type === 'reasoning') yield { type: 'thinking_replay', data: item };
        break;
      }
      case 'response.output_text.delta':
        if (str(data.delta)) yield { type: 'text', delta: str(data.delta)! };
        break;
      case 'response.refusal.delta':
        refused = true;
        if (str(data.delta)) yield { type: 'text', delta: str(data.delta)! };
        break;
      case 'response.reasoning_summary_part.added':
        if (summaryParts++ > 0) yield { type: 'thinking', delta: '\n\n' };
        break;
      case 'response.reasoning_summary_text.delta':
        if (str(data.delta)) yield { type: 'thinking', delta: str(data.delta)! };
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const response = rec(data.response);
        if (isRecord(response.usage)) yield { type: 'usage', usage: mapUsage(response.usage) };
        yield {
          type: 'finish',
          reason: finishReason(data.type === 'response.incomplete', response, calls.size > 0, refused),
        };
        return;
      }
      case 'response.failed':
      case 'error': {
        const response = rec(data.response);
        const rawError = response.error ?? data.error;
        const error = rec(rawError);
        const kind = str(error.code) ?? str(error.type) ?? str(data.code) ?? 'error';
        const status = num(error.status) ?? num(error.status_code) ?? num(data.status) ?? num(data.status_code) ?? null;
        const message = str(error.message) ?? str(rawError) ?? str(data.message) ?? 'response failed';
        yield {
          type: 'finish',
          reason: 'error',
          error: classifyError(instance, status, kind, message),
        };
        return;
      }
      default:
        break;
    }
  }
}

function finishReason(
  incomplete: boolean,
  response: Record<string, unknown>,
  sawTool: boolean,
  refused: boolean,
): StopReason {
  if (incomplete) return str(rec(response.incomplete_details).reason) === 'content_filter' ? 'refusal' : 'max_tokens';
  if (refused) return 'refusal';
  return sawTool ? 'tool_use' : 'end';
}

const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const NON_CHAT = /audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation|computer-use/;

export function openaiModel(instance: ProviderInstance, id: string): ListedModel | null {
  if (!CHAT_MODEL.test(id) || NON_CHAT.test(id)) return null;
  const catalog = openaiCatalog(id);
  if (catalog) {
    return listedModel(instance, id, {
      displayName: catalog.displayName,
      contextLength: catalog.contextLength,
      maxOutput: catalog.maxOutput,
      capabilities: catalog.capabilities,
      source: 'catalog',
      ...(catalog.effortLevels ? { effortLevels: catalog.effortLevels } : {}),
    });
  }
  return listedModel(instance, id, {
    displayName: id,
    contextLength: Math.max(DEFAULT_CONTEXT, 128_000),
    maxOutput: 16_384,
    capabilities: { tools: 'native', vision: false, pdf: false, reasoning: 'none', caching: true },
    source: 'default',
  });
}

export function createOpenAIAdapter(instance: ProviderInstance, deps: AdapterDeps): ProviderAdapter {
  const headers = (): Record<string, string> => jsonHeaders(instance, bearer(instance));
  const url = (path: string): string => apiUrl(instance.baseUrl, path);

  async function* run(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = await buildResponsesBody(request, deps);
    const res = await postStream(deps, instance, url('/v1/responses'), headers(), body, request.signal);
    if (!res.ok) {
      yield { type: 'finish', reason: 'error', error: res.error };
      return;
    }
    yield* parseResponsesStream(instance, res.body, request.signal);
  }

  return {
    type: instance.type,

    async listModels(signal) {
      const json = await requestJson(deps, instance, url('/v1/models'), {
        headers: headers(),
        ...(signal ? { signal } : {}),
      });
      return arr(rec(json).data)
        .map((m) => str(rec(m).id))
        .filter((id): id is string => !!id)
        .sort()
        .map((id) => openaiModel(instance, id))
        .filter((m): m is ListedModel => m !== null);
    },

    health(signal) {
      return probe(deps, instance, url('/v1/models'), headers(), signal);
    },

    stream(request) {
      return guardStream(request, instance, () => run(request));
    },
  };
}
