/**
 * One agent turn: stream the model's reply into an incrementally persisted assistant message, execute
 * any tool calls, append their results and continue until the model stops calling tools.
 * Streaming parts are persisted in batches; until a message is final, `live` exposes its in-memory parts
 * so a snapshot taken mid-stream reflects every event emitted so far.
 */
import type { Effort, Message, MessageError, ModelInfo, Part, RunEvent, StopReason, ToolCallPart, ToolResultPart, Usage } from '@atelier/protocol';
import { escapeTags } from '../prompts/escape.ts';
import type { ChatRequest, JsonSchema, ProviderAdapter, QueueOptions, SystemBlock } from '../providers/types.ts';
import type { SessionRepo } from '../sessions/session-repo.ts';
import type { DescribedTool, ToolOutput } from '../tools/types.ts';
import { newId } from '../util/ids.ts';

import { createValidatorCache, INVALID_TOOL_CALL } from '../providers/prompted-tools.ts';
import { isRecord, rec } from '../providers/util.ts';

export interface TurnOptions {
  sessionId: string;
  repo: SessionRepo;
  adapter: ProviderAdapter;
  model: ModelInfo;
  system: SystemBlock[];
  tools: DescribedTool[];
  /** Tools whose schemas have been loaded for this request. */
  availableTools?(): DescribedTool[];
  effort: Effort | null;
  temperature?: number;
  signal: AbortSignal;
  /** Priority and waiting updates for the model server's queue. */
  queue?: QueueOptions;
  /**
   * Most model calls in one turn (each tool round trip is one step). Unset, a turn goes on until the model is done, the
   * person stops it or the same call keeps repeating (`REPEAT_STOP`); sub-agents, which nobody watches, get a ceiling.
   */
  maxSteps?: number;
  emit(event: RunEvent): void;
  /** Receives the in-memory parts of the message being streamed (mutated in place), then null once it is final. */
  live?(messageId: string, parts: readonly Part[] | null): void;
  /**
   * Approves or refuses a validated call, possibly after asking the person; an approval may replace the input
   * (a PreToolUse hook's `updatedInput`). Without it every call runs.
   */
  authorize?(call: ToolCallPart, tool: DescribedTool): Promise<{ allow: true; input?: unknown } | { allow: false; message: string }>;
  /** Sees each result before the model does (PostToolUse hooks, context notes) and may add to it. */
  afterTool?(call: ToolCallPart, output: ToolOutput): Promise<ToolOutput>;
  /** A reply hit the output limit: add the note that asks the model to carry on (once per turn). */
  onOutputCut?(): Promise<void>;
  /**
   * Before each model request: the messages to send (stored history in a form this model can consume, compacted and
   * fitted to its window when needed) and the reply's token cap.
   */
  prepare(): Promise<PreparedRequest>;
  /** The provider rejected a request as too long: prepare a smaller one for the single retry. */
  recoverOverflow?(): void;
  onUsage?(usage: Usage, messageId: string): void;
}

export interface PreparedRequest {
  messages: Message[];
  maxOutputTokens: number;
}

export interface TurnResult {
  stopReason: StopReason;
  error: MessageError | null;
  lastAssistantId: string | null;
}

const PERSIST_INTERVAL_MS = 750;
/** Further attempts at a request whose reply the server couldn't parse (`model_output_invalid`). */
const MALFORMED_RETRIES = 2;
export const NETWORK_RETRY_DELAYS_MS = [5, 10, 15, 30, 60, 120, 240, 480, 960, 1920].map((seconds) => seconds * 1000);
/** Silence from the model server after which the status line says so (and how often that is checked). */
const QUIET_AFTER_MS = 60_000;
const QUIET_CHECK_MS = 5_000;
/** Null for a schema Ajv can't compile (a connector's, say): the call then runs unvalidated rather than failing the turn. */
const validatorFor = createValidatorCache();

/** The same call with the same result this many times in the recent steps: the model is told, then the turn is stopped. */
export const REPEAT_NUDGE = 6;
export const REPEAT_STOP = 15;
/** How many recent calls repeats are counted over. */
const REPEAT_WINDOW = 60;
/** Waiting on something else changes nothing by design: polling a background command is not a loop. */
const POLLING = new Set(['BashOutput', 'TaskStop', 'AskUser', 'TodoWrite']);

