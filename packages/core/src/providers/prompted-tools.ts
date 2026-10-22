/**
 * Prompted tool calling for models without native tool support. Tool specs go into the system prompt, history tool
 * calls/results are re-serialized as text, and a streaming parser hides `<tool_call>{…}</tool_call>` blocks from the
 * visible text, repairs their JSON and validates arguments against the tool's schema. A call that cannot be
 * understood is emitted as `__invalid_tool_call__` with `{error, raw}` so the agent loop can feed the error back.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { Message, Part, StopReason } from '@atelier/protocol';
import type { ChatRequest, JsonSchema, ProviderAdapter, StreamEvent, ToolDef } from './types.ts';
import { isRecord, newCallId, parseJsonLoose, rec, str, textOf } from './util.ts';

export const INVALID_TOOL_CALL = '__invalid_tool_call__';
const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export function toolSpecPrompt(tools: readonly ToolDef[]): string {
  const specs = tools.map(
    (t) => `### ${t.name}\n${t.description.trim()}\nArguments JSON Schema: ${JSON.stringify(t.inputSchema)}`,
  );
  return [
    '# Tools',
    'You can call the tools listed below. To call one, write the call in exactly this format:',
    `${OPEN}{"name": "tool_name", "arguments": {"param": "value"}}${CLOSE}`,
    [
      'Rules:',
      `- Make at most one tool call per message and stop writing right after ${CLOSE}.`,
      '- "arguments" must be a JSON object that matches the tool\'s schema.',
      '- The result arrives in the next message as <tool_result name="tool_name" id="…">…</tool_result>. ' +
        'Never write <tool_result> yourself.',
      '- When no tool is needed, answer normally without a tool call.',
    ].join('\n'),
    '## Available tools',
    ...specs,
  ].join('\n\n');
}

function callText(name: string, input: unknown): string {
  const raw = rec(input).raw;
  // Replay a malformed call as the model wrote it, so the error result that follows makes sense.
  if (name === INVALID_TOOL_CALL && typeof raw === 'string') return `${OPEN}${raw}${CLOSE}`;
  return `${OPEN}${JSON.stringify({ name, arguments: input ?? {} })}${CLOSE}`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** Re-serialize native tool_call/tool_result parts as prompted-format text; tool turns become user turns. */
export function serializeHistory(messages: readonly Message[]): Message[] {
  const names = new Map<string, string>();
  const out: Message[] = [];
  for (const message of messages) {
    const parts: Part[] = [];
    for (const part of message.parts) {
      if (part.type === 'tool_call') {
        names.set(part.id, part.name);
        parts.push({ type: 'text', text: callText(part.name, part.input) });
      } else if (part.type === 'tool_result') {
        const name = escapeAttr(names.get(part.callId) ?? 'unknown');
        const error = part.isError ? ' error="true"' : '';
        const body = textOf(part.content);
        parts.push({
          type: 'text',
          text: `<tool_result name="${name}" id="${escapeAttr(part.callId)}"${error}>\n${body}\n</tool_result>`,
        });
        parts.push(...part.content.filter((c) => c.type === 'image'));
      } else {
        parts.push(part);
      }
    }
    const role = message.role === 'tool' ? 'user' : message.role;
    const last = out.at(-1);
    if (last && last.role === role) last.parts = [...last.parts, ...parts];
    else out.push({ ...message, role, parts });
  }
  return out;
}

/** The request the wrapped adapter sees: no native tools, specs in the system prompt, text-only history. */
export function promptedRequest<R extends Pick<ChatRequest, 'system' | 'messages' | 'tools' | 'toolChoice'>>(
  request: R,
): R {
  const tools = request.toolChoice === 'none' ? [] : (request.tools ?? []);
  const system = tools.length > 0 ? [...request.system, { text: toolSpecPrompt(tools) }] : request.system;
  return { ...request, system, messages: serializeHistory(request.messages), tools: undefined, toolChoice: undefined };
}

type Resolved = { ok: true; name: string; args: Record<string, unknown> } | { ok: false; error: string };
export type ValidatorFor = (tool: ToolDef) => ValidateFunction | null;

/** Streaming parser: passes text through, withholds `<tool_call>` blocks (even when tags split across deltas). */
export class PromptedToolParser {
  private buffer = '';
  private state: 'text' | 'call' | 'after' = 'text';
  private emitted = 0;

  constructor(
    private readonly tools: readonly ToolDef[],
    private readonly validatorFor: ValidatorFor,
  ) {}

  get callCount(): number {
    return this.emitted;
  }

  push(delta: string): StreamEvent[] {
    this.buffer += delta;
    const out: StreamEvent[] = [];
    for (;;) {
      if (this.state === 'text') {
        const open = this.buffer.indexOf(OPEN);
        if (open >= 0) {
          this.text(out, this.buffer.slice(0, open));
          this.buffer = this.buffer.slice(open + OPEN.length);
          this.state = 'call';
          continue;
        }
        const hold = partialTagLength(this.buffer, OPEN);
        this.text(out, this.buffer.slice(0, this.buffer.length - hold));
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        return out;
      }
      if (this.state === 'call') {
        const close = this.buffer.indexOf(CLOSE);
        if (close < 0) return out;
        out.push(...this.call(this.buffer.slice(0, close)));
        this.buffer = '';
        this.state = 'after';
        return out;
      }
      // One call per message: whatever follows (often a hallucinated result) is dropped.
      this.buffer = '';
      return out;
    }
  }

