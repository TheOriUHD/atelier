/**
 * Provider adapter contract. Every backend (Ollama, llama.cpp, Anthropic, OpenAI, OpenAI-compatible)
 * implements this against the internal message format from @atelier/protocol.
 */
import type {
  Effort,
  Message,
  MessageError,
  ModelInfo,
  ProviderStatus,
  ProviderType,
  RunPhase,
  StopReason,
  Usage,
} from '@atelier/protocol';

/** JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface SystemBlock {
  text: string;
  /** Hint that the prefix ending at this block is stable and worth caching (Anthropic cache_control). */
  cache?: boolean;
}

export interface ChatRequest {
  /** Model id within the provider (not the `provider/model` ref). */
  model: string;
  system: SystemBlock[];
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | { name: string };
  maxOutputTokens: number;
  temperature?: number;
  /** Requested reasoning depth; adapters map it to the provider's mechanism or ignore it. */
  effort?: Effort | null;
  /** Context window to request where the provider needs it explicitly (Ollama num_ctx). */
  contextLength?: number;
  signal: AbortSignal;
  /** How the queue of the model's server treats it (providers/scheduler.ts); adapters ignore it. */
  queue?: QueueOptions;
}

/**
 * Whose request it is: a short one the person is waiting on before anything else (a session's title, an auto mode
 * check), the person's own run, a sub-agent's, or background work.
 */
export type QueuePriority = 'urgent' | 'foreground' | 'subagent' | 'background';

export interface QueueOptions {
  /** Default foreground. */
  priority?: QueuePriority;
  /** Waiting for a slot on the server, with this many requests ahead; null once it starts. */
  onWait?: (ahead: number | null) => void;
  /** Gives up this long after the request started, not counting the time it waited for a slot. */
  timeoutMs?: number;
  /** The conversation it is for: its own other requests (its title, an auto mode check) never count as ahead of it. */
  owner?: string;
}

/**
 * Events are emitted in provider order and end with exactly one `finish`.
 * `usage.input` excludes cache reads/writes, so the full prompt is `input + cacheRead + cacheWrite` for every adapter.
 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  /** Replaces the current reply's text when a browser renderer revises an earlier snapshot. */
  | { type: 'text_snapshot'; text: string }
  | { type: 'thinking'; delta: string }
  /**
   * Opaque data to replay with the current thinking part (signature, encrypted reasoning, reasoning_details).
   * The agent stores it as `ThinkingPart.replay` with `provider` set to the adapter's `type`; adapters only replay
   * thinking parts whose `provider` matches their own type.
   */
  | { type: 'thinking_replay'; data: unknown; redacted?: boolean }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; json: string }
  | { type: 'tool_call_end'; id: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  /**
   * Before any output, what a local server is doing: loading the model (`loading`) or reading the prompt with the
   * model already in memory (`reading`). Only local adapters emit it; consumers that don't show it ignore it.
   */
  | { type: 'phase'; phase: RunPhase }
  | { type: 'finish'; reason: StopReason; error?: MessageError };

export interface ProviderInstance {
  id: string;
  type: ProviderType;
  name: string;
  baseUrl: string;
  /** Resolved secret; never logged. */
  apiKey?: string;
  headers: Record<string, string>;
  /** Available memory budget for metadata-based local context estimates. */
  vramGiB?: number;
  parallelRequests?: number;
  modelsAtOnce?: number;
  /** ChatGPT Chat: whether it chats in temporary chats (default). */
  temporaryChat?: boolean;
}

/** A discovered model before user state (hidden, favorite, order) is applied. */
export type ListedModel = Omit<ModelInfo, 'hidden' | 'favorite' | 'order'>;
export type HealthResult = Omit<ProviderStatus, 'providerId' | 'modelCount' | 'checkedAt'>;

export interface ProviderAdapter {
  readonly type: ProviderType;
  /** Discover models with best-known capabilities (before user overrides are applied). */
  listModels(signal?: AbortSignal): Promise<ListedModel[]>;
  health(signal?: AbortSignal): Promise<HealthResult>;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
  /** Exact input token count when the provider exposes one (Anthropic count_tokens, llama.cpp /tokenize). */
  countTokens?(request: Omit<ChatRequest, 'signal'> & { signal?: AbortSignal }): Promise<number>;
  /** What the server reports about its capacity (llama.cpp's slots), to size its queue (providers/scheduler.ts). */
  serverLimits?(signal?: AbortSignal): Promise<{ parallel?: number; modelsAtOnce?: number }>;
}

/**
 * The fetch every adapter must use, so the Developer › Request inspector can observe traffic
 * (with secrets redacted) and tests can replay recorded fixtures.
 */
export type ProviderFetch = (input: string, init: RequestInit & { signal?: AbortSignal | null }) => Promise<Response>;

/** The ChatGPT subscription's sign-in as an adapter sees it (providers/chatgpt-auth.ts): tokens, refreshed when needed. */
export interface ChatGptPort {
  /** What a request needs; `force` takes a new token (after a 401). Rejects with `ChatGptSignedOut` when nobody is signed in. */
  credentials(options?: { force?: boolean }): Promise<{ accessToken: string; accountId: string; installationId: string }>;
  /** Sees every reply's headers: the plan's usage windows ride in them. */
  observe(headers: Headers): void;
}

/** GitHub Copilot's sign-in as an adapter sees it (providers/copilot-auth.ts): a Copilot token, exchanged again when needed. */
export interface CopilotPort {
  /** The token and API address for a request; `force` exchanges again (after a 401). Rejects with `CopilotSignedOut` without a usable sign-in. */
  credentials(options?: { force?: boolean }): Promise<{ token: string; baseUrl: string }>;
}

export interface AdapterDeps {
  fetch: ProviderFetch;
  /** Reads a blob (image/document bytes) referenced by sha256 from the blob store. */
  readBlob: (sha256: string) => Promise<Uint8Array>;
  /**
   * The ChatGPT subscription provider needs it; every backend has it (a browser sign-in on the desktop, a device code
   * on a server).
   */
  chatgpt?: ChatGptPort;
  chatgptChat?: import('./chatgpt-chat.ts').ChatGptChatPort;
  /** The GitHub Copilot provider needs it; every backend has it. */
  copilot?: CopilotPort;
}