/** A call and what came of it, for noticing the same thing happening over and over. */
function signature(call: Extract<Part, { type: 'tool_call' }>, result: ToolResultPart): string {
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n').slice(0, 400);
  return `${call.name}\u0000${JSON.stringify(call.input ?? null)}\u0000${result.isError ? 'E' : 'O'}\u0000${text}`;
}

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const maxSteps = opts.maxSteps ?? Infinity;
  let lastAssistantId: string | null = null;
  let continued = false;
  const recent: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal.aborted) return { stopReason: 'aborted', error: null, lastAssistantId };
    let result = await streamAssistantMessage(opts, await opts.prepare(), !!opts.recoverOverflow);
    // Too long after all (estimates are estimates): fit it again, tighter, and retry into the same message once.
    if (result.detached && opts.recoverOverflow) {
      opts.recoverOverflow();
      result = await streamAssistantMessage(opts, await opts.prepare(), false, result.message);
    }
    lastAssistantId = result.message.id;
    const calls = result.message.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
    // Cut off by the output limit: carry on once, after a note saying so (a half-written call never ran).
    if (result.stopReason === 'max_tokens' && opts.onOutputCut && !continued && !opts.signal.aborted) {
      continued = true;
      await opts.onOutputCut();
      continue;
    }
    if (result.stopReason !== 'tool_use' || calls.length === 0 || opts.signal.aborted) {
      return { stopReason: result.stopReason, error: result.error, lastAssistantId };
    }
    const results = await executeToolCalls(calls, opts, result.message.id);
    // The same call with the same result again and again is a loop, not progress: say so, and in the end stop.
    let repeated = 0;
    calls.forEach((call, i) => {
      if (POLLING.has(call.name)) return;
      const sig = signature(call, results[i]!);
      recent.push(sig);
      if (recent.length > REPEAT_WINDOW) recent.shift();
      const seen = recent.filter((s) => s === sig).length;
      repeated = Math.max(repeated, seen);
      if (seen === REPEAT_NUDGE) {
        results[i]!.content = [
          ...results[i]!.content,
          { type: 'text', text: `Note: this is the ${REPEAT_NUDGE}th time this exact call was made with the same result. Repeating it won't change anything: take a different approach, or tell the person what is blocking you.` },
        ];
      }
    });
    const toolMessage = await opts.repo.insertMessage({
      id: newId(),
      sessionId: opts.sessionId,
      parentId: result.message.id,
      role: 'tool',
      parts: results,
      model: null,
      usage: null,
      stopReason: null,
      error: null,
      kind: 'normal',
      summarizesThroughId: null,
    });
    opts.emit({ type: 'message', message: toolMessage });
    if (repeated >= REPEAT_STOP) {
      return {
        stopReason: 'error',
        error: { code: 'repeating', message: `Stopped: the same action ran ${REPEAT_STOP} times with the same result. Send a message to continue, ideally saying what to do differently.`, retryable: false },
        lastAssistantId,
      };
    }
  }
  return {
    stopReason: 'error',
    error: { code: 'max_steps', message: `Stopped after ${maxSteps} tool steps. Send a message to continue.`, retryable: false },
    lastAssistantId,
  };
}

/**
 * Streams one reply into a new message, or into `reuse` (a detached attempt) moved under the current head. With
 * `detachOnOverflow`, a request rejected as too long before any output leaves the branch instead of ending with an
 * error, so it can be retried.
 */