  /** Flush at the end of the stream. An unterminated call is parsed only when the model stopped on its own. */
  end(reason: StopReason): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (this.state === 'text') {
      this.text(out, this.buffer);
    } else if (this.state === 'call') {
      if (reason === 'max_tokens') {
        out.push(...this.invalid('The tool call was cut off by the output token limit.', this.buffer));
      } else if (reason !== 'error' && reason !== 'aborted') {
        out.push(...this.call(this.buffer));
      }
    }
    this.buffer = '';
    this.state = 'after';
    return out;
  }

  private text(out: StreamEvent[], text: string): void {
    if (text !== '') out.push({ type: 'text', delta: text });
  }

  private call(raw: string): StreamEvent[] {
    const resolved = this.resolve(raw);
    if (!resolved.ok) return this.invalid(resolved.error, raw);
    return this.events(resolved.name, resolved.args);
  }

  private invalid(error: string, raw: string): StreamEvent[] {
    return this.events(INVALID_TOOL_CALL, { error, raw: raw.trim() });
  }

  private events(name: string, input: Record<string, unknown>): StreamEvent[] {
    const id = newCallId();
    this.emitted++;
    return [
      { type: 'tool_call_start', id, name },
      { type: 'tool_call_delta', id, json: JSON.stringify(input) },
      { type: 'tool_call_end', id, input },
    ];
  }

  private resolve(raw: string): Resolved {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = parseJsonLoose(cleaned);
    if (!parsed.ok) return { ok: false, error: `The tool call is not valid JSON (${parsed.error}).` };
    const call = rec(parsed.value);
    const name = str(call.name);
    if (!name) return { ok: false, error: 'The tool call has no "name".' };
    let args: unknown = call.arguments ?? call.parameters ?? call.input ?? {};
    if (typeof args === 'string') {
      const inner = parseJsonLoose(args);
      if (!inner.ok) return { ok: false, error: `"arguments" is not valid JSON (${inner.error}).` };
      args = inner.value;
    }
    if (!isRecord(args)) return { ok: false, error: '"arguments" must be a JSON object.' };
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      const available = this.tools.map((t) => t.name).join(', ') || 'none';
      return { ok: false, error: `Unknown tool "${name}". Available tools: ${available}.` };
    }
    const validate = this.validatorFor(tool);
    if (validate && !validate(args)) {
      const details = (validate.errors ?? []).map((e) => {
        const extra = str(rec(e.params).additionalProperty);
        return `${e.instancePath || '/'} ${e.message ?? 'is invalid'}${extra ? ` ("${extra}")` : ''}`;
      });
      return { ok: false, error: `Invalid arguments for "${name}": ${details.join('; ')}.` };
    }
    return { ok: true, name, args };
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag` (a tag possibly split across deltas). */
function partialTagLength(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/** Ajv validators per tool schema; schemas that fail to compile skip validation instead of failing the call. */
export function createValidatorCache(): ValidatorFor {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, logger: false });
  const cache = new WeakMap<JsonSchema, ValidateFunction | null>();
  return (tool) => {
    const cached = cache.get(tool.inputSchema);
    if (cached !== undefined) return cached;
    const validate = compileSchema(ajv, tool.inputSchema);
    cache.set(tool.inputSchema, validate);
    return validate;
  };
}

function compileSchema(ajv: Ajv, inputSchema: JsonSchema): ValidateFunction | null {
  try {
    // `$schema` may name a draft this Ajv instance doesn't bundle; validation doesn't depend on it.
    const { $schema: _ignored, ...schema } = inputSchema;
    return ajv.compile(schema);
  } catch {
    return null;
  }
}

async function* streamPrompted(
  adapter: ProviderAdapter,
  request: ChatRequest,
  validatorFor: ValidatorFor,
): AsyncGenerator<StreamEvent> {
  const tools = request.toolChoice === 'none' ? [] : (request.tools ?? []);
  const revisable = adapter.type === 'chatgpt-chat';
  let parser = new PromptedToolParser(tools, validatorFor);
  let raw = '';
  for await (const event of adapter.stream(promptedRequest(request))) {
    if (revisable && (event.type === 'text' || event.type === 'text_snapshot')) {
      raw = event.type === 'text' ? raw + event.delta : event.text;
      parser = new PromptedToolParser(tools, validatorFor);
      const preview = [...parser.push(raw)].filter((part): part is Extract<StreamEvent, { type: 'text' }> => part.type === 'text').map(part => part.delta).join('');
      yield { type: 'text_snapshot', text: preview };
    } else if (event.type === 'text') {
      yield* parser.push(event.delta);
    } else if (event.type === 'finish') {
      const failed = event.reason === 'error' || event.reason === 'aborted';
      if (revisable) {
        // Browser text can change after a complete-looking call; only the confirmed reply may call tools.
        parser = new PromptedToolParser(tools, validatorFor);
        const parsed = [...parser.push(raw), ...parser.end(event.reason)];
        const text = parsed.filter((part): part is Extract<StreamEvent, { type: 'text' }> => part.type === 'text').map(part => part.delta).join('');
        yield { type: 'text_snapshot', text };
        if (!failed) for (const part of parsed) if (part.type !== 'text') yield part;
      } else yield* parser.end(event.reason);
      yield parser.callCount > 0 && !failed ? { ...event, reason: 'tool_use' } : event;
      return;
    } else {
      yield event;
    }
  }
}

/** Wrap an adapter for a model whose tool support is `prompted`. */
export function withPromptedTools(adapter: ProviderAdapter): ProviderAdapter {
  const validatorFor = createValidatorCache();
  const wrapped: ProviderAdapter = {
    type: adapter.type,
    listModels: (signal) => adapter.listModels(signal),
    health: (signal) => adapter.health(signal),
    stream: (request) => streamPrompted(adapter, request, validatorFor),
  };
  const count = adapter.countTokens?.bind(adapter);
  if (count) wrapped.countTokens = (request) => count(promptedRequest(request));
  return wrapped;
}