async function streamAssistantMessage(
  opts: TurnOptions,
  prepared: PreparedRequest,
  detachOnOverflow: boolean,
  reuse?: Message,
): Promise<{ message: Message; stopReason: StopReason; error: MessageError | null; detached?: boolean }> {
  const head = (await opts.repo.getRow(opts.sessionId))?.headMessageId ?? null;
  let message: Message;
  if (reuse) {
    await opts.repo.reparent(reuse.id, head);
    await opts.repo.update(opts.sessionId, { headMessageId: reuse.id });
    message = { ...reuse, parentId: head };
  } else {
    message = await opts.repo.insertMessage({
      id: newId(),
      sessionId: opts.sessionId,
      parentId: head,
      role: 'assistant',
      parts: [],
      model: opts.model.ref,
      usage: null,
      stopReason: null,
      error: null,
      kind: 'normal',
      summarizesThroughId: null,
    });
  }
  opts.emit({ type: 'message', message });

  const parts: Part[] = [];
  opts.live?.(message.id, parts);
  const toolJson = new Map<string, number>(); // tool call id -> part index
  let usage: Usage | null = null;
  let stopReason: StopReason = 'end';
  let error: MessageError | null = null;
  let dirty = false;
  let lastPersist = Date.now();
  // Reset when the request leaves the server's queue: speed counts from there.
  let started = Date.now();
  // The server's phase before the first output (loading the model, reading the prompt), shown until output arrives.
  let phaseShown = false;
  const clearPhase = () => {
    if (!phaseShown) return;
    phaseShown = false;
    opts.emit({ type: 'phase', phase: null });
  };

  const persist = async (force = false) => {
    if (!dirty || (!force && Date.now() - lastPersist < PERSIST_INTERVAL_MS)) return;
    await opts.repo.updateMessage(message.id, { parts: structuredClone(parts) });
    dirty = false;
    lastPersist = Date.now();
  };
  const appendText = (kind: 'text' | 'thinking', delta: string) => {
    let last = parts[parts.length - 1];
    if (!last || last.type !== kind) {
      last = kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', text: '', provider: opts.adapter.type };
      parts.push(last);
      opts.emit({ type: 'part', messageId: message.id, index: parts.length - 1, part: structuredClone(last) });
    }
    (last as { text: string }).text += delta;
    dirty = true;
    opts.emit({ type: 'delta', messageId: message.id, index: parts.length - 1, kind, text: delta });
  };

  const availableTools = opts.availableTools?.() ?? opts.tools;
  const request: ChatRequest = {
    model: opts.model.modelId,
    system: opts.system,
    messages: prepared.messages,
    ...(availableTools.length ? { tools: availableTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } : {}),
    maxOutputTokens: prepared.maxOutputTokens,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    effort: opts.effort,
    contextLength: opts.model.contextLength,
    signal: opts.signal,
    queue: {
      ...opts.queue,
      onWait: (ahead) => {
        if (ahead === null) started = Date.now();
        opts.queue?.onWait?.(ahead);
      },
    },
  };

  let networkRetries = 0;
  for (let attempt = 0; ; attempt++) {
    let finished = false;
    // A model server that goes quiet in the middle of an answer (a hung runner, a stalled GPU) raises no error until the
    // idle limit (providers/plain-http.ts, 15 minutes) and a long tool call is silent too, so after a minute without
    // output the line under the transcript says so instead of looking busy; the next output clears it.
    let lastEventAt = Date.now();
    const quietWatch = setInterval(() => {
      if (phaseShown || Date.now() - lastEventAt < QUIET_AFTER_MS) return;
      phaseShown = true;
      opts.emit({ type: 'phase', phase: 'quiet' });
    }, QUIET_CHECK_MS);
    quietWatch.unref?.();
    try {
      for await (const ev of opts.adapter.stream(request)) {
        lastEventAt = Date.now();
        if (ev.type !== 'phase' && ev.type !== 'usage' && ev.type !== 'finish') clearPhase();
        switch (ev.type) {
          case 'phase':
            phaseShown = true;
            opts.emit({ type: 'phase', phase: ev.phase });
            break;
          case 'text':
          case 'thinking':
            appendText(ev.type, ev.delta);
            break;
          case 'text_snapshot': {
            let index = parts.findIndex(part => part.type === 'text');
            if (index < 0) {
              if (!ev.text) break;
              index = parts.length;
              parts.push({ type: 'text', text: ev.text });
            } else parts[index] = { type: 'text', text: ev.text };
            dirty = true;
            opts.emit({ type: 'part', messageId: message.id, index, part: { type: 'text', text: ev.text } });
            break;
          }
          case 'thinking_replay': {
            let last = parts[parts.length - 1];
            const fresh = !last || last.type !== 'thinking';
            if (fresh) parts.push((last = { type: 'thinking', text: '', provider: opts.adapter.type }));
            const thinking = last as Extract<Part, { type: 'thinking' }>;
            thinking.replay = ev.data;
            if (ev.redacted) thinking.redacted = true;
            dirty = true;
            // Clients index parts by position, so a part that arrives without deltas is announced too.
            if (fresh) opts.emit({ type: 'part', messageId: message.id, index: parts.length - 1, part: structuredClone(thinking) });
            break;
          }
          case 'tool_call_start': {
            parts.push({ type: 'tool_call', id: ev.id, name: ev.name, input: {} });
            toolJson.set(ev.id, parts.length - 1);
            dirty = true;
            opts.emit({ type: 'part', messageId: message.id, index: parts.length - 1, part: structuredClone(parts[parts.length - 1]!) });
            break;
          }
          case 'tool_call_delta': {
            const index = toolJson.get(ev.id);
            if (index !== undefined) opts.emit({ type: 'delta', messageId: message.id, index, kind: 'tool_input', text: ev.json });
            break;
          }
          case 'tool_call_end': {
            const index = toolJson.get(ev.id);
            if (index === undefined) break;
            const part = parts[index] as Extract<Part, { type: 'tool_call' }>;
            part.input = ev.input;
            dirty = true;
            opts.emit({ type: 'part', messageId: message.id, index, part: structuredClone(part) });
            break;
          }
          case 'usage':
            usage = { ...ev.usage, durationMs: Date.now() - started };
            break;
          case 'finish':
            finished = true;
            stopReason = ev.reason;
            error = ev.error ?? null;
            break;
        }
        await persist();
      }
    } catch (e) {
      if (opts.signal.aborted) stopReason = 'aborted';
      else {
        stopReason = 'error';
        error = { code: 'provider_error', message: e instanceof Error ? e.message : 'The model request failed', retryable: true };
      }
    } finally {
      clearInterval(quietWatch);
    }
    clearPhase();
    if (!finished && !error && !opts.signal.aborted) {
      stopReason = 'error';
      error = { code: 'provider_offline', message: 'The model connection ended before the reply was complete.', retryable: true };
    }
    if (error?.retryable && error.code !== 'model_output_invalid' && !opts.signal.aborted && networkRetries < NETWORK_RETRY_DELAYS_MS.length) {
      const waitMs = NETWORK_RETRY_DELAYS_MS[networkRetries++]!;
      // No tool from this response has run yet. Replace only this incomplete response, never earlier tool rounds.
      parts.length = 0;
      toolJson.clear();
      usage = null;
      dirty = true;
      await persist(true);
      opts.emit({ type: 'message', message: { ...message, parts: [], usage: null, stopReason: null, error: null } });
      phaseShown = true;
      opts.emit({ type: 'phase', phase: 'retrying', retryAttempt: networkRetries });
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(opts.signal.reason); };
          const timer = setTimeout(() => { opts.signal.removeEventListener('abort', abort); resolve(); }, waitMs);
          opts.signal.addEventListener('abort', abort, { once: true });
          if (opts.signal.aborted) abort();
        });
      } catch {
        stopReason = 'aborted';
        error = null;
        clearPhase();
        break;
      }
      clearPhase();
      parts.length = 0;
      dirty = true;
      await persist(true);
      opts.emit({ type: 'message', message: { ...message, parts: [], usage: null, stopReason: null, error: null } });
      error = null;
      stopReason = 'end';
      started = Date.now();
      continue;
    }
    // The server couldn't parse what the model generated (a malformed tool call or channel header): a sampling
    // accident, so the same request is asked again, up to twice, as long as nothing of the reply arrived.
    if (error?.code !== 'model_output_invalid' || parts.length > 0 || opts.signal.aborted || attempt >= MALFORMED_RETRIES) break;
    error = null;
    stopReason = 'end';
    usage = null;
  }
  if (opts.signal.aborted && stopReason !== 'error') stopReason = 'aborted';

  // A model with native tools that wrote its one call as text (`artifact {…}`, `Read[CALL_ID]{…}`) instead of making it.
  if (stopReason === 'end' && !error && !parts.some((p) => p.type === 'tool_call')) {
    const recovered = callWrittenAsText(parts, availableTools);
    if (recovered) {
      parts[recovered.index] = recovered.call;
      stopReason = 'tool_use';
      opts.emit({ type: 'part', messageId: message.id, index: recovered.index, part: structuredClone(recovered.call) });
    }
  }

  if (detachOnOverflow && error?.code === 'context_overflow' && parts.length === 0) {
    opts.live?.(message.id, null);
    await opts.repo.update(opts.sessionId, { headMessageId: message.parentId });
    return { message, stopReason, error, detached: true };
  }
  await opts.repo.updateMessage(message.id, { parts, usage, stopReason, error });
  opts.live?.(message.id, null);
  if (usage) opts.onUsage?.(usage, message.id);
  opts.emit({ type: 'done', messageId: message.id, usage, stopReason, error });
  return { message: { ...message, parts, usage, stopReason, error }, stopReason, error };
}

/**
 * The reply's only visible text is one call written out: `Name {json}`, optionally with a bracketed call id between
 * (`Read[CALL_ID]{…}`) and optionally in a code fence. It counts only for a tool the session has, with an input that
 * passes the tool's schema, and only when nothing else was said: prose that quotes a call stays prose.
 */
export function callWrittenAsText(
  parts: readonly Part[],
  tools: readonly { name: string; description?: string; inputSchema: JsonSchema }[],
): { index: number; call: Extract<Part, { type: 'tool_call' }> } | null {
  const texts = parts.flatMap((p, index) => (p.type === 'text' && p.text.trim() ? [{ p, index }] : []));
  if (texts.length !== 1) return null;
  const { p, index } = texts[0]!;
  const found = /^(?:```(?:json)?\s*)?([A-Za-z_][\w.-]*)\s*(?:\[[^\]\n]*\])?\s*(\{[\s\S]*\})\s*(?:```)?$/.exec((p as { text: string }).text.trim());
  if (!found) return null;
  const tool = tools.find((t) => t.name === found[1]);
  if (!tool) return null;
  let input: unknown;
  try {
    input = JSON.parse(found[2]!);
  } catch {
    return null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const validate = validatorFor({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema });
  if (validate && !validate(input)) return null;
  return { index, call: { type: 'tool_call', id: `call_${newId()}`, name: tool.name, input } };
}

async function executeToolCalls(
  calls: Extract<Part, { type: 'tool_call' }>[],
  opts: TurnOptions,
  messageId: string,
): Promise<ToolResultPart[]> {
  const byName = new Map((opts.availableTools?.() ?? opts.tools).map((t) => [t.name, t]));
  const runOne = async (call: (typeof calls)[number]): Promise<ToolResultPart> => {
    const output = await invoke(call, byName.get(call.name), opts, messageId);
    return { type: 'tool_result', callId: call.id, content: output.content, ...(output.isError ? { isError: true } : {}) };
  };
  // Read-only tools run concurrently; anything that mutates runs in order.
  const results: ToolResultPart[] = new Array(calls.length);
  let batch: number[] = [];
  const flush = async () => {
    const done = await Promise.all(batch.map((i) => runOne(calls[i]!)));
    batch.forEach((i, k) => (results[i] = done[k]!));
    batch = [];
  };
  for (let i = 0; i < calls.length; i++) {
    if (byName.get(calls[i]!.name)?.readOnly) batch.push(i);
    else {
      await flush();
      results[i] = await runOne(calls[i]!);
    }
  }
  await flush();
  return results;
}

/**
 * Top-level arguments sent as JSON text where the schema wants an array or an object (nemotron-3.5 sent AskUser's
 * `questions` as a string), parsed; null when none needed it or a parse doesn't give the wanted type.
 */
export function parseStringifiedArgs(input: unknown, schema: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const properties = rec(rec(schema).properties);
  const out = { ...input };
  let changed = false;
  for (const [key, value] of Object.entries(input)) {
    const want = rec(properties[key]).type;
    if (typeof value !== 'string' || (want !== 'array' && want !== 'object')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (want === 'array' ? !Array.isArray(parsed) : !isRecord(parsed)) continue;
    out[key] = parsed;
    changed = true;
  }
  return changed ? out : null;
}

async function invoke(sent: Extract<Part, { type: 'tool_call' }>, tool: DescribedTool | undefined, opts: TurnOptions, messageId: string): Promise<ToolOutput> {
  let call = sent;
  if (call.name === INVALID_TOOL_CALL) {
    const detail = (call.input as { error?: string } | null)?.error ?? 'unparseable';
    return { content: [{ type: 'text', text: `Your tool call could not be parsed (${detail}). Emit exactly one well-formed call.` }], isError: true };
  }
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool "${call.name}".` }], isError: true };
  const validate = validatorFor(tool);
  if (validate && !validate(call.input)) {
    const why = validate.errors?.map((e) => `${e.instancePath || 'input'} ${e.message}`).join('; ') ?? 'invalid input';
    const parsed = parseStringifiedArgs(call.input, tool.inputSchema);
    if (!parsed || !validate(parsed)) return { content: [{ type: 'text', text: `Invalid input for ${tool.name}: ${why}` }], isError: true };
    // The call as stored stays as the model sent it; permissions, hooks and the tool see the parsed arguments.
    call = { ...call, input: parsed };
  }
  const verdict = opts.authorize ? await opts.authorize(call, tool) : { allow: true as const };
  if (!verdict.allow) return { content: [{ type: 'text', text: verdict.message }], isError: true };
  const input = 'input' in verdict && verdict.input !== undefined ? verdict.input : call.input;
  if (validate && input !== call.input && !validate(input)) {
    const why = validate.errors?.map((e) => `${e.instancePath || 'input'} ${e.message}`).join('; ') ?? 'invalid input';
    return { content: [{ type: 'text', text: `A hook changed the input of ${tool.name} into something invalid: ${why}` }], isError: true };
  }
  let output: ToolOutput;
  try {
    output = await tool.run(input, { sessionId: opts.sessionId, messageId, callId: call.id, signal: opts.signal, emit: opts.emit });
  } catch (e) {
    output = { content: [{ type: 'text', text: `${tool.name} failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
  // Tool output is never Atelier speaking: it can't open or close Atelier's tags (prompts/escape.ts).
  output = { ...output, content: output.content.map((c) => (c.type === 'text' ? { ...c, text: escapeTags(c.text) } : c)) };
  return opts.afterTool ? opts.afterTool(call, output) : output;
}
