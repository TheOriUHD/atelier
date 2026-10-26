/**
 * Orchestrates runs per session: sending, editing, retrying, stopping, compaction and titles, and the
 * reconnect contract (snapshot + monotonic per-session seq). Runs live here, independent of any UI
 * connection, so closing a window or tab never interrupts them.
 */
import { pathOps } from '../paths.ts';
import {
  defaultModelFor,
  effectiveEffort,
  effortGuidance,
  formatInterval,
  nativeEfforts,
  defaultUserPrefs,
  messageText,
  projectFilesInPrompt,
  QUOTE_MAX_CHARS,
  QUOTE_MAX_COUNT,
  shownEffort,
  ULTRACODE_LEVEL,
  ULTRACODE_MAX_SUBAGENTS,
  type ContextPart,
  type ContextUsage,
  type Effort,
  type EffortOptions,
  type ElicitationAnswer,
  type ElicitationRequest,
  type HookEvent,
  type HooksConfig,
  type Message,
  type MessageError,
  type ModelInfo,
  type Part,
  type PromptTier,
  type RunEvent,
  type RunPhase,
  type OutboxMessage,
  type SessionSnapshot,
  type SessionSummary,
  type Settings,
  type PendingInteraction,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRequest,
  type QuestionAnswer,
  type SafeguardsOverride,
  type Todo,
  type ToolCallPart,
  type ToolResultPart,
  type Usage,
  type UserPrefs,
} from '@atelier/protocol';
import { createHash } from 'node:crypto';
import type { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { BLOCKS_IN_A_ROW, BLOCKS_TOTAL, parseVerdict, reviewInput, reviewLeniency } from '../permissions/auto-mode.ts';
import { decide, outsideRoots, SANDBOX_TOOLS, sandboxDecide, suggestRule, type Decision, type PermissionContext } from '../permissions/engine.ts';
import { InteractionBroker } from './interactions.ts';
import type { FileRepo } from '../files/file-repo.ts';
import { canExtractText, extractText } from '../files/text-extract.ts';
import { instructionNames, readAncestors } from '../instructions/instructions.ts';
import { fitCompactBudget, type Trim } from '../prompts/budget.ts';
import { buildSystemPrompt, type ProjectContext, type PromptContext } from '../prompts/builder.ts';
import { localDate, modelFacts } from '../prompts/env.ts';
import { escapeAttr, escapeTags, unescapeAttr } from '../prompts/escape.ts';
import { safeguardsBlock } from '../prompts/safeguards.ts';
import { render, renderNote, template } from '../prompts/templates.ts';
import type { ProjectRepo } from '../projects/project-repo.ts';
import { firstUsableModel } from '../providers/model-choice.ts';
import type { JsonSchema, ProviderAdapter, QueueOptions, SystemBlock, ToolDef } from '../providers/types.ts';
import { toSummary, type SessionRepo, type SessionRow } from '../sessions/session-repo.ts';
import { usesPersonalContext } from '../sessions/temporary.ts';
import type { BlobStore } from '../store/blobs.ts';
import { createArtifactTool } from '../tools/artifact.ts';
import { createInlineVisualTool } from '../tools/inline-visual.ts';
import { createAgentTool, type Delegation } from '../tools/agent.ts';
import { createAskUserTool } from '../tools/ask-user.ts';
import { createSkillTool } from '../tools/skill.ts';
import { renderSkill, renderSkillList, type Skill } from '../extensions/skills.ts';
import { renderCommand, type Command } from '../extensions/commands.ts';
import { agentModel, agentPrompt, GENERAL_PURPOSE, type AgentDef } from '../extensions/agents.ts';
import { createCodeTools } from '../tools/code/index.ts';
import type { BackgroundCommands } from '../tools/code/bash.ts';
import { BackgroundTasks } from './background-tasks.ts';
import { Loops, type LoopTick } from './loops.ts';
import { approvedMode, createExitPlanModeTool } from '../tools/exit-plan-mode.ts';
import { createAddConnectorTool, type AddedConnector, type NewConnector } from '../tools/add-connector.ts';
import { createChangeDirectoryTool } from '../tools/change-directory.ts';
import { createTaskStopTool } from '../tools/task-stop.ts';
import { createTimeTool } from '../tools/time.ts';
import { createUsageTool, type UsageReport } from '../tools/usage.ts';
import { createListSessionsTool, createSendMessageTool, LIST_SESSIONS_MAX, type SessionListing } from '../tools/send-message.ts';
import { createTodoWriteTool } from '../tools/todo-write.ts';
import type { Lookup } from '../tools/address-guard.ts';
import { NO_MEMORY, type MemoryAccess } from '../memory/access.ts';
import type { MemoryHooks } from '../memory/memory-service.ts';
import type { Checkpoints } from '../checkpoints/checkpoints.ts';
import { hooksFor, runHooks, type HookInput, type HookOutcome } from '../hooks/hooks.ts';
import { deferConnectors } from '../tools/deferred-connectors.ts';
import { toolSpecPrompt } from '../providers/prompted-tools.ts';
import { createWebFetchTool } from '../tools/web-fetch.ts';
import { createWebSearchTool } from '../tools/web-search.ts';
import { resolveSearchConfig, SearchService } from '../search/service.ts';
import { describeTool, orderTools, type DescribedTool, type Tool, type ToolOutput } from '../tools/types.ts';
import { newId } from '../util/ids.ts';
import type { CodeContext } from '../workspaces/code-context.ts';
import { isTrusted, type Workspace } from '../workspaces/workspace.ts';
import { runTurn, type PreparedRequest } from './loop.ts';
import { renderForSummary, renderState, summarize, type CarriedState } from './compaction.ts';
import { afterCompaction, announcedState, todoNudge, turnNote, type GitSnapshot, type NoteState } from './context-notes.ts';
import { isSideChat, mainTranscript, SIDE_CHAT_EFFORT, SIDE_CHAT_KEY, sideChatNote, sideChatTitle, sideChatTools, withSideChatNote } from './side-chat.ts';
import {
  Calibration,
  DEFAULT_CHARS_PER_TOKEN,
  capToolResults,
  compactThreshold,
  contextUsage,
  outputReserve,
  requestChars,
  requestSize,
  roomBudgets,
  stubOldResults,
  tailStart,
  type RequestSize,
} from './context.ts';

export interface ResolvedModel {
  adapter: ProviderAdapter;
  info: ModelInfo;
}

/**
 * The models a session can run on. `userId` is the session's owner: a person's own models (personal providers) serve
 * only them.
 */
export interface ModelResolver {
  /** Throws a ModelUnavailableError when the ref cannot be served. */
  resolve(ref: string, userId?: string | null): Promise<ResolvedModel>;
  /** First visible model, used when nothing is configured for a mode. */
  firstAvailable(): Promise<string | undefined>;
  /** Every model of the enabled providers and the person's own, hidden ones included (providers/model-choice.ts skips those not listed). */
  listModels?(userId?: string | null): Promise<ModelInfo[]>;
  /** `ref`, or `current` when running `ref` would make their shared server swap models (providers/scheduler.ts). */
  avoidSwap?(ref: string, current: string): string;
  /** Waits for a sub-agent's turn on the server of `ref`, telling `onWait` how many are ahead; returns the release. */
  agentTurn?(ref: string, signal: AbortSignal, onWait?: (ahead: number | null) => void, userId?: string | null): Promise<() => void>;
}

/** A turn kept filling the window, however often it was summarized: it stops instead of going around again. */
export class ContextLoopError extends Error {
  constructor(readonly compactions: number) {
    super(
      `This task keeps filling the model's context window: the conversation was summarized ${compactions} times in this one turn and still doesn't fit. It stopped so it doesn't go around again. Raise the model's context length (Settings › Admin › Models), or send a smaller step.`,
    );
  }
}

/** Summaries one turn may make before it is stopped as a loop (a long task in a large window needs a few). */
export const MAX_TURN_COMPACTIONS = 8;

export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly fix = 'settings/providers',
  ) {
    super(message);
  }
}

export interface ChatServiceDeps {
  repo: SessionRepo;
  artifacts: ArtifactRepo;
  files: FileRepo;
  projects: ProjectRepo;
  blobs: BlobStore;
  settings: () => Settings;
  models: ModelResolver;
  promptOverrides: () => Partial<Record<string, string>>;
  sessionEvent(sessionId: string, seq: number, event: RunEvent): void;
  sessionChanged(summary: SessionSummary): void;
  recordUsage(entry: { model: ModelInfo; sessionId: string; userId: string | null; mode: string; usage: Usage }): void;
  /** The session owner's preferences, how the assistant should address them and the admin's safeguards override (ARCHITECTURE §21). */
  person(userId: string | null): Promise<{ prefs: UserPrefs; name: string; safeguards: SafeguardsOverride }>;
  /**
   * Rules, mode and workspace roots for gating a session's tool calls; null runs every call unprompted
   * (chat sessions: their tools only touch the app's own data or read the web).
   */
  permissionContext?(session: SessionRow): Promise<PermissionContext | null>;
  /** The hooks that apply to a session and the workspace they run in (ARCHITECTURE §8); null when none do. */
  hooks?(session: SessionRow): Promise<{ workspace: Workspace; configs: HooksConfig[] } | null>;
  /** Hooks that failed without blocking anything. */
  hookError?(sessionId: string, message: string): void;
  /** The skills and commands a session can use (ARCHITECTURE §10). */
  extensions?(session: SessionRow): Promise<ExtensionCatalog>;
  /** Tools of the enabled MCP connectors, offered in every mode (ARCHITECTURE §9-B). */
  mcpTools?(session: SessionRow): Promise<Tool[]>;
  /** Adds an MCP server the person agreed to (AddConnector) to their connectors and connects to it; without it the tool isn't offered. */
  addConnector?(session: SessionRow, connector: NewConnector): Promise<AddedConnector>;
  /** File pre-images for Rewind; without it Write and Edit keep none. */
  checkpoints?: Checkpoints;
  /** Code and Work sessions: the session's running workspace, for the code tools; null without one. */
  workspace?(session: SessionRow): Promise<Workspace | null>;
  /** Whether this chat can have a sandbox here (a sandbox container or this machine), offered as Bash and Read. */
  chatSandboxAvailable?(session: SessionRow): boolean;
  /** The chat's sandbox, made on first use and kept on the session; throws with a message when it can't be reached. */
  chatSandbox?(session: SessionRow): Promise<Workspace>;
  /** Code and Work sessions: the folder's facts for `<env>` and the instruction files for the frozen system prompt. */
  codeContext?(session: SessionRow): Promise<CodeContext | null>;
  /** Code sessions: the repository's branch, changes and recent commits, for the first turn's note; null when it isn't one. */
  gitSnapshot?(session: SessionRow): Promise<GitSnapshot | null>;
  /** The workspace for a folder on the session's own computer or SSH host (trusting it); throws with a message for the person. */
  moveWorkspace?(session: SessionRow, path: string): Promise<{ id: string; root: string }>;
  /**
   * Lets the workspace's runner reach a path outside its folder, after the person (or Auto mode, or a rule) allowed the
   * call that works on it. The runner refuses every path outside its roots, whatever was approved.
   */
  reach?(session: SessionRow, path: string): Promise<void>;
  /** Stores an "Always allow" rule for the person. */
  rememberRule?(userId: string, rule: string): Promise<void>;
  /** Stores an "Always allow in this project" rule in the session's workspace. Never throws. */
  rememberProjectRule?(session: SessionRow, rule: string): Promise<void>;
  /** Network access for WebFetch/WebSearch (the inspector-wrapped fetch). */
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Web search (the backend shares one, with its rate limits and cache, with Settings); built from `fetch` when absent. */
  search?: SearchService;
  /** DNS for WebFetch's address check (tests inject one; the system resolver otherwise). */
  lookup?: Lookup;
  /** Resolves `${secret:…}` / `${ENV}` references in settings values. */
  resolveRefs(value: string): Promise<string>;
  /** The clock and time zone dates are told in (tests pin them). */
  now?: () => Date;
  timeZone?: string;
  /** Loops' shortest interval, when not the minute everyone gets (ATELIER_LOOP_MIN_INTERVAL_MS, for tests only). */
  loopMinIntervalMs?: number;
  /** The person's folders by id and name, for ListSessions. */
  folders?(userId: string): Promise<{ id: string; name: string }[]>;
  /** Plan limits or API cost for the Usage tool: offered where the model's provider has something to report. */
  usage?: {
    offered(modelRef: string): boolean;
    report(sessionId: string, modelRef: string): Promise<UsageReport | null>;
  };
  /** Memory and past-chat search (ARCHITECTURE › Memory); without it sessions have neither. */
  memory?: MemoryHooks;
}

/** Bumped whenever the shipped prompt files change; recorded in snapshots for debugging and eval reports. */
const PROMPT_VERSION = 4;

/**
 * A session's frozen system prompt and the facts it was built from (docs/PROMPTS.md §1.6). It is rebuilt when the
 * tier, the model, the person's safeguards or the tool set change; anything else reaches the model as a context note.
 */
interface SystemSnapshot {
  version: number;
  tier: string;
  modelRef: string;
  safeguardsHash: string;
  toolsetHash: string;
  /** ISO date the prompt states. */
  date: string;
  blocks: SystemBlock[];
  /** Skills the prompt lists. */
  skills: string[];
  /** Connector tools as first seen: requests send these, not the servers' live definitions, until the tool set changes. */
  mcpTools: ToolDef[];
  /** What the compact tier's budget cut, in order (prompts/budget.ts). */
  trimmed?: Trim[];
  /** sha256 of the memory digest the prompt carries; empty without one. */
  memoryHash?: string;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

/** What a run's requests are built from, and what its context accounting learned on the way (ARCHITECTURE §8). */
interface RequestContext {
  sessionId: string;
  model: ResolvedModel;
  system: SystemBlock[];
  /** The snapshot the system prompt comes from. */
  snapshot: SystemSnapshot;
  tools: DescribedTool[];
  availableTools?(): DescribedTool[];
  toolDefs: ToolDef[];
  /** The level the requests use (`resolveEffort`). */
  effort: Effort | null;
  /** The run works as Ultracode, whatever level its model's own setting sends for it. */
  ultracode: boolean;
  maxOutputTokens: number;
  /** The snapshot as it was before this run, for comparing what changed; null on a session's first run. */
  previous: SystemSnapshot | null;
  /** Tokens the system prompt and tool schemas take (at 4 characters a token). */
  fixedTokens: number;
  /** Compaction starts above this; lowered when a provider rejects a request the estimate let through. */
  threshold: number;
  signal: AbortSignal;
  /** Summarizing failed in this run: older tool results are left out instead of trying again. */
  compactionFailed?: boolean;
  /** Requests prepared in this run so far: after the first, the person is waiting on a reply in progress. */
  requests?: number;
  /** Automatic summaries made in this run so far (MAX_TURN_COMPACTIONS ends it). */
  compactions?: number;
  /** The request last prepared, for the context event once its usage arrives. */
  last?: { size: RequestSize; messages: Message[]; used: number };
  /** A side chat's main session, whose conversation each request carries as a note. */
  mainSessionId?: string;
}

/** How far under the threshold a reply in progress clears old tool output before it would summarize. */
const MID_REPLY_TARGET = 0.7;

const SUBAGENT_BUDGET_SPENT = `This request has used its sub-agent budget: it has started ${ULTRACODE_MAX_SUBAGENTS} sub-agents, the most one request may start, so no more will start. Finish the work with what you have.`;

/** A sub-agent's result when it reached its step cap before it wrote a report. */
const STEP_LIMIT_REACHED = 'The sub-agent stopped at its step limit before it wrote a report, so its work may be unfinished.';
/** What the Agent tool returns for a sub-agent that was stopped (or never started). */
const SUBAGENT_STOPPED: ToolOutput = { content: [{ type: 'text', text: 'The sub-agent was stopped.' }], isError: true };

/** A sub-agent's report, with the messages it ended without reading, so their senders' parent learns they weren't read. */
function withUnread(output: ToolOutput, unread: string[]): ToolOutput {
  if (!unread.length) return output;
  const list = unread.map((m) => `- ${m}`).join('\n');
  return { ...output, content: [...output.content, { type: 'text', text: `\n\nThe sub-agent ended before reading ${unread.length === 1 ? 'this message' : 'these messages'} sent to it:\n${list}` }] };
}

/** What the Agent tool returns at once for a sub-agent it started with `run_in_background`. */
function startedInBackground(description: string, taskId: string): string {
  return `The sub-agent "${description}" is now working in the background (task ${taskId}). Go on with other work: its result arrives in this conversation as a note when it ends. Until then you know nothing of what it finds: don't guess at it, and don't wait for it with sleep or repeated checks.`;
}

/** How a background sub-agent's end reads in the note that tells its parent (`notes/background-agent`). */
const AGENT_OUTCOMES: Record<'done' | 'failed' | 'stopped', string> = { done: 'has finished', failed: 'ended without finishing', stopped: 'was stopped' };
/** …and of one the backend stopped as it shut down, which the parent reads after the restart. */
const STOPPED_BY_RESTART = 'was stopped because Atelier restarted';

/** Background sub-agents one session may have working at once outside Ultracode (whose budget bounds its own). */
export const MAX_BACKGROUND_AGENTS = 8;
/** What the Agent tool returns for one more background sub-agent past MAX_BACKGROUND_AGENTS. */
const BACKGROUND_AGENTS_BUSY = `This conversation already has ${MAX_BACKGROUND_AGENTS} sub-agents working in the background, the most it may have at once, so this one didn't start. Wait for the running ones: each one's result arrives as a note when it ends. Then start it again, or do the work yourself.`;
/** Turns in a row a session starts by itself for background sub-agents' ends; past them the ends wait for the person's next message. */
export const MAX_WAKES = 5;
/** Turns in a row that messages between sessions may start without the person; later messages wait for the person. */
export const MAX_MESSAGE_CHAIN = 3;

/** How a sub-agent's result ends its task in Background tasks. */
const agentStatus = (output: ToolOutput): 'done' | 'failed' | 'stopped' => (output === SUBAGENT_STOPPED ? 'stopped' : output.isError ? 'failed' : 'done');

/**
 * A background sub-agent's end, waiting to reach its parent: as a hidden note at the parent's next model request, or on
 * a turn of its own when the parent is idle (`wake`: the person didn't stop it, and no turn has picked it up yet).
 */
interface PendingNotice {
  part: ContextPart;
  wake: boolean;
  /** A message from another session: how many message-started turns led to it (`MAX_MESSAGE_CHAIN`). */
  depth?: number;
}

/** What Ultracode's notes tell the model one request may spend: the harness enforces the sub-agents, not the review rounds. */
const ULTRACODE_LIMITS = { maxSubagents: ULTRACODE_MAX_SUBAGENTS, maxReviewRounds: 3 };

/**
 * The most model calls a sub-agent's run makes. The person's own turns have no cap: a model that takes a hundred steps
 * to build something good should be left to, and what guards a turn is the loop check (`REPEAT_STOP`, agent/loop.ts),
 * the Stop button and context compaction. A sub-agent runs where nobody watches and its parent waits on it, so it gets a
 * generous ceiling (a defined agent's own `maxTurns` wins). The model isn't told it.
 */
const SUBAGENT_STEPS = { full: 200, compact: 150 };

/** A turn's step cap: none for the person's own turns (Infinity), a ceiling for a sub-agent's. */
export function stepCap(subagent: boolean, tier: PromptTier): number {
  return subagent ? SUBAGENT_STEPS[tier === 'compact' ? 'compact' : 'full'] : Infinity;
}

/** A reply's output cap: more room at High, the model's own maximum at Extra and above (Anthropic's thinking budget comes out of it). */
function outputCap(effort: Effort | null): number {
  if (effort === 'high') return 64_000;
  return effort === 'xhigh' || effort === 'max' || effort === 'ultracode' ? Infinity : 32_000;
}

export class ChatService {
  private runs = new Map<string, ActiveRun>();
  private seqs = new Map<string, number>();
  /** Parts of the message each session is streaming right now; ahead of the store between batched writes. */
  private live = new Map<string, { messageId: string; parts: readonly Part[] }>();
  private contexts = new Map<string, ContextUsage>();
  /** Sessions being summarized right now. */
  private compacting = new Set<string>();
  /** Sessions waiting for a turn on their model's server: how many are ahead. */
  private queued = new Map<string, number>();
  /** Sessions whose model server is loading the model or reading the prompt, before the reply's first output. */
  private phases = new Map<string, RunPhase>();
  private retryAttempts = new Map<string, number>();
  private readonly calibration = new Calibration();
  /** The tail of each running tool call's live output, by session and call id, for snapshots. */
  private toolOutputs = new Map<string, Map<string, string>>();
  /** Child-session links being written, by message (`linkChild`). */
  private linking = new Map<string, Promise<void>>();
  /** Running Ultracode turns, by the session and each of its sub-agents: how many sub-agents the turn has started. */
  private budgets = new Map<string, { subagents: number }>();
  /** Sessions whose title is being written: a second turn before it lands doesn't ask again. */
  private titling = new Set<string>();
  /** The guess at each session's next message while it stands, and the requests still working one out. */
  private suggestions = new Map<string, string>();
  private suggesting = new Map<string, AbortController>();
  /** Running sub-agents' own stop (the Background tasks pane's), which also reaches one still waiting for its turn. */
  private agentStops = new Map<string, AbortController>();
  /** Counts events that reflect stored changes (everything but streaming output), so snapshots can detect races. */
  private versions = new Map<string, number>();
  private extracted = new Map<string, string>();
  /** Background commands, sub-agents and loops, per top-level session. */
  readonly tasks: BackgroundTasks;
  /** `/loop`: prompts sent again every interval while their session is idle. */
  readonly loops: Loops;
  /** Sub-agents running in the background, by parent session: each settles once its end has been noted for the parent. */
  private backgroundAgents = new Map<string, Map<string, Promise<void>>>();
  /** Background sub-agents' ends their parent hasn't been told yet, oldest first. */
  private notices = new Map<string, PendingNotice[]>();
  /** Background sub-agents working for each session, counted from their Agent call until their end is noted. */
  private backgroundPlaces = new Map<string, number>();
  /** Turns each session started by itself for background sub-agents' ends since the person's last message. */
  private wakes = new Map<string, number>();
  /** The sub-agent budget of each session's latest Ultracode request, which turns started by its background sub-agents go on spending. */
  private lastBudgets = new Map<string, { subagents: number }>();
  /** How many message-started turns in a row led to each session's current turn, without the person in between. */
  private chains = new Map<string, number>();
  /** Sessions whose current turn started by itself (`wake`). */
  private wakeTurns = new Set<string>();
  /** Sessions being deleted: nothing new starts in them. */
  private discarding = new Set<string>();
  /** The backend is shutting down: no turn starts on its own any more. */
  private closing = false;

  private readonly webFetch: Tool;
  private readonly webSearch: Tool;
  private readonly todoWrite: Tool;
  private readonly taskStop: Tool;
  private readonly time: Tool;
  private readonly usage: Tool;
  private readonly sendMessage: Tool;
  private readonly sendToParent: Tool;
  private readonly listSessions: Tool;
  private readonly changeDirectory: Tool;
  private readonly addConnector: Tool;
  private readonly askUser: Tool;
  private readonly exitPlanMode: Tool;
  private readonly skill: Tool;
  /** One tool set per running workspace: BashOutput keeps read offsets per instance. */
  private codeTools = new WeakMap<Workspace, Tool[]>();
  private readonly interactions: InteractionBroker;
  /** "Allow for this session" approvals, kept while the backend runs. */
  private sessionRules = new Map<string, string[]>();
  /** Messages sent while a run was going, by session: delivered at its next step or when it ends (`outbox`). */
  private outboxes = new Map<string, OutboxMessage[]>();
  /** A waiting message sent "now": the run it interrupted hands it the next turn when it has ended. */
  private interrupting = new Map<string, OutboxMessage>();
  /** Auto mode's blocks per top-level session: in a row and in all (permissions/auto-mode.ts). */
  private autoBlocks = new Map<string, { row: number; total: number }>();
  /** Tool calls since each session's last TodoWrite (or nudge about it). */
  private sinceTodo = new Map<string, number>();
  /** Instruction files below the root, by session and folder, as the file tools found them. */
  private nested = new Map<string, Map<string, { path: string; content: string }[]>>();

  constructor(private readonly deps: ChatServiceDeps) {
    this.tasks = new BackgroundTasks({
      changed: (sessionId, tasks) => this.emit(sessionId, { type: 'tasks', tasks }),
      stopAgent: (childId) => {
        this.agentStops.get(childId)?.abort();
        return this.stop(childId);
      },
    });
    this.loops = new Loops({
      tasks: this.tasks,
      // A question waiting for the person holds loops back, also one a background sub-agent asks while its parent is idle.
      busy: (sessionId) => this.runs.has(sessionId) || this.interactions.asking(sessionId),
      send: (sessionId, tick) => this.sendFromLoop(sessionId, tick),
      ...(deps.loopMinIntervalMs ? { minIntervalMs: deps.loopMinIntervalMs } : {}),
    });
    this.interactions = new InteractionBroker(async (sessionId, pending) => {
      await this.deps.repo.patchQuietly(sessionId, { pending });
      this.emit(sessionId, { type: 'pending', pending });
      // A background sub-agent may ask while its parent is idle: answered, the parent is idle again, and a loop that
      // waited for the answer goes on.
      const running = this.runs.has(sessionId);
      await this.setStatus(sessionId, pending ? 'waiting' : running ? 'running' : 'idle');
      if (!pending && !running) this.afterRun(sessionId, false);
    });
    this.webFetch = createWebFetchTool({
      fetch: deps.fetch,
      allowPrivateNetworks: () => this.deps.settings().capabilities.webFetchPrivateNetworks,
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      summarize: (content, prompt, ctx) => this.answerFromPage(content, prompt, ctx.sessionId, ctx.signal),
    });
    this.todoWrite = createTodoWriteTool(async (sessionId, todos) => void (await this.deps.repo.update(sessionId, { todos })));
    this.taskStop = createTaskStopTool({
      stop: async (sessionId, taskId) => {
        const top = await this.topLevel(sessionId);
        const task = this.tasks.list(top).find((t) => t.id === taskId);
        if (!task) return null;
        const wasRunning = task.status === 'running';
        if (wasRunning) await this.tasks.stop(top, taskId);
        return { title: task.title, wasRunning };
      },
      running: async (sessionId) => this.tasks.list(await this.topLevel(sessionId)).filter((t) => t.status === 'running').map((t) => t.id),
    });
    this.sendMessage = createSendMessageTool((sessionId, to, message) => this.sendSessionMessage(sessionId, to, message));
    this.sendToParent = createSendMessageTool((sessionId, to, message) => this.sendSessionMessage(sessionId, to, message), true);
    this.listSessions = createListSessionsTool((sessionId, query) => this.sessionsFor(sessionId, query));
    this.time = createTimeTool({ now: () => this.deps.now?.() ?? new Date(), timeZone: () => this.timeZone() });
    this.usage = createUsageTool({
      now: () => (this.deps.now?.() ?? new Date()).getTime(),
      report: async (sessionId) => {
        const ref = await this.modelRef(await this.requireSession(sessionId));
        return ref ? ((await this.deps.usage?.report(sessionId, ref)) ?? null) : null;
      },
    });
    this.askUser = createAskUserTool((sessionId, request, signal) => this.interactions.ask<QuestionAnswer>(sessionId, 'question', request, signal, { answers: {} }));
    this.exitPlanMode = createExitPlanModeTool({
      mode: async (sessionId) => (await this.deps.permissionContext?.(await this.requireSession(sessionId)))?.mode ?? null,
      approve: (sessionId, request, signal) => this.interactions.ask<PermissionAnswer>(sessionId, 'permission', request, signal, { behavior: 'deny', message: 'The response was stopped.' }),
      setMode: async (sessionId, permissionMode) => this.deps.sessionChanged(await this.deps.repo.update(sessionId, { permissionMode })),
    });
    this.changeDirectory = createChangeDirectoryTool({
      approve: (sessionId, request, signal) => this.interactions.ask<PermissionAnswer>(sessionId, 'permission', request, signal, { behavior: 'deny', message: 'The response was stopped.' }),
      current: async (sessionId) => {
        const ws = await this.deps.workspace?.(await this.requireSession(sessionId));
        return { root: ws?.root ?? '', host: ws?.host ?? null };
      },
      move: (sessionId, path) => this.moveSession(sessionId, path),
    });
    this.addConnector = createAddConnectorTool({
      approve: (sessionId, request, signal) => this.interactions.ask<PermissionAnswer>(sessionId, 'permission', request, signal, { behavior: 'deny', message: 'The response was stopped.' }),
      add: async (sessionId, connector) => this.deps.addConnector!(await this.requireSession(sessionId), connector),
    });
    this.skill = createSkillTool(async (sessionId, name, args) => {
      const session = await this.requireSession(sessionId);
      const catalog = await this.deps.extensions?.(session);
      const skill = catalog?.skills.find((s) => s.name === name);
      if (!catalog || !skill) {
        const known = catalog?.skills.map((s) => s.name).slice(0, 40).join(', ');
        throw new Error(`There is no skill named "${name}".${known ? ` Available: ${known}.` : ''}`);
      }
      return this.loadSkill(session, catalog, skill, args);
    });
    this.webSearch = createWebSearchTool({
      service: deps.search ?? new SearchService({ fetch: deps.fetch, config: () => resolveSearchConfig(this.deps.settings().capabilities.webSearch, this.deps.resolveRefs) }),
    });
  }

  /** The top-level session a session belongs to (a sub-agent's parent, or itself). */
  private async topLevel(sessionId: string): Promise<string> {
    return (await this.deps.repo.getRow(sessionId))?.parentSessionId ?? sessionId;
  }

  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  /** Waits for a session's current run (sub-agents, tests and shutdown). */
  async settle(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.done;
  }

  private emit(sessionId: string, event: RunEvent): void {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);
    if (event.type !== 'delta' && event.type !== 'tool_output' && event.type !== 'context' && event.type !== 'compacting' && event.type !== 'queued' && event.type !== 'phase' && event.type !== 'outbox') this.versions.set(sessionId, (this.versions.get(sessionId) ?? 0) + 1);
    if (event.type === 'context') this.contexts.set(sessionId, event.context);
    if (event.type === 'compacting') {
      if (event.active) this.compacting.add(sessionId);
      else this.compacting.delete(sessionId);
    }
    if (event.type === 'queued') {
      if (event.ahead === null) this.queued.delete(sessionId);
      else this.queued.set(sessionId, event.ahead);
    }
    if (event.type === 'phase') {
      if (event.phase === null) this.phases.delete(sessionId);
      else this.phases.set(sessionId, event.phase);
      if (event.phase === 'retrying' && event.retryAttempt !== undefined) this.retryAttempts.set(sessionId, event.retryAttempt);
      else this.retryAttempts.delete(sessionId);
    }
    if (event.type === 'tool_output') {
      const outputs = this.toolOutputs.get(sessionId) ?? new Map<string, string>();
      outputs.set(event.callId, ((outputs.get(event.callId) ?? '') + event.text).slice(-OUTPUT_TAIL_CHARS));
      this.toolOutputs.set(sessionId, outputs);
    }
    // Results are in: the live output is no longer needed.
    if (event.type === 'message' && event.message.role === 'tool') this.toolOutputs.delete(sessionId);
    this.deps.sessionEvent(sessionId, seq, event);
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    // Stored state is read across awaits; if anything was persisted meanwhile, read again so the snapshot and
    // its seq agree. Streaming deltas don't count: the live overlay below covers them.
    for (let attempt = 0; ; attempt++) {
      const version = this.versions.get(sessionId) ?? 0;
      const row = await this.deps.repo.getRow(sessionId);
      if (!row) throw new Error('Session not found');
      const { messages, siblings } = await this.deps.repo.branch(sessionId);
      const summary = (await this.deps.repo.get(sessionId))!;
      if ((this.versions.get(sessionId) ?? 0) !== version && attempt < 3) continue;
      // No awaits from here on: the live parts and seq below describe the same instant.
      const live = this.live.get(sessionId);
      const current = live ? messages.map((m) => (m.id === live.messageId ? { ...m, parts: structuredClone([...live.parts]) } : m)) : messages;
      const last = current.at(-1);
      return {
        session: summary,
        messages: current,
        siblings,
        streamingMessageId: this.runs.has(sessionId) && last?.role === 'assistant' && !last.stopReason ? last.id : null,
        pending: row.pending ? { kind: row.pending.kind as PendingInteraction['kind'], id: row.pending.id, payload: row.pending.payload } : null,
        todos: row.todos as Todo[],
        tasks: this.tasks.list(sessionId),
        toolOutput: Object.fromEntries(this.toolOutputs.get(sessionId) ?? []),
        context: this.contexts.get(sessionId) ?? null,
        compacting: this.compacting.has(sessionId),
        queued: this.queued.get(sessionId) ?? null,
        phase: this.phases.get(sessionId) ?? null,
        retryAttempt: this.retryAttempts.get(sessionId),
        suggestion: this.suggestions.get(sessionId) ?? null,
        outbox: [...(this.outboxes.get(sessionId) ?? [])],
        seq: this.seqs.get(sessionId) ?? 0,
      };
    }
  }

  async send(sessionId: string, rawParts: Part[], parentId?: string | null): Promise<string> {
    const parts = withQuotes(rawParts);
    const id = newId();
    await this.start(sessionId, true, {
      before: async () => {
        const session = await this.requireSession(sessionId);
        const message = await this.deps.repo.insertMessage({
          id,
          sessionId,
          parentId: parentId === undefined ? session.headMessageId : parentId,
          role: 'user',
          parts,
          model: null,
          usage: null,
          stopReason: null,
          error: null,
          kind: 'normal',
          summarizesThroughId: null,
        });
        this.emit(sessionId, { type: 'message', message });
        // The person spoke: background sub-agents' ends may wake the session again.
        this.wakes.delete(sessionId);
      },
    });
    return id;
  }

  /** Edit = a new sibling of the user message, then a fresh reply on that branch. */
  async edit(sessionId: string, messageId: string, parts: Part[]): Promise<string> {
    const original = await this.deps.repo.getMessage(messageId);
    if (!original || original.sessionId !== sessionId || original.role !== 'user') throw new Error('Only your messages can be edited');
    return this.send(sessionId, parts, original.parentId);
  }

  /** Retry = a new sibling reply to the same user turn. */
  async retry(sessionId: string, messageId: string): Promise<void> {
    await this.start(sessionId, false, {
      before: async () => {
        const target = await this.deps.repo.getMessage(messageId);
        if (!target || target.sessionId !== sessionId) throw new Error('Message not found');
        const anchor = target.role === 'user' ? target : target.parentId ? await this.deps.repo.getMessage(target.parentId) : undefined;
        if (!anchor) throw new Error('Nothing to retry');
        await this.deps.repo.update(sessionId, { headMessageId: anchor.id });
        this.wakes.delete(sessionId);
      },
    });
  }

  /**
   * Stops the session's run and the sub-agents it left working in the background. Its loops go on, none sending right
   * after the Stop: each next sends a full interval from now.
   */
  async stop(sessionId: string): Promise<void> {
    this.loops.stopped(sessionId);
    // Messages still waiting go back to the person (the window puts them in the box again): Stop is not "send these".
    this.setOutbox(sessionId, []);
    this.interrupting.delete(sessionId);
    const run = this.runs.get(sessionId);
    run?.controller.abort();
    const background = [...(this.backgroundAgents.get(sessionId) ?? [])];
    for (const [childId] of background) this.agentStops.get(childId)?.abort();
    await Promise.all([run?.done, ...background.map(([, ended]) => ended)]);
  }

  /**
   * A message sent while the agent works. A running session keeps it waiting (shown to the person, who can take it
   * back or send it at once) and the agent takes it at its next step; an idle one simply sends it.
   */
  async queue(sessionId: string, rawParts: Part[]): Promise<{ id: string; queued: boolean }> {
    const parts = withQuotes(rawParts);
    if (!this.runs.has(sessionId)) return { id: await this.send(sessionId, parts), queued: false };
    const item: OutboxMessage = { id: newId(), parts };
    this.setOutbox(sessionId, [...(this.outboxes.get(sessionId) ?? []), item]);
    return { id: item.id, queued: true };
  }

  /**
   * ChangeDirectory approved: the session works in `path`'s folder from its next tool call on, in the same conversation.
   * The frozen system prompt is rebuilt for the next turn (it names the folder and carries its instruction files); this
   * turn, the result tells the model what the new folder holds.
   */
  private async moveSession(sessionId: string, path: string): Promise<string> {
    const session = await this.requireSession(sessionId);
    if (!this.deps.moveWorkspace) throw new Error('This session cannot change folder.');
    const before = (await this.deps.workspace?.(session))?.root ?? null;
    const target = await this.deps.moveWorkspace(session, path);
    if (target.id === session.workspaceId) return `The session is already working in ${target.root}.`;
    this.deps.sessionChanged(await this.deps.repo.update(sessionId, { workspaceId: target.id, systemSnapshot: null }));
    const moved = await this.requireSession(sessionId);
    const [code, git] = await Promise.all([this.deps.codeContext?.(moved).catch(() => null), this.deps.gitSnapshot?.(moved).catch(() => null)]);
    const lines = [
      `The session now works in ${target.root}${before ? ` (it was ${before})` : ''}. Read, Write, Edit, Bash and the search tools use the new folder from here on; the conversation goes on unchanged.`,
      git ? `It is a git repository on branch ${git.branch}${git.changed ? `, ${git.changed} changed file${git.changed === 1 ? '' : 's'}` : ', clean'}.` : 'It is not a git repository.',
    ];
    for (const file of code?.instructions ?? []) {
      lines.push(`<instructions source="${escapeAttr(file.path)}" kind="${file.kind}">\n${escapeTags(file.content.slice(0, MOVED_INSTRUCTION_CHARS).trim())}\n</instructions>`);
    }
    return lines.join('\n');
  }

  /** A codespace is being woken: the running sessions in its folder show it until it is up (or it failed to start). */
  async workspaceWaking(workspaceId: string, waking: boolean): Promise<void> {
    for (const sessionId of [...this.runs.keys()]) {
      const row = await this.deps.repo.getRow(sessionId);
      if (row?.workspaceId === workspaceId) this.emit(sessionId, { type: 'phase', phase: waking ? 'waking' : null });
    }
  }

  /** Takes a waiting message back: its parts, or none when the agent already took it. */
  unqueue(sessionId: string, id: string): Part[] {
    const waiting = this.outboxes.get(sessionId) ?? [];
    const item = waiting.find((m) => m.id === id);
    if (!item) return [];
    this.setOutbox(sessionId, waiting.filter((m) => m !== item));
    return item.parts;
  }

  /**
   * Sends a waiting message now: the step in progress is cut off (what it had written and every finished tool call stay)
   * and the message opens the next turn, which carries on with the task. Background sub-agents and loops are left alone.
   */
  async sendNow(sessionId: string, id: string): Promise<void> {
    const waiting = this.outboxes.get(sessionId) ?? [];
    const item = waiting.find((m) => m.id === id);
    if (!item) return;
    this.setOutbox(sessionId, waiting.filter((m) => m !== item));
    const run = this.runs.get(sessionId);
    if (!run) {
      await this.deliver(sessionId, [item], 'turn-end');
      return;
    }
    this.interrupting.set(sessionId, item);
    run.controller.abort();
  }

  /** The waiting messages changed: remembered, and every window told. */
  private setOutbox(sessionId: string, items: OutboxMessage[]): void {
    if (items.length) this.outboxes.set(sessionId, items);
    else if (!this.outboxes.delete(sessionId)) return;
    this.emit(sessionId, { type: 'outbox', items });
  }

  /** Opens a turn with these messages as the person's, one after the other. */
  private deliver(sessionId: string, items: OutboxMessage[], how: 'turn-end' | 'interrupt'): Promise<void> {
    return this.start(sessionId, true, {
      before: async () => {
        for (const item of items) await this.insertWaiting(sessionId, item, how === 'interrupt' ? 'interrupt' : null);
        // The person spoke: background sub-agents' ends may wake the session again.
        this.wakes.delete(sessionId);
      },
    });
  }

  /** One waiting message into the conversation, with a note for the model when it arrived mid-task. */
  private async insertWaiting(sessionId: string, item: OutboxMessage, note: 'interrupt' | 'step' | null): Promise<void> {
    const session = await this.requireSession(sessionId);
    const parts: Part[] = note
      ? [...item.parts, { type: 'context', text: renderNote(note === 'interrupt' ? 'notes/message-interrupt' : 'notes/message-while-working', {}, this.deps.promptOverrides()) }]
      : item.parts;
    const message = await this.deps.repo.insertMessage({
      id: newId(),
      sessionId,
      parentId: session.headMessageId,
      role: 'user',
      parts,
      model: null,
      usage: null,
      stopReason: null,
      error: null,
      kind: 'normal',
      summarizesThroughId: null,
    });
    this.emit(sessionId, { type: 'message', message });
  }

  /**
   * Waiting messages join the conversation at the agent's next step, in order. A hook on prompts, or a slash command,
   * needs a turn of its own (hooks may block it, commands expand), so those wait for the turn's end.
   */
  private async takeOutbox(sessionId: string): Promise<void> {
    const waiting = this.outboxes.get(sessionId);
    if (!waiting?.length) return;
    const session = await this.requireSession(sessionId);
    const hooks = await this.deps.hooks?.(session);
    if (hooks && hooksFor(hooks.configs, 'UserPromptSubmit').length > 0) return;
    const text = (m: OutboxMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('').trimStart();
    const take: OutboxMessage[] = [];
    for (const m of waiting) {
      if (text(m).startsWith('/')) break;
      take.push(m);
    }
    if (!take.length) return;
    this.setOutbox(sessionId, waiting.filter((m) => !take.includes(m)));
    for (const item of take) await this.insertWaiting(sessionId, item, 'step');
    this.wakes.delete(sessionId);
  }

  /** Stops a conversation that is being deleted and forgets what was kept for it in memory. */
  async discard(sessionId: string): Promise<void> {
    this.discarding.add(sessionId);
    try {
      for (const child of await this.deps.repo.children(sessionId)) if (isSideChat(child)) await this.discard(child.id);
      this.loops.forget(sessionId);
      await this.stop(sessionId);
      this.sessionRules.delete(sessionId);
      this.sinceTodo.delete(sessionId);
      this.nested.delete(sessionId);
      this.seqs.delete(sessionId);
      this.tasks.forget(sessionId);
      this.notices.delete(sessionId);
      this.wakes.delete(sessionId);
      this.chains.delete(sessionId);
      this.lastBudgets.delete(sessionId);
    } finally {
      this.discarding.delete(sessionId);
    }
  }

  /**
   * `/loop`: sends `prompt` now (or once the session is idle) and again every `intervalMs`, at least the shortest
   * interval. Throws LoopLimitError past the session's or `owner`'s loops.
   */
  startLoop(sessionId: string, prompt: string, intervalMs: number, owner: string | null = null): { taskId: string; intervalMs: number } {
    return this.loops.start(sessionId, prompt, intervalMs, owner);
  }

  /** `/loop stop [n|id]`: how many loops stopped. */
  stopLoops(sessionId: string, target: string | null): number {
    return this.loops.stop(sessionId, target);
  }

  /** Moves the conversation back to just before one of the person's messages; the old branch stays reachable. */
  async rewindTo(sessionId: string, messageId: string): Promise<void> {
    if (this.runs.has(sessionId)) throw new Error('Stop the response before rewinding');
    const message = await this.deps.repo.getMessage(messageId);
    if (!message || message.sessionId !== sessionId || message.role !== 'user') throw new Error('Only your messages can be rewound to');
    await this.deps.repo.update(sessionId, { headMessageId: message.parentId });
    this.emit(sessionId, { type: 'branch' });
  }

  async switchBranch(sessionId: string, messageId: string): Promise<SessionSnapshot> {
    if (this.runs.has(sessionId)) throw new Error('Stop the response before switching branches');
    await this.deps.repo.switchBranch(sessionId, messageId);
    // The person's other windows on this conversation follow.
    this.emit(sessionId, { type: 'branch' });
    return this.snapshot(sessionId);
  }

  /**
   * `/compact [focus]`: summarizes everything but a request still waiting for its answer. Runs like a reply: sends,
   * retries and edits wait for it, and Stop cancels it. The RPC serves every mode; only Code offers the command.
   */
  async compact(sessionId: string, focus?: string): Promise<void> {
    if (this.runs.has(sessionId)) throw new Error('Stop the response before compacting');
    const controller = new AbortController();
    const done = (async () => {
      try {
        const session = await this.requireSession(sessionId);
        const ref = await this.modelRef(session);
        if (!ref) throw new ModelUnavailableError('No model available for compaction.');
        // At once, before anything slow (the model, the tools, the prompt) is looked up: the command in the conversation
        // as sent, like any other (it is folded into the summary), and the line that says what it is doing. The command
        // comes first so the running line takes its time from it.
        if ((await this.deps.repo.history(sessionId)).some((m) => m.kind === 'normal'))
          await this.addContextMessage(sessionId, { type: 'context', text: '', notice: { kind: 'command', command: focus ? `/compact ${focus}` : '/compact' } });
        await this.setStatus(sessionId, 'running');
        this.emit(sessionId, { type: 'compacting', active: true });
        const run = await this.requestContext(session, await this.deps.models.resolve(ref, session.userId), controller.signal, false);
        const { summaryTokens } = roomBudgets(run.threshold - run.fixedTokens);
        if (!(await this.compactNow(sessionId, { ...(focus ? { focus } : {}), signal: controller.signal, current: run.model, summaryTokens }))) throw new Error('There is nothing to compact yet.');
        this.emit(sessionId, { type: 'context', context: await this.measure(run, await this.forModel(run), false) });
      } finally {
        this.emit(sessionId, { type: 'compacting', active: false });
        this.runs.delete(sessionId);
        await this.setStatus(sessionId, this.interactions.asking(sessionId) ? 'waiting' : 'idle');
        this.afterRun(sessionId, controller.signal.aborted);
      }
    })();
    this.runs.set(sessionId, { controller, done: done.catch(() => undefined) });
    await done;
  }

  async stopAll(): Promise<void> {
    this.closing = true;
    this.loops.dispose();
    this.tasks.dispose();
    const cut = [...this.runs.keys()];
    // Background sub-agents end with the backend, also those of a parent that isn't running.
    await Promise.all([...new Set([...cut, ...this.backgroundAgents.keys()])].map((id) => this.stop(id)));
    // Their parents are told now, as pending notes live in memory: after the restart they don't wait for them.
    await Promise.all([...this.notices.keys()].map((id) => this.deliverNotices(id).catch(() => undefined)));
    // A stopped run ends as idle, which would read as finished after the restart; the person's own Stop never gets here.
    for (const id of cut) if (!(await this.deps.repo.getRow(id))?.parentSessionId) await this.setStatus(id, 'interrupted').catch(() => undefined);
  }

  /** Carries on with a reply a restart cut off: "Continue" as the person's message, with a note on what happened. */
  async continue(sessionId: string): Promise<void> {
    await this.start(sessionId, true, {
      before: async () => {
        const session = await this.requireSession(sessionId);
        const message = await this.deps.repo.insertMessage({
          id: newId(),
          sessionId,
          parentId: session.headMessageId,
          role: 'user',
          parts: [
            { type: 'text', text: 'Continue' },
            { type: 'context', text: renderNote('notes/restart-continue', {}, this.deps.promptOverrides()) },
          ],
          model: null,
          usage: null,
          stopReason: null,
          error: null,
          kind: 'normal',
          summarizesThroughId: null,
        });
        this.emit(sessionId, { type: 'message', message });
        this.wakes.delete(sessionId);
      },
    });
  }

  // ------------------------------------------------------------------ runs

  /**
   * Starts a turn, the one way every turn starts: refused while the session has a run. `submitted`: the turn answers a
   * message the person just sent (UserPromptSubmit hooks run). `before` stores that message (or moves the branch)
   * inside the run, so nothing else can start in between (a loop's send, a woken turn). `wake`: a turn started for
   * background sub-agents' ends, which continues the sub-agent budget of the request that started them. Settles when
   * `before` has, with its error.
   */
  private start(sessionId: string, submitted = false, opts: { before?(): Promise<void>; wake?: boolean } = {}): Promise<void> {
    if (this.runs.has(sessionId)) return Promise.reject(new Error('A response is still being generated'));
    const controller = new AbortController();
    // A new turn makes the guess at the next message moot, and the request still working one out gives way.
    this.dropSuggestion(sessionId);
    // This turn picks up the ends waiting for it at its first request; if it fails before that, the next turn does.
    for (const notice of this.notices.get(sessionId) ?? []) notice.wake = false;
    // A woken turn continues the chain of the messages it picks up (`deliverNotices`); any other starts a new one.
    this.chains.set(sessionId, 0);
    if (opts.wake) this.wakeTurns.add(sessionId);
    else this.wakeTurns.delete(sessionId);
    const ready = (async () => opts.before?.())();
    const done = (async () => {
      try {
        await ready;
      } catch {
        return;
      }
      await this.run(sessionId, controller.signal, submitted, opts.wake ?? false);
    })().finally(() => {
      this.runs.delete(sessionId);
      this.wakeTurns.delete(sessionId);
      this.live.delete(sessionId);
      this.toolOutputs.delete(sessionId);
      this.afterRun(sessionId, controller.signal.aborted);
    });
    this.runs.set(sessionId, { controller, done });
    return ready;
  }

  /**
   * A session's run ended (`stopped`: by the person, which held its loops back already). A loop that came due meanwhile
   * sends now; otherwise background sub-agents that ended after the run's last request start a turn of their own,
   * except after the person's Stop.
   */
  private afterRun(sessionId: string, stopped: boolean): void {
    if (this.closing || this.discarding.has(sessionId)) return;
    // A message sent "now" interrupted this run: it opens the next turn, which carries on from what was done.
    const now = this.interrupting.get(sessionId);
    if (now) {
      this.interrupting.delete(sessionId);
      void this.deliver(sessionId, [now], 'interrupt').catch(() => undefined);
      return;
    }
    // Messages that arrived too late for a step of this run (during its last reply) are the next turn.
    const waiting = this.outboxes.get(sessionId);
    if (waiting?.length && !stopped) {
      this.setOutbox(sessionId, []);
      void this.deliver(sessionId, waiting, 'turn-end').catch(() => undefined);
      return;
    }
    if (stopped) for (const notice of this.notices.get(sessionId) ?? []) notice.wake = false;
    if (!stopped && this.loops.idle(sessionId)) return;
    this.wake(sessionId);
  }

  /**
   * An idle session with background sub-agents' ends to hear about starts a turn for them: not while a question waits
   * for the person (answered, the session is idle again and wakes then), and MAX_WAKES times in a row at most, after
   * which the ends wait for the person's next message.
   */
  private wake(sessionId: string): void {
    if (this.closing || this.discarding.has(sessionId) || this.runs.has(sessionId) || this.interactions.asking(sessionId)) return;
    if (!this.notices.get(sessionId)?.some((n) => n.wake)) return;
    const woken = this.wakes.get(sessionId) ?? 0;
    if (woken >= MAX_WAKES) return;
    this.wakes.set(sessionId, woken + 1);
    void this.start(sessionId, false, { wake: true }).catch(() => undefined);
  }

  /** A loop's send: its prompt as the person's message, marked as the loop's, with a note that it repeats. */
  private sendFromLoop(sessionId: string, tick: LoopTick): void {
    if (this.closing || this.discarding.has(sessionId)) return;
    const note = renderNote('notes/loop-tick', { interval: formatInterval(tick.intervalMs), run: String(tick.run) }, this.deps.promptOverrides());
    const parts: Part[] = [
      { type: 'text', text: tick.prompt },
      { type: 'context', text: note, notice: { kind: 'loop', loopId: tick.loopId, run: tick.run } },
    ];
    void this.start(sessionId, true, {
      before: async () => {
        const session = await this.requireSession(sessionId);
        const message = await this.deps.repo.insertMessage({
          id: newId(),
          sessionId,
          parentId: session.headMessageId,
          role: 'user',
          parts,
          model: null,
          usage: null,
          stopReason: null,
          error: null,
          kind: 'normal',
          summarizesThroughId: null,
        });
        this.emit(sessionId, { type: 'message', message });
      },
    }).catch(() => undefined);
  }

  private async run(sessionId: string, signal: AbortSignal, submitted: boolean, wake = false): Promise<void> {
    await this.setStatus(sessionId, 'running');
    let finalStatus: 'idle' | 'error' = 'idle';
    try {
      const session = await this.requireSession(sessionId);
      const hooks = await this.deps.hooks?.(session);
      // Sub-agents get tool hooks only: their prompt comes from the parent, and their end is the parent's tool result.
      const turnHooks = session.parentSessionId ? undefined : hooks;
      if (turnHooks && !(await this.beforeTurn(session, turnHooks, submitted, signal))) return;
      if (submitted && !session.parentSessionId) await this.expandSlash(session);
      let resolved: ResolvedModel;
      try {
        const ref = await this.modelRef(session);
        if (!ref) throw new ModelUnavailableError('Add a model provider to start chatting.');
        resolved = await this.deps.models.resolve(ref, session.userId);
        if (!session.model) await this.deps.repo.update(sessionId, { model: ref });
      } catch (error) {
        await this.failWithoutModel(sessionId, error);
        finalStatus = 'error';
        return;
      }
      // Named from the first message right away, ahead of the reply.
      if (!session.parentSessionId && !session.title && !this.titling.has(sessionId)) void this.generateTitle(sessionId, resolved);
      const run = await this.requestContext(session, resolved, signal, true);
      if (!session.parentSessionId) await this.announce(session, run);
      // A defined sub-agent's own `maxTurns` wins over the sub-agents' ceiling; a person's own turn has none.
      const maxSteps = (await this.definedAgentTurns(session)) ?? stepCap(!!session.parentSessionId, resolved.info.tier);
      // An Ultracode turn shares one sub-agent budget with everything it starts, and so does a turn that hears how its
      // background sub-agents ended: one request can't start more than the budget by having them wake it.
      if (run.ultracode) {
        const budget = (wake && this.lastBudgets.get(sessionId)) || { subagents: 0 };
        this.budgets.set(sessionId, budget);
        this.lastBudgets.set(sessionId, budget);
      }
      const offered = new Set(run.tools.map((t) => t.name));
      const turn = () => runTurn({
        sessionId,
        repo: this.deps.repo,
        adapter: resolved.adapter,
        model: resolved.info,
        system: run.system,
        tools: run.tools,
        ...(run.availableTools ? { availableTools: run.availableTools } : {}),
        maxSteps,
        effort: run.effort,
        ...(resolved.info.temperature !== undefined ? { temperature: resolved.info.temperature } : {}),
        signal,
        // The person's own runs go first on a busy model server; sub-agents' requests wait a little longer.
        // Side chats queue like sub-agents too: on a one-model local server they share its slot and model and let the main run go first.
        queue: { priority: session.parentSessionId ? 'subagent' : 'foreground', owner: sessionId, onWait: (ahead) => this.emit(sessionId, { type: 'queued', ahead }) },
        emit: (e) => this.emit(sessionId, e),
        live: (messageId, parts) => (parts ? this.live.set(sessionId, { messageId, parts }) : this.live.delete(sessionId)),
        prepare: () => this.prepareRequest(run),
        recoverOverflow: () => {
          run.threshold = Math.floor(Math.min(run.threshold, run.last?.used ?? run.threshold) * 0.8);
        },
        authorize: (call, tool) => this.authorize(session, call, tool, offered, signal),
        afterTool: (call, output) => this.afterTool(session, hooks ?? null, call, output, signal),
        onOutputCut: () => this.addContextMessage(sessionId, renderNote('notes/output-cut', {}, this.deps.promptOverrides(), [...offered])),
        onUsage: (usage) => {
          this.observeUsage(run, usage);
          this.deps.recordUsage({ model: resolved.info, sessionId, userId: session.userId, mode: session.mode, usage });
        },
      });
      let result = await turn();
      // A Stop hook can send the model back to work, a few times at most.
      for (let round = 0; turnHooks && result.stopReason === 'end' && round < MAX_STOP_ROUNDS && !signal.aborted; round++) {
        const feedback = await this.stopHooks(session, turnHooks, round > 0, signal);
        if (!feedback) break;
        await this.addContextMessage(sessionId, `Stop hook feedback: ${escapeTags(feedback)}`);
        result = await turn();
      }
      if (result.stopReason === 'error') finalStatus = 'error';
      // Errors raised after the last reply finished (the step limit, a loop) belong on that reply.
      if (result.error && result.lastAssistantId && (result.error.code === 'max_steps' || result.error.code === 'repeating')) {
        await this.deps.repo.updateMessage(result.lastAssistantId, { error: result.error });
        this.emit(sessionId, { type: 'done', messageId: result.lastAssistantId, usage: null, stopReason: 'error', error: result.error });
      }
      // The row as it is now: a title written while this turn ran counts.
      if (!this.titling.has(sessionId) && !(await this.deps.repo.getRow(sessionId))?.title) void this.generateTitle(sessionId, resolved);
      if (!session.parentSessionId && !signal.aborted) this.deps.memory?.turnEnded(session);
      if (!session.parentSessionId && !signal.aborted && result.stopReason === 'end' && (session.mode === 'code' || session.mode === 'work') && !session.temporary) {
        void this.suggestReply(sessionId, resolved);
      }
    } catch (error) {
      finalStatus = 'error';
      await this.failWithoutModel(sessionId, error);
    } finally {
      this.budgets.delete(sessionId);
      // A background sub-agent's question may still wait for the person.
      const asking = this.interactions.asking(sessionId);
      // A turn that ran to its end is news to anyone who isn't looking (cleared when they open the session).
      await this.setStatus(sessionId, asking ? 'waiting' : finalStatus, finalStatus === 'idle' && !asking && !signal.aborted);
    }
  }

  /**
   * Context notes for the person's message a run answers (docs/PROMPTS.md §7): what changed since the system prompt was
   * frozen, or since this branch was last told, joined into one hidden part in front of their message. The part also
   * records what it announced, so the facts aren't repeated (agent/context-notes.ts). A retry replaces the message's
   * earlier part with one computed against the branch before it, so a mode or model changed since then is told.
   */
  private async announce(session: SessionRow, run: RequestContext): Promise<void> {
    const all = await this.deps.repo.history(session.id);
    const latest = all.at(-1);
    // A hidden note of Atelier's own or a compaction summary has no note in front of it.
    if (!latest || latest.role !== 'user' || latest.kind !== 'normal') return;
    // The note is the one leading part without a notice of its own: a quoted passage or a loop's mark comes first when
    // there is no note, and must stay.
    const first = latest.parts[0];
    const told = first?.type === 'context' && !first.notice;
    const message = told ? { ...latest, parts: latest.parts.slice(1) } : latest;
    const history = [...all.slice(0, -1), message];
    const prior = { ...snapshotFacts(run.previous ?? run.snapshot), ...announcedState(history) };
    const row = await this.requireSession(session.id);
    const settings = this.deps.settings();
    const skills = ((await this.deps.extensions?.(session))?.skills ?? []).filter((s) => !s.disableModelInvocation);
    const context = this.contexts.get(session.id);
    const note = await turnNote(
      {
        mode: session.mode,
        date: this.date(),
        model: { ref: run.model.info.ref, name: run.model.info.displayName },
        // Only Code has a mode picker; Cowork keeps the mode it started with.
        permissionMode: session.mode === 'code' ? ((row.permissionMode as PermissionMode | null) ?? settings.permissions.defaultMode) : null,
        skills: skills.map((s) => ({ name: s.name, description: s.description })),
        connectors: connectorsOf(run.tools.map((t) => t.name)),
        tools: run.tools.map((t) => t.name),
        safeguards: run.snapshot.safeguardsHash,
        research: session.overrides.research === true && settings.capabilities.webSearch.enabled,
        contextFill: context ? context.used / context.limit : 0,
        ...(session.mode === 'code' && this.deps.gitSnapshot ? { gitSnapshot: () => this.deps.gitSnapshot!(session) } : {}),
        todos: row.todos as Todo[],
        // As this run works: a session whose Ultracode the mode or admin clamps away hears it is off, or nothing.
        ultracode: { on: run.ultracode, limits: ULTRACODE_LIMITS },
        // What a level asks of a model whose own setting can't express it (no thinking switch above High, no levels).
        effort: effortGuidance(session.effort as Effort | null, run.model.info, session.mode, this.effortOptions(session)),
      },
      prior,
      history,
      this.deps.promptOverrides(),
    );
    if (!note && !told) return;
    const parts: Part[] = [...(note ? [{ type: 'context' as const, text: note.text, ...(Object.keys(note.state).length ? { state: note.state } : {}) }] : []), ...message.parts];
    await this.deps.repo.updateMessage(message.id, { parts });
    this.emit(session.id, { type: 'message', message: { ...message, parts } });
  }

  /** Today in the backend's time zone, which is the person's on the desktop. */
  private date(): { iso: string; long: string } {
    return localDate(this.deps.now?.() ?? new Date(), this.timeZone());
  }

  private timeZone(): string {
    return this.deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** The model a session runs on: its own, else the mode's default, else the first one available. */
  private async modelRef(session: SessionRow): Promise<string | undefined> {
    // A side chat answers with the main session's model as it is now.
    const main = isSideChat(session) ? await this.deps.repo.getRow(session.parentSessionId!) : undefined;
    if (main) return this.modelRef(main);
    return session.model ?? defaultModelFor(this.deps.settings(), session.mode) ?? (await this.deps.models.firstAvailable());
  }

  /**
   * The level a session's requests use: as much of its own as the model, the mode and the admin allow (protocol
   * `effectiveEffort`). Ultracode only at the top: where it isn't allowed, a session that chose it runs at Extra.
   */
  private resolveEffort(session: SessionRow, info: ModelInfo): Effort | null {
    return effectiveEffort(session.effort as Effort | null, info, session.mode, this.effortOptions(session));
  }

  /** Ultracode only at the top, while the admin allows it. */
  private effortOptions(session: SessionRow): EffortOptions {
    return { ultracode: this.deps.settings().ultracode.enabled && !session.parentSessionId, thinking: session.overrides.thinking !== false };
  }

  /** Answers the permission prompt, question or connector request a run is waiting on; false when it is no longer waiting for that one. */
  respond(sessionId: string, interactionId: string, answer: PermissionAnswer | QuestionAnswer | ElicitationAnswer): boolean {
    const kind = this.interactions.kindOf(sessionId, interactionId);
    // A permission prompt only takes a permission answer: anything else must not read as approval.
    const fits = kind === 'permission' ? 'behavior' in answer : kind === 'question' ? 'answers' in answer : kind === 'elicitation' ? 'action' in answer : false;
    return fits && this.interactions.respond(sessionId, interactionId, answer);
  }

  /** An MCP server's request during a tool call, asked where the person is looking (a sub-agent's parent). */
  async elicit(sessionId: string, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationAnswer> {
    const session = await this.requireSession(sessionId);
    return this.interactions.ask<ElicitationAnswer>(askerOf(session), 'elicitation', request, signal, { action: 'cancel' });
  }

  /**
   * The permission pipeline (ARCHITECTURE §8): deny rules always win; then PreToolUse hooks may deny, ask,
   * allow or rewrite the input; otherwise rules and mode decide, or the person does.
   */
  private async authorize(session: SessionRow, call: ToolCallPart, tool: Tool, offered: ReadonlySet<string>, signal: AbortSignal): Promise<{ allow: true; input?: unknown } | { allow: false; message: string }> {
    const seen: { ctx?: PermissionContext } = {};
    const result = await this.decideAccess(session, call, tool, offered, signal, seen);
    // An allowed call on a file elsewhere on the machine: the runner has to be told it may go there. That includes the
    // folders the admin allowed besides the workspace (the rest of `roots`): the permission engine treats them as inside,
    // but the runner knows only the workspace's own folder until it is told.
    if (result.allow && seen.ctx && REACH_TOOLS.has(call.name) && this.deps.reach) {
      const outside = outsideRoots({ name: call.name, input: ((result.input ?? call.input) ?? {}) as Record<string, unknown> }, { ...seen.ctx, roots: seen.ctx.roots.slice(0, 1) });
      if (outside) await this.deps.reach(session, outside).catch(() => undefined);
    }
    return result;
  }

  private async decideAccess(
    session: SessionRow,
    call: ToolCallPart,
    tool: Tool,
    offered: ReadonlySet<string>,
    signal: AbortSignal,
    seen: { ctx?: PermissionContext },
  ): Promise<{ allow: true; input?: unknown } | { allow: false; message: string }> {
    // The current row: the mode can change mid-run (plan approval, the mode picker).
    const current = await this.requireSession(session.id);
    // A side chat follows its main session's mode and rules, and asks in its own pane.
    const main = isSideChat(current) ? await this.deps.repo.getRow(current.parentSessionId!) : undefined;
    const ctx = await this.deps.permissionContext?.(main ?? current);
    if (!ctx) return { allow: true };
    seen.ctx = ctx;
    // A sub-agent's questions appear in its parent's transcript, where the person is looking.
    const asker = askerOf(session);
    const subject = { name: call.name, input: (call.input ?? {}) as Record<string, unknown> };
    const rules = { ...ctx.rules, allow: [...ctx.rules.allow, ...(this.sessionRules.get(asker) ?? []), ...(main ? (this.sessionRules.get(main.id) ?? []) : [])] };
    const judge: PermissionContext = { ...ctx, rules, isReadOnly: (name) => (name === tool.name && tool.readOnly) || ctx.isReadOnly(name), offers: (name) => offered.has(name) };
    const decision = current.mode === 'chat' && SANDBOX_TOOLS.has(call.name) ? await this.sandboxDecision(current, subject) : decide(subject, judge);
    if (decision.behavior === 'deny') return { allow: false, message: refusal(decision) };

    const hooks = await this.deps.hooks?.(current);
    const pre = hooks ? await this.runHooks(current, hooks, 'PreToolUse', { tool_name: call.name, tool_input: call.input }, signal, call.name) : null;
    if (signal.aborted) return { allow: false, message: 'The response was stopped.' };
    if (pre?.block) return { allow: false, message: `A PreToolUse hook blocked this call: ${pre.block}` };
    const input = pre?.updatedInput;
    // What runs is the hook's rewrite, so the rules judge that.
    const final = input ? { name: call.name, input } : subject;
    const verdict = input ? decide(final, judge) : decision;
    if (verdict.behavior === 'deny') return { allow: false, message: refusal(verdict) };
    // A hook's "allow" skips the prompt, except for dangerous commands, which the person approves one at a time, and for a
    // call an ask rule holds back: the rule is the person's own word that this asks, in every mode.
    const askRule = verdict.behavior === 'ask' && verdict.rule !== undefined;
    if (!verdict.warning && ((pre?.permission === 'allow' && !askRule) || (pre?.permission !== 'ask' && verdict.behavior === 'allow'))) return { allow: true, ...(input ? { input } : {}) };
    // Auto mode: the reviewing model answers in the person's place; when it can't, the person is asked after all.
    let reason = verdict.reason;
    if (verdict.behavior === 'review' && pre?.permission !== 'ask') {
      const review = await this.autoReview(current, asker, final, verdict, ctx.cwd, signal);
      if (review.behavior === 'allow') return { allow: true, ...(input ? { input } : {}) };
      if (review.behavior === 'deny') return { allow: false, message: review.message };
      reason = review.reason;
    }

    const request: PermissionRequest = {
      callId: call.id,
      toolName: call.name,
      input: final.input,
      reason: pre?.permission === 'ask' ? 'A PreToolUse hook asks for your approval.' : reason,
      ...(verdict.warning ? { warning: verdict.warning } : {}),
      suggestedRule: suggestRule(final, ctx),
      ...(session.parentSessionId && !main ? { agent: current.title } : {}),
    };
    const answer = await this.interactions.ask<PermissionAnswer>(asker, 'permission', request, signal, { behavior: 'deny', message: 'The response was stopped.' });
    if (answer.behavior === 'deny') {
      return { allow: false, message: answer.message ? `The person declined and said: ${answer.message}` : 'The person declined this action. Do not retry it unchanged; ask them or take another approach.' };
    }
    // Approving resumes Auto mode after it paused.
    this.autoBlocks.delete(asker);
    // Dangerous commands are approved one call at a time.
    if (verdict.warning || !answer.remember) return { allow: true, ...(input ? { input } : {}) };
    // Every scope covers the rest of this session at once (project files are re-read only every few seconds).
    this.sessionRules.set(asker, [...(this.sessionRules.get(asker) ?? []), request.suggestedRule]);
    if (answer.remember === 'project') await this.deps.rememberProjectRule?.(session, request.suggestedRule);
    if (answer.remember === 'always' && session.userId) await this.deps.rememberRule?.(session.userId, request.suggestedRule);
    return { allow: true, ...(input ? { input } : {}) };
  }

  /**
   * Auto mode's review of one call, by the acting session's own model (no swap on a one-model server), ahead of the
   * queue. After too many blocks, or when the model can't answer, the person decides.
   */
  private async autoReview(
    session: SessionRow,
    asker: string,
    call: { name: string; input: unknown },
    decision: Decision,
    cwd: string | null,
    signal: AbortSignal,
  ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string } | { behavior: 'ask'; reason: string }> {
    const blocks = this.autoBlocks.get(asker) ?? { row: 0, total: 0 };
    if (blocks.row >= BLOCKS_IN_A_ROW || blocks.total >= BLOCKS_TOTAL) {
      return { behavior: 'ask', reason: `Auto mode paused after ${blocks.row >= BLOCKS_IN_A_ROW ? `${blocks.row} blocked actions in a row` : `${blocks.total} blocked actions`}. ${decision.reason}` };
    }
    let reply: string;
    try {
      const ref = session.model ?? (await this.requireSession(asker)).model;
      if (!ref) throw new Error('no model');
      let model = await this.deps.models.resolve(ref, session.userId);
      // Browser chat has one conversation slot, and a review through it would take the slot from the conversation (and
      // cost a message of the person's plan each time): the small model reviews, and without one the person decides.
      if (model.adapter.type === 'chatgpt-chat') {
        const other = await this.smallModel(ref);
        if (!other || other.adapter.type === 'chatgpt-chat') return { behavior: 'ask', reason: `Auto mode has no other model than ChatGPT Chat to check this action. Set a small model in Settings › Admin › Models, or pick another permission mode. ${decision.reason}` };
        model = other;
      }
      const conversation = (await this.deps.repo.branch(asker)).messages;
      const agent = session.id === asker ? undefined : (await this.deps.repo.branch(session.id)).messages;
      reply = await collectText(model, {
        system: [{ text: render(template('auto-mode', this.deps.promptOverrides()), { leniency: reviewLeniency(model.adapter.type) }) }],
        user: reviewInput({ conversation, agent, call, reason: decision.reason, cwd }),
        maxOutputTokens: 400,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
        queue: { priority: 'urgent', timeoutMs: 90_000 },
      });
    } catch (error) {
      if (signal.aborted) return { behavior: 'deny', message: 'The response was stopped.' };
      return { behavior: 'ask', reason: `Auto mode couldn't check this action (${error instanceof Error ? error.message : String(error)}). ${decision.reason}` };
    }
    const verdict = parseVerdict(reply);
    if (!verdict) return { behavior: 'ask', reason: `Auto mode couldn't read its reviewer's answer. ${decision.reason}` };
    if (verdict.decision === 'allow') {
      this.autoBlocks.set(asker, { ...blocks, row: 0 });
      return { behavior: 'allow' };
    }
    // Probably wanted but not settled by the person's messages: they decide, and it isn't held against the agent.
    if (verdict.decision === 'ask') return { behavior: 'ask', reason: `Auto mode wants your OK${verdict.reason ? `: ${verdict.reason}` : '.'} ${decision.reason}` };
    this.autoBlocks.set(asker, { row: blocks.row + 1, total: blocks.total + 1 });
    return {
      behavior: 'deny',
      message: `Auto mode blocked this action: ${verdict.reason} Don't reach the same result another way. Take a safer approach, or tell the person what you need and why so they can do it or allow it.`,
    };
  }

  /** After each tool call: PostToolUse hook feedback and context, and a nudge when the task list has gone stale. */
  private async afterTool(session: SessionRow, hooks: SessionHooks | null, call: ToolCallPart, output: ToolOutput, signal: AbortSignal): Promise<ToolOutput> {
    const notes: string[] = [];
    if (hooks) {
      const response = output.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      const post = await this.runHooks(session, hooks, 'PostToolUse', { tool_name: call.name, tool_input: call.input, tool_response: response }, signal, call.name);
      notes.push(...[post.block && `PostToolUse hook feedback: ${post.block}`, post.context].filter((n): n is string => !!n).map(escapeTags));
    }
    const updates = [output.isError ? null : await this.nestedInstructions(session, call), await this.todoNudge(session, call)].filter((n): n is string => !!n);
    if (updates.length) notes.push(`<context-update>\n${updates.join('\n\n')}\n</context-update>`);
    return notes.length ? { ...output, content: [...output.content, { type: 'text', text: notes.join('\n') }] } : output;
  }

  /**
   * Code and Cowork: the first time a file tool works below a folder with its own ATELIER.md, AGENTS.md or CLAUDE.md, that file joins
   * the result (docs/PROMPTS.md §1.5). Whether a branch was told is read back from its tool results.
   */
  private async nestedInstructions(session: SessionRow, call: ToolCallPart): Promise<string | null> {
    const path = (call.input as { file_path?: unknown } | null)?.file_path;
    if (session.mode === 'chat' || !FILE_TOOLS.has(call.name) || typeof path !== 'string') return null;
    const workspace = await this.deps.workspace?.(session);
    // A workspace the person hasn't trusted brings no instruction files of its own.
    if (!workspace || !isTrusted(workspace)) return null;
    const { root, pathSep: sep } = workspace;
    // The runner's own platform decides how its paths compare (a Windows laptop can lend its folders to a Linux server).
    const ops = pathOps(sep === '\\' ? 'win32' : 'posix');
    const abs = path.startsWith(sep) || /^[A-Za-z]:/.test(path) ? path : `${root}${sep}${path}`;
    const folders = ops.relative(abs, root)?.split('/').slice(0, -1) ?? [];
    if (!folders.length || folders.some((f) => NOT_INSTRUCTIONS.has(f))) return null;
    const dir = `${root}${sep}${folders.join(sep)}`;
    const cache = this.nested.get(session.id) ?? new Map<string, { path: string; content: string }[]>();
    this.nested.set(session.id, cache);
    let files = cache.get(dir);
    if (!files) {
      const names = instructionNames(this.deps.settings().compat.claudeCode).filter((n) => !n.startsWith('.claude/'));
      const found = await readAncestors((list) => workspace.runner.call('fs.readAncestors', { from: dir, names: list }).then((r) => r.files), names);
      // Below the root only: the root's own files are in the system prompt.
      files = found.filter((f) => ops.relative(f.path, root)?.includes('/'));
      cache.set(dir, files);
    }
    if (!files.length) return null;
    const told = (await this.deps.repo.history(session.id)).flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool_result' ? p.content.map((c) => (c.type === 'text' ? c.text : '')) : []))).join('\n');
    // A folder's name is the repository's: it can't close the attribute or forge a tag.
    const notes = files
      .filter((f) => !told.includes(`<instructions source="${escapeAttr(f.path)}" kind="nested">`))
      .map((f) =>
        renderNote(
          'notes/instructions-nested',
          { dir: escapeTags(f.path.slice(root.length + 1, f.path.lastIndexOf(sep))), path: escapeAttr(f.path), content: escapeTags(f.content.slice(0, NESTED_CHARS).trim()) },
          this.deps.promptOverrides(),
        ),
      );
    return notes.length ? notes.join('\n\n') : null;
  }

  /** Code and Cowork: after ten tool calls without a TodoWrite, a reminder of the open items on the list. */
  private async todoNudge(session: SessionRow, call: ToolCallPart): Promise<string | null> {
    if (session.mode === 'chat' || session.parentSessionId) return null;
    const since = call.name === 'TodoWrite' ? 0 : (this.sinceTodo.get(session.id) ?? 0) + 1;
    this.sinceTodo.set(session.id, since % TODO_NUDGE_CALLS);
    if (since < TODO_NUDGE_CALLS) return null;
    return todoNudge((await this.requireSession(session.id)).todos as Todo[], this.deps.promptOverrides());
  }

  /**
   * SessionStart (a session's first turn) and UserPromptSubmit (a message just sent): their context joins the
   * person's message as a hidden part; a block ends the turn before the model sees it. False when blocked.
   */
  private async beforeTurn(session: SessionRow, hooks: SessionHooks, submitted: boolean, signal: AbortSignal): Promise<boolean> {
    const message = session.headMessageId ? await this.deps.repo.getMessage(session.headMessageId) : undefined;
    if (!message || message.role !== 'user') return true;
    const context: string[] = [];
    if (!session.systemSnapshot) {
      const start = await this.runHooks(session, hooks, 'SessionStart', { source: 'startup' }, signal);
      if (start.context) context.push(start.context);
    }
    if (submitted) {
      const prompt = await this.runHooks(session, hooks, 'UserPromptSubmit', { prompt: messageText(message.parts) }, signal);
      const blocked = prompt.block ?? prompt.stop;
      if (blocked) {
        await this.failTurn(session.id, { code: 'hook_blocked', message: `A UserPromptSubmit hook blocked this message: ${blocked}`, retryable: false });
        return false;
      }
      if (prompt.context) context.push(prompt.context);
    }
    if (context.length) {
      const updated = { ...message, parts: [...message.parts, { type: 'context' as const, text: escapeTags(context.join('\n')) }] };
      await this.deps.repo.updateMessage(message.id, { parts: updated.parts });
      this.emit(session.id, { type: 'message', message: updated });
    }
    return true;
  }

  /** Stop: a block's reason, which sends the model back to work; null to let the turn end. */
  private async stopHooks(session: SessionRow, hooks: SessionHooks, active: boolean, signal: AbortSignal): Promise<string | null> {
    const stop = await this.runHooks(session, hooks, 'Stop', { stop_hook_active: active }, signal);
    return stop.block ?? null;
  }

  private async runHooks(session: SessionRow, hooks: SessionHooks, event: HookEvent, fields: Partial<HookInput>, signal: AbortSignal, toolName?: string): Promise<HookOutcome> {
    const commands = hooksFor(hooks.configs, event, toolName);
    if (!commands.length) return { errors: [] };
    const mode = (await this.requireSession(session.id)).permissionMode ?? this.deps.settings().permissions.defaultMode;
    const outcome = await runHooks(hooks.workspace, commands, { session_id: session.id, cwd: hooks.workspace.root, hook_event_name: event, permission_mode: mode, ...fields }, signal);
    for (const error of outcome.errors) this.deps.hookError?.(session.id, error);
    return outcome;
  }

  /**
   * Background sub-agents that ended since the session's last model request join the conversation, each as a hidden
   * note of its own, so the model reads them before its next step. Each is removed once it is stored: none is lost or
   * told twice.
   */
  private async deliverNotices(sessionId: string): Promise<void> {
    const pending = this.notices.get(sessionId);
    while (pending?.length) {
      const { part, depth } = pending[0]!;
      await this.addContextMessage(sessionId, part);
      if (depth && this.wakeTurns.has(sessionId)) this.chains.set(sessionId, Math.max(this.chains.get(sessionId) ?? 0, depth));
      pending.shift();
    }
    if (pending) this.notices.delete(sessionId);
  }

  /**
   * A background sub-agent ended: its parent hears how, with its result, at its next model request; an idle parent
   * starts a turn for it, unless the person stopped the sub-agent.
   */
  private noteEnded(parentId: string, task: { taskId: string; title: string; sessionId: string }, output: ToolOutput): void {
    const status = agentStatus(output);
    const result = output.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    const outcome = status === 'stopped' && this.closing ? STOPPED_BY_RESTART : AGENT_OUTCOMES[status];
    const text = renderNote('notes/background-agent', { title: escapeTags(task.title), outcome, result: escapeTags(result) }, this.deps.promptOverrides());
    const pending = this.notices.get(parentId) ?? [];
    pending.push({ part: { type: 'context', text, notice: { kind: 'agent', ...task, status } }, wake: status !== 'stopped' });
    this.notices.set(parentId, pending);
    this.wake(parentId);
  }

  /**
   * SendMessage (ARCHITECTURE §8, "Messages between sessions"): a note for another of the person's top-level Code or
   * Cowork sessions, for one of the sender's running sub-agents, or from a sub-agent for its parent. A running receiver
   * reads it before its next step; an idle top-level one starts a turn for it, as for a background sub-agent's end,
   * unless MAX_MESSAGE_CHAIN message-started turns already led here or it has woken MAX_WAKES times without the person.
   */
  private async sendSessionMessage(fromId: string, to: string, message: string): Promise<ToolOutput> {
    const fail = (text: string): ToolOutput => ({ content: [{ type: 'text', text }], isError: true });
    const from = await this.requireSession(fromId);
    const id = to.startsWith('agent:') ? to.slice('agent:'.length) : to;
    const unknown = `There is no session or sub-agent "${to}" you can message.${from.parentSessionId ? '' : " ListSessions lists the person's sessions; a sub-agent is named by the task id the Agent tool returned."}`;
    let target: SessionRow | undefined;
    // Who the receiver hears it from: another session, its parent, or one of its sub-agents.
    let relation: 'session' | 'parent' | 'sub-agent';
    if (from.parentSessionId) {
      if (to !== 'parent' && id !== from.parentSessionId) return fail('A sub-agent can message only its parent session: set `to` to "parent".');
      target = await this.deps.repo.getRow(from.parentSessionId);
      relation = 'sub-agent';
    } else {
      if (to === 'parent') return fail('This session has no parent session: it was started by the person.');
      if (id === from.id) return fail("That is this session's own id: a session can't message itself.");
      target = await this.deps.repo.getRow(id);
      // Another person's session reads as unknown: its existence isn't the sender's to learn.
      if (target && (target.userId !== from.userId || (target.parentSessionId && target.parentSessionId !== from.id))) target = undefined;
      relation = target?.parentSessionId ? 'parent' : 'session';
    }
    if (!target) return fail(unknown);
    const title = (row: SessionRow) => row.title || 'Untitled';
    if (target.mode === 'chat') return fail(`"${title(target)}" is a Chat conversation, which can't receive messages; Code sessions and Cowork tasks can.`);
    const sent =
      relation === 'session' ? `Sent to the session "${title(target)}" (id ${target.id}).` : relation === 'parent' ? `Sent to the sub-agent "${title(target)}" (task agent:${target.id}).` : `Sent to your parent session "${title(target)}" (id ${target.id}).`;
    if (this.closing || this.discarding.has(target.id)) return fail(`"${title(target)}" can't receive messages right now: it is closing.`);
    if (relation === 'parent' && !this.agentStops.has(target.id)) {
      return fail(`The sub-agent "${title(target)}" has ended, so it can't receive messages. Its result reached you, or arrives, as a note; start a new sub-agent for more work.`);
    }

    const depth = (this.chains.get(from.id) ?? 0) + 1;
    const running = this.runs.has(target.id);
    // Sub-agents never start turns of their own: one that hasn't made its first request yet reads it at that request.
    const held = relation === 'parent' || running ? null : depth > MAX_MESSAGE_CHAIN ? 'chain' : (this.wakes.get(target.id) ?? 0) >= MAX_WAKES ? 'wakes' : null;
    const heldNote = {
      chain: `It waited for the person: ${MAX_MESSAGE_CHAIN} turns in a row had been started by messages between sessions with nobody in between, so Atelier started no turn for it.`,
      wakes: `It waited for the person: this conversation had already started ${MAX_WAKES} turns in a row by itself.`,
    };
    const replyable = await this.offersSendMessage(target);
    const text = renderNote(
      'notes/session-message',
      {
        from: { session: "another of the person's sessions", parent: 'your parent session', 'sub-agent': 'your sub-agent' }[relation],
        title: escapeTags(title(from)),
        where: relation === 'sub-agent' ? `task agent:${from.id}` : `id ${from.id}`,
        held: held ? heldNote[held] : '',
        reply: !replyable ? '' : relation === 'parent' ? 'parent' : relation === 'sub-agent' ? `agent:${from.id}` : from.id,
        message: escapeTags(message),
      },
      this.deps.promptOverrides(),
    );
    const notice = { kind: 'message' as const, from: { sessionId: from.id, title: title(from), relation, mode: from.mode, ...(relation === 'sub-agent' ? { taskId: `agent:${from.id}` } : {}) }, text: message };
    const pending = this.notices.get(target.id) ?? [];
    pending.push({ part: { type: 'context', text, notice }, wake: relation !== 'parent' && !held, depth });
    this.notices.set(target.id, pending);
    this.wake(target.id);

    const answer = ' An answer, if one comes, arrives here as a note.';
    if (running) {
      const waiting = relation === 'sub-agent' && this.tasks.list(target.id).some((t) => t.id === `agent:${from.id}` && !t.background);
      if (waiting) return { content: [{ type: 'text', text: `${sent} Your parent is waiting for your report, so it reads this only after you finish: put what it needs in your report too.` }] };
      return { content: [{ type: 'text', text: `${sent} It is working and reads your message before its next step.${answer}` }] };
    }
    if (relation === 'parent') return { content: [{ type: 'text', text: `${sent} It reads your message before its next step.${answer}` }] };
    if (this.runs.has(target.id)) return { content: [{ type: 'text', text: `${sent} It was idle and has started a turn to read it.${answer}` }] };
    if (this.interactions.asking(target.id)) return { content: [{ type: 'text', text: `${sent} A question there waits for the person; it reads your message once they have answered.${answer}` }] };
    if (!held) return { content: [{ type: 'text', text: `${sent} It reads your message at its next turn.${answer}` }] };
    const why = held === 'chain' ? `${MAX_MESSAGE_CHAIN} turns in a row were already started by messages between sessions with nobody in between` : `it has already started ${MAX_WAKES} turns in a row by itself`;
    return { content: [{ type: 'text', text: `${sent} It is idle and wasn't started for it, as ${why}: it reads your message when the person next writes there. Tell the person if it matters.` }] };
  }

  /** Whether a session has SendMessage, so a note to it can say how to answer: compact-tier models and some defined sub-agents don't. */
  private async offersSendMessage(row: SessionRow): Promise<boolean> {
    const ref = await this.modelRef(row);
    const model = ref ? await this.deps.models.resolve(ref, row.userId).catch(() => null) : null;
    if (model && (model.info.tier === 'compact' || model.info.capabilities.tools === 'none')) return false;
    if (!row.parentSessionId || typeof row.overrides.agent !== 'string') return true;
    const def = (await this.deps.extensions?.(row))?.agents.find((a) => a.name === row.overrides.agent);
    return !def || ((!def.tools || def.tools.includes('SendMessage')) && !def.disallowedTools.includes('SendMessage'));
  }

  /** ListSessions: the person's other top-level Code sessions and Cowork tasks, most recent first. */
  private async sessionsFor(sessionId: string, query: string | null): Promise<SessionListing[]> {
    const from = await this.requireSession(sessionId);
    const found = await this.deps.repo.list({ ...(from.userId ? { userId: from.userId } : {}), ...(query ? { query } : {}), limit: LIST_SESSIONS_MAX * 3 });
    const folders = new Map(from.userId ? ((await this.deps.folders?.(from.userId).catch(() => [])) ?? []).map((f) => [f.id, f.name]) : []);
    const out: SessionListing[] = [];
    for (const s of [...found].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (out.length >= LIST_SESSIONS_MAX) break;
      if (s.id === from.id || s.mode === 'chat') continue;
      // Without an owner the list isn't filtered by one: check each row's.
      if (!from.userId && (await this.deps.repo.getRow(s.id))?.userId !== null) continue;
      out.push({ id: s.id, title: s.title, mode: s.mode, status: s.status, folder: (s.workspaceId && folders.get(s.workspaceId)) || null, updatedAt: s.updatedAt });
    }
    return out;
  }

  /** A hidden note to the model on the person's side of the conversation. */
  private async addContextMessage(sessionId: string, note: string | ContextPart): Promise<void> {
    const session = await this.requireSession(sessionId);
    const message = await this.deps.repo.insertMessage({
      id: newId(),
      sessionId,
      parentId: session.headMessageId,
      role: 'user',
      parts: [typeof note === 'string' ? { type: 'context', text: note } : note],
      model: null,
      usage: null,
      stopReason: null,
      error: null,
      kind: 'context',
      summarizesThroughId: null,
    });
    this.emit(sessionId, { type: 'message', message });
  }

  private async setStatus(sessionId: string, status: SessionSummary['status'], finished = false): Promise<void> {
    await this.deps.repo.patchQuietly(sessionId, { status, seq: this.seqs.get(sessionId) ?? 0, ...(finished ? { finishedUnseenAt: Date.now() } : {}) });
    this.emit(sessionId, { type: 'status', status });
    const summary = await this.deps.repo.get(sessionId);
    if (summary) this.deps.sessionChanged(summary);
  }

  private async requireSession(sessionId: string) {
    const row = await this.deps.repo.getRow(sessionId);
    if (!row) throw new Error('Session not found');
    return row;
  }

  private async failWithoutModel(sessionId: string, error: unknown): Promise<void> {
    if (error instanceof ContextLoopError) {
      await this.failTurn(sessionId, { code: 'context_loop', message: error.message, fix: 'settings/models', retryable: false });
      return;
    }
    await this.failTurn(sessionId, {
      code: error instanceof ModelUnavailableError ? 'no_model' : 'internal',
      message: error instanceof Error ? error.message : 'Something went wrong',
      fix: error instanceof ModelUnavailableError ? error.fix : undefined,
      retryable: !(error instanceof ModelUnavailableError),
    });
  }

  /** Ends the turn with an error reply in place of the model's. */
  private async failTurn(sessionId: string, error: MessageError): Promise<void> {
    const session = await this.deps.repo.getRow(sessionId);
    const message = await this.deps.repo.insertMessage({
      id: newId(),
      sessionId,
      parentId: session?.headMessageId ?? null,
      role: 'assistant',
      parts: [],
      model: null,
      usage: null,
      stopReason: 'error',
      error,
      kind: 'normal',
      summarizesThroughId: null,
    });
    this.emit(sessionId, { type: 'message', message });
    this.emit(sessionId, { type: 'done', messageId: message.id, usage: null, stopReason: 'error', error: message.error });
  }

  private async toolsFor(session: SessionRow): Promise<Tool[]> {
    const { webSearch, webFetch } = this.deps.settings().capabilities;
    const web = [...(webSearch.enabled ? [this.webSearch] : []), ...(webFetch ? [this.webFetch] : [])];
    const catalog = await this.deps.extensions?.(session);
    const skills = catalog?.skills.some((s) => !s.disableModelInvocation) ? [this.skill] : [];
    const mcp = (await this.deps.mcpTools?.(session)) ?? [];
    // Adding a connector asks the person, which a sub-agent can't.
    const connect = this.deps.addConnector && !session.parentSessionId ? [this.addConnector] : [];
    const memory = this.deps.memory?.tools(session, await this.memoryAccess(session)) ?? [];
    const inlineVisual = !session.parentSessionId && (session.mode === 'chat' || session.mode === 'work') ? [createInlineVisualTool()] : [];
    // The clock for everyone; the usage figures only where the model's provider has limits or a cost, and not for sub-agents.
    const modelRef = session.parentSessionId ? undefined : await this.modelRef(session);
    const usage = modelRef && this.deps.usage?.offered(modelRef) ? [this.usage] : [];
    if (session.mode === 'chat') return [createArtifactTool(this.deps.artifacts), ...inlineVisual, ...this.sandboxTools(session), this.time, ...usage, ...skills, ...web, ...connect, ...memory, ...mcp];
    const workspace = await this.deps.workspace?.(session);
    let code: Tool[] = [];
    if (workspace) {
      const checkpoints = this.deps.checkpoints;
      // A sub-agent's background commands are listed with its parent's.
      const background: BackgroundCommands = {
        started: (ctx, command) => void this.topLevel(ctx.sessionId).then((id) => this.tasks.addCommand(id, workspace, command)),
        killed: (ctx, execId) => void this.topLevel(ctx.sessionId).then((id) => this.tasks.commandKilled(id, execId)),
      };
      code =
        this.codeTools.get(workspace) ??
        createCodeTools(workspace, { blobs: this.deps.blobs, background, ...(checkpoints ? { checkpoint: (ctx, path) => checkpoints.capture(workspace, ctx.sessionId, path) } : {}) });
      this.codeTools.set(workspace, code);
    }
    // Sub-agents can't ask the person anything and don't delegate further; a defined one keeps to its tool list.
    if (session.parentSessionId) {
      const def = catalog?.agents.find((a) => a.name === session.overrides.agent);
      const tools = [...code, this.todoWrite, this.sendToParent, this.time, ...skills, ...web, ...mcp];
      return def ? tools.filter((t) => (!def.tools || def.tools.includes(t.name)) && !def.disallowedTools.includes(t.name)) : tools;
    }
    const agent = createAgentTool((parentId, call, task, signal) => this.delegate(parentId, call, task, signal), catalog?.agents ?? []);
    // Code shows a file it wrote in the Artifact pane, read through the same workspace.
    const artifact = session.mode === 'code' && workspace ? [createArtifactTool(this.deps.artifacts, workspace)] : [];
    const stopTasks = workspace ? [this.taskStop] : [];
    // Folders on this computer or an SSH host only: a codespace is one repository, a lent folder belongs to its computer.
    const movable = workspace && this.deps.moveWorkspace && (workspace.kind === undefined || workspace.kind === 'ssh' || (workspace.kind === 'local' && !workspace.deviceId));
    const moveSession = movable ? [this.changeDirectory] : [];
    return [...code, this.todoWrite, this.askUser, agent, this.sendMessage, this.listSessions, this.time, ...usage, ...stopTasks, ...moveSession, ...skills, ...(session.mode === 'code' ? [this.exitPlanMode] : []), ...artifact, ...inlineVisual, ...web, ...connect, ...memory, ...mcp];
  }

  /** What memory a session gets (memory/access.ts `memoryFor`); none without the memory service. */
  private async memoryAccess(session: SessionRow): Promise<MemoryAccess> {
    return (await this.deps.memory?.access(session).catch(() => NO_MEMORY)) ?? NO_MEMORY;
  }

  /** The chat sandbox's fixed rules for one call (permissions/engine.ts `sandboxDecide`), against its folder. */
  private async sandboxDecision(session: SessionRow, call: { name: string; input: Record<string, unknown> }): Promise<Decision> {
    try {
      const workspace = await this.deps.chatSandbox!(session);
      const flavor = workspace.pathSep === '\\' ? 'win32' : 'posix';
      return sandboxDecide(call, { root: workspace.root, home: workspace.home, confined: workspace.sandbox?.confined ?? false, flavor });
    } catch (error) {
      return { behavior: 'deny', reason: `The sandbox isn't available: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * A chat's Bash and Read, run in its sandbox. The sandbox (a folder, and on a server a runner in the sandbox container)
   * is only made when the model first uses one, so a chat that never needs it costs nothing.
   */
  private sandboxTools(session: SessionRow): Tool[] {
    const { chatSandbox } = this.deps;
    if (!chatSandbox || !this.deps.chatSandboxAvailable?.(session)) return [];
    // Descriptions and schemas don't depend on the workspace; running does, and gets the real one.
    const templates = createCodeTools({ id: '', deviceId: null, host: null, root: '', pathSep: '/' } as unknown as Workspace).filter((t) => SANDBOX_TOOLS.has(t.name));
    return templates.map((template) => ({
      ...template,
      // Background commands need BashOutput and KillShell, which a chat doesn't have.
      inputSchema: withoutProperty(template.inputSchema, 'run_in_background'),
      run: async (input, ctx) => {
        const workspace = await chatSandbox(await this.requireSession(session.id));
        let tools = this.codeTools.get(workspace);
        if (!tools) this.codeTools.set(workspace, (tools = createCodeTools(workspace, { blobs: this.deps.blobs })));
        return tools.find((t) => t.name === template.name)!.run(input, ctx);
      },
    }));
  }

  /** A defined sub-agent's `maxTurns`, if it sets one. */
  private async definedAgentTurns(row: SessionRow): Promise<number | null> {
    if (!row.parentSessionId || typeof row.overrides.agent !== 'string') return null;
    return (await this.deps.extensions?.(row))?.agents.find((a) => a.name === row.overrides.agent)?.maxTurns ?? null;
  }

  /** A defined sub-agent's own prompt for its child session. */
  private async definedAgentPrompt(row: SessionRow): Promise<{ agentPrompt?: string }> {
    if (!row.parentSessionId || typeof row.overrides.agent !== 'string') return {};
    const catalog = await this.deps.extensions?.(row);
    const def = catalog?.agents.find((a) => a.name === row.overrides.agent);
    const text = def && (await catalog!.read(def));
    return text ? { agentPrompt: agentPrompt(text) } : {};
  }

  /** A skill's instructions, with its files made reachable for the session's tools where they can be. */
  private async loadSkill(session: SessionRow, catalog: ExtensionCatalog, skill: Skill, args: string): Promise<string> {
    const text = await catalog.read(skill);
    if (text === null) throw new Error(`The skill "${skill.name}" can't be read anymore.`);
    await catalog.reach?.(skill);
    return renderSkill(skill, text, args, { projectDir: catalog.projectDir, sessionId: session.id });
  }

  /** `/name args` from the person starts a skill or a command: its text joins their message as a hidden part. */
  private async expandSlash(session: SessionRow): Promise<void> {
    const message = session.headMessageId ? await this.deps.repo.getMessage(session.headMessageId) : undefined;
    const slash = message?.role === 'user' ? /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(messageText(message.parts).trim()) : null;
    if (!message || !slash) return;
    const [, name, args = ''] = slash;
    const catalog = await this.deps.extensions?.(session);
    if (!catalog) return;
    const skill = catalog.skills.find((s) => s.name === name && s.userInvocable);
    const command = skill ? undefined : catalog.commands.find((c) => c.name === name);
    let text: string | null = null;
    if (skill) text = await this.loadSkill(session, catalog, skill, args).catch(() => null);
    else if (command) text = await catalog.read(command).then((t) => (t === null ? null : renderCommand(t, args, command.pluginRoot)), () => null);
    if (text === null) return;
    const tag = skill ? 'skill' : 'command';
    const parts = [...message.parts, { type: 'context' as const, text: `<${tag} name="${name}">\n${escapeTags(text)}\n</${tag}>` }];
    await this.deps.repo.updateMessage(message.id, { parts });
    this.emit(session.id, { type: 'message', message: { ...message, parts } });
  }

  /**
   * Runs a sub-agent as a child session (same workspace, model and permission mode) and returns its final report. In
   * an Ultracode turn each one counts against the turn's budget, and past it the call fails. One started in the
   * background returns at once; its parent hears how it ended later (`noteEnded`), and only its own stop or its
   * parent's Stop end it early. Outside Ultracode a session has MAX_BACKGROUND_AGENTS working at most: past them the
   * call fails.
   */
  private async delegate(parentId: string, call: { messageId: string; callId: string }, task: Delegation, signal: AbortSignal): Promise<ToolOutput> {
    // Counted before anything is awaited: the Agent calls of one message start together.
    const budget = this.budgets.get(parentId);
    if (budget && budget.subagents >= ULTRACODE_MAX_SUBAGENTS) return { content: [{ type: 'text', text: SUBAGENT_BUDGET_SPENT }], isError: true };
    // Outside Ultracode's budget, a background one holds one of the session's places from now until its end is noted.
    const working = this.backgroundPlaces.get(parentId) ?? 0;
    if (task.background && !budget && working >= MAX_BACKGROUND_AGENTS) return { content: [{ type: 'text', text: BACKGROUND_AGENTS_BUSY }], isError: true };
    if (budget) budget.subagents++;
    if (task.background) this.backgroundPlaces.set(parentId, working + 1);
    // A sub-agent that never starts gives its places back.
    const unstarted = (output: ToolOutput): ToolOutput => {
      if (budget) budget.subagents--;
      if (task.background) this.leaveBackground(parentId);
      return output;
    };
    let parent: SessionRow;
    let child: SessionSummary;
    try {
      parent = await this.requireSession(parentId);
      const def = task.subagentType === GENERAL_PURPOSE ? null : (await this.deps.extensions?.(parent))?.agents.find((a) => a.name === task.subagentType);
      if (def === undefined) return unstarted({ content: [{ type: 'text', text: `There is no sub-agent type "${task.subagentType}"; use one from the Agent tool's list.` }], isError: true });
      const wanted = def ? agentModel(def, this.deps.settings().models.aliases, parent.model) : parent.model;
      child = await this.deps.repo.create({
        mode: parent.mode,
        userId: parent.userId,
        projectId: parent.projectId,
        workspaceId: parent.workspaceId,
        model: wanted && parent.model ? this.helperModel(wanted, parent.model) : wanted,
        // Under Ultracode, sub-agents work at the level it sends and don't orchestrate themselves.
        effort: parent.effort === 'ultracode' ? ULTRACODE_LEVEL : parent.effort,
        permissionMode: parent.permissionMode,
        parentSessionId: parent.id,
        title: task.description,
        overrides: { thinking: parent.overrides.thinking !== false, originClient: parent.overrides.originClient, remoteControl: parent.overrides.remoteControl !== false, ...(def ? { agent: def.name } : {}) },
      });
      await this.linkChild(call.messageId, call.callId, child.id);
    } catch (error) {
      unstarted(SUBAGENT_STOPPED);
      throw error;
    }
    // Listed in the Background tasks pane until it reports (Stop there stops its run).
    const taskId = this.tasks.addAgent(parent.id, { childSessionId: child.id, description: task.description, background: task.background });
    const own = new AbortController();
    this.agentStops.set(child.id, own);
    const finished = async (): Promise<ToolOutput> => {
      try {
        // In the background the turn that started it may be long over: it doesn't stop with that turn's signal.
        const output = await this.runChild(child, task.prompt, task.background ? own.signal : AbortSignal.any([signal, own.signal]), budget, this.chains.get(parent.id) ?? 0);
        this.tasks.endAgent(parent.id, taskId, agentStatus(output));
        return withUnread(output, this.takeUnread(child.id));
      } finally {
        this.agentStops.delete(child.id);
        this.notices.delete(child.id);
      }
    };
    if (!task.background) return finished();

    const agents = this.backgroundAgents.get(parent.id) ?? new Map<string, Promise<void>>();
    this.backgroundAgents.set(parent.id, agents);
    const ended = finished()
      .catch((error: unknown): ToolOutput => {
        this.tasks.endAgent(parent.id, taskId, 'failed');
        return { content: [{ type: 'text', text: `The sub-agent failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      })
      .then((output) => this.noteEnded(parent.id, { taskId, title: task.description, sessionId: child.id }, output))
      .catch(() => undefined)
      .finally(() => {
        this.leaveBackground(parent.id);
        agents.delete(child.id);
        if (!agents.size && this.backgroundAgents.get(parent.id) === agents) this.backgroundAgents.delete(parent.id);
      });
    agents.set(child.id, ended);
    return { content: [{ type: 'text', text: startedInBackground(task.description, taskId) }] };
  }

  /** Messages a sub-agent got after its last request (during its final reply): it never read them. */
  private takeUnread(childId: string): string[] {
    const pending = this.notices.get(childId) ?? [];
    this.notices.delete(childId);
    return pending.flatMap((n) => (n.part.notice?.kind === 'message' ? [n.part.notice.text] : []));
  }

  /** A background sub-agent's end was noted (or it never started): its place is free. */
  private leaveBackground(parentId: string): void {
    const left = (this.backgroundPlaces.get(parentId) ?? 1) - 1;
    if (left > 0) this.backgroundPlaces.set(parentId, left);
    else this.backgroundPlaces.delete(parentId);
  }

  /**
   * Runs a sub-agent's one turn and returns its report, or SUBAGENT_STOPPED. `signal` stops it: its parent's stop, or its
   * own. A sub-agent stopped (or never started) before its turn came gives its place back without running.
   */
  private async runChild(child: SessionSummary, prompt: string, signal: AbortSignal, budget: { subagents: number } | undefined, chain = 0): Promise<ToolOutput> {
    const unstarted = () => {
      if (budget) budget.subagents--;
      return SUBAGENT_STOPPED;
    };
    // As many sub-agents work at once as their model's server answers requests; the rest wait their turn here,
    // so a one-slot server finishes one sub-agent (with its prompt cache warm) before the next (providers/scheduler.ts).
    const ref = child.model ?? defaultModelFor(this.deps.settings(), child.mode);
    let release = () => {};
    try {
      if (ref && this.deps.models.agentTurn) release = await this.deps.models.agentTurn(ref, signal, (ahead) => this.emit(child.id, { type: 'queued', ahead }), (await this.deps.repo.getRow(child.id))?.userId);
    } catch {
      return unstarted();
    }
    if (signal.aborted) {
      release();
      return unstarted();
    }
    const stop = () => void this.stop(child.id);
    signal.addEventListener('abort', stop, { once: true });
    // The sub-agent spends from the same budget: the whole tree counts.
    if (budget) this.budgets.set(child.id, budget);
    try {
      await this.send(child.id, [{ type: 'text', text: prompt }]);
      // Its messages to the parent continue the chain of the turn that started it.
      this.chains.set(child.id, chain);
      await this.settle(child.id);
    } finally {
      // Messages that came during its last reply stay for `takeUnread`, which hands them back with the report.
      this.chains.delete(child.id);
      signal.removeEventListener('abort', stop);
      this.budgets.delete(child.id);
      // A sub-agent runs once: the instruction files its tools found are no longer needed.
      this.nested.delete(child.id);
      release();
    }
    const { messages } = await this.deps.repo.branch(child.id);
    const last = messages.at(-1);
    if (signal.aborted || last?.stopReason === 'aborted') return SUBAGENT_STOPPED;
    const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').trim();
    // At its step cap the run ends after a tool round, with the error on its last reply: what it wrote last is all there is.
    if (messages.findLast((m) => m.role === 'assistant')?.error?.code === 'max_steps') {
      const said = messages.filter((m) => m.role === 'assistant').map(textOf).findLast(Boolean);
      return { content: [{ type: 'text', text: said ? `${STEP_LIMIT_REACHED} Its last message:\n\n${said}` : STEP_LIMIT_REACHED }], isError: true };
    }
    if (last?.error) return { content: [{ type: 'text', text: `The sub-agent failed: ${last.error.message}` }], isError: true };
    const report = last?.role === 'assistant' ? textOf(last) : '';
    return { content: [{ type: 'text', text: report || 'The sub-agent finished without a report.' }] };
  }

  /**
   * Points the parent's tool call at its child session, so the transcript can follow the sub-agent. The parallel Agent
   * calls of one message link one after another: each rewrites the message, and would otherwise undo the others' links.
   */
  private async linkChild(messageId: string, callId: string, childSessionId: string): Promise<void> {
    const before = this.linking.get(messageId);
    const linked = (async () => {
      await before;
      const message = await this.deps.repo.getMessage(messageId);
      const index = message?.parts.findIndex((p) => p.type === 'tool_call' && p.id === callId) ?? -1;
      if (!message || index < 0) return;
      const part = { ...(message.parts[index] as ToolCallPart), childSessionId };
      const parts = message.parts.map((p, i) => (i === index ? part : p));
      await this.deps.repo.updateMessage(messageId, { parts });
      this.emit(message.sessionId, { type: 'part', messageId, index, part });
    })();
    const done = linked.catch(() => undefined);
    this.linking.set(messageId, done);
    try {
      await linked;
    } finally {
      if (this.linking.get(messageId) === done) this.linking.delete(messageId);
    }
  }

  /**
   * WebFetch's `prompt`, answered by the small model (or the conversation's, when the small one would make their
   * server swap models); null when none is set so the main model reads the page.
   */
  private async answerFromPage(content: string, prompt: string, sessionId: string, signal: AbortSignal): Promise<string | null> {
    const session = await this.requireSession(sessionId);
    const model = await this.smallModel(session.model);
    if (!model) return null;
    return collectText(model, {
      system: [{ text: template('web-fetch', this.deps.promptOverrides()) }],
      user: `<page>\n${escapeTags(content)}\n</page>\n\nQuestion: ${prompt}`,
      maxOutputTokens: Math.min(model.info.maxOutput, 4000),
      signal,
      queue: { priority: session.parentSessionId ? 'subagent' : 'foreground' },
    });
  }

  /** The model for helper work next to `current`: `ref`, unless that would make their shared server swap models. */
  private helperModel(ref: string, current: string): string {
    return this.deps.models.avoidSwap?.(ref, current) ?? ref;
  }

  /** The small model next to `current` when set and usable; null lets the conversation's model do the work. */
  private async smallModel(current: string | null): Promise<ResolvedModel | null> {
    const ref = this.deps.settings().models.defaults.small;
    if (!ref) return null;
    return firstUsableModel(this.deps.models, [current ? this.helperModel(ref, current) : ref, ref]);
  }

  private async storedSnapshot(sessionId: string): Promise<SystemSnapshot | null> {
    const row = await this.requireSession(sessionId);
    return row.systemSnapshot ? (JSON.parse(await this.deps.blobs.readText(row.systemSnapshot)) as SystemSnapshot) : null;
  }

  /**
   * The session's frozen system prompt (docs/PROMPTS.md §1.6). With `rebuild` it is built again when the tier, the
   * model, the person's safeguards or the tool set changed; a run's notes then announce the change.
   */
  private async systemFor(row: SessionRow, info: ModelInfo, tools: DescribedTool[], stored: SystemSnapshot | null, rebuild: boolean): Promise<SystemSnapshot> {
    const overrides = this.deps.promptOverrides();
    const person = await this.deps.person(row.userId);
    const safeguards = safeguardsBlock(this.deps.settings().safeguards, person.safeguards, info.tier, overrides);
    const live = tools.filter((t) => t.name.startsWith('mcp__')).map(toolDef);
    // Kept while the set of connector tools and the tier stay the same: a compact prompt may have cut their descriptions.
    const known = stored?.tier === info.tier ? (stored.mcpTools ?? []) : [];
    const frozen = known.length === live.length && live.every((t) => known.some((k) => k.name === t.name)) ? known : live;
    const sent = (mcpTools: ToolDef[]) => tools.map((t) => mcpTools.find((m) => m.name === t.name) ?? toolDef(t));
    const hash = (defs: ToolDef[]) => createHash('sha256').update(JSON.stringify(defs)).digest('hex');
    // The person's memory as it is now: a change to it rebuilds the prompt at the next turn.
    const memory = this.deps.memory ? await this.deps.memory.digest(row, await this.memoryAccess(row), { tier: info.tier, has: (name) => tools.some((t) => t.name === name) }).catch(() => null) : null;
    const memoryHash = memory ? createHash('sha256').update(memory).digest('hex') : '';
    const current =
      stored &&
      stored.tier === info.tier &&
      stored.modelRef === info.ref &&
      stored.safeguardsHash === (safeguards?.hash ?? '') &&
      stored.toolsetHash === hash(sent(frozen)) &&
      (stored.memoryHash ?? '') === memoryHash;
    if (stored && (current || !rebuild)) return stored;

    const skills = ((await this.deps.extensions?.(row))?.skills ?? []).filter((s) => !s.disableModelInvocation);
    // About 1% of the context window, at four characters a token, but room for a few skills at least.
    const skillBudget = Math.max(2000, info.contextLength * 0.04);
    const code = row.mode === 'chat' ? null : await this.deps.codeContext?.(row);
    const date = this.date();
    // A fresh temporary chat knows nothing about the person, as on a new install; admin text and safeguards stay.
    const personal = usesPersonalContext(row);
    const context: PromptContext = {
      mode: row.mode,
      tier: info.tier,
      model: modelFacts(info, this.deps.settings().providers.find((p) => p.id === info.providerId)),
      date: date.long,
      timeZone: this.timeZone(),
      tools,
      promptedTools: info.capabilities.tools === 'prompted',
      hasEffortControl: info.capabilities.reasoning === 'effort' || info.capabilities.reasoning === 'budget',
      personalization: personal ? person.prefs.personalization : defaultUserPrefs().personalization,
      profileName: personal ? person.prefs.callMe.trim() || person.name : '',
      project: personal && row.projectId && (!row.parentSessionId || isSideChat(row)) ? await this.projectContext(row.projectId) : null,
      subagent: row.parentSessionId !== null && !isSideChat(row),
      ...(row.parentSessionId && !isSideChat(row) ? { subagentFacts: { name: row.title, sessionId: row.id, parentTitle: (await this.deps.repo.getRow(row.parentSessionId))?.title ?? '' } } : {}),
      ...(await this.definedAgentPrompt(row)),
      skills: renderSkillList(skills, skillBudget),
      organization: this.deps.settings().prompts.organizationInstructions,
      ...(code ? { workspace: code.workspace, instructions: personal ? code.instructions : code.instructions.filter((f) => f.kind !== 'personal') } : {}),
      ...(safeguards ? { safeguards } : {}),
      ...(memory ? { memory } : {}),
      overrides,
    };
    // Small local windows: the compact tier's system prompt and tools share one budget (docs/PROMPTS.md §1.8).
    const { blocks, mcpTools, trimmed } =
      info.tier === 'compact' ? fitCompactBudget(context, sent(frozen), renderSkillList(skills, skillBudget, { namesOnly: true })) : { blocks: buildSystemPrompt(context), mcpTools: frozen, trimmed: [] };
    const snapshot: SystemSnapshot = {
      version: PROMPT_VERSION,
      tier: info.tier,
      modelRef: info.ref,
      safeguardsHash: safeguards?.hash ?? '',
      toolsetHash: hash(sent(mcpTools)),
      date: date.iso,
      blocks,
      skills: skills.map((s) => s.name),
      mcpTools,
      ...(trimmed.length ? { trimmed } : {}),
      ...(memoryHash ? { memoryHash } : {}),
    };
    const blob = await this.deps.blobs.putText(JSON.stringify(snapshot), 'application/json');
    await this.deps.repo.update(row.id, { systemSnapshot: blob.sha256 });
    return snapshot;
  }

  private async projectContext(projectId: string): Promise<ProjectContext | null> {
    const project = await this.deps.projects.get(projectId);
    if (!project) return null;
    // Selected by the token estimate stored at upload, so the project view can show the same selection.
    const files: ProjectContext['files'] = [];
    for (const f of projectFilesInPrompt(await this.deps.files.forProject(projectId))) files.push({ name: f.name, text: await this.textOf(f.blob, f.mime) });
    return { name: project.name, instructions: project.instructions, files };
  }

  private async textOf(blob: string, mime: string): Promise<string> {
    const cached = this.extracted.get(blob);
    if (cached !== undefined) return cached;
    const { text } = await extractText(await this.deps.blobs.read(blob), mime);
    this.extracted.set(blob, text);
    return text;
  }

  /** Adapts stored history to what the model can consume; tool results longer than `resultChars` keep their start and end. */
  private async prepareHistory(history: Message[], info: ModelInfo, resultChars: number): Promise<Message[]> {
    const out: Message[] = [];
    for (const m of history) {
      const parts: Part[] = [];
      for (const p of m.parts) {
        // Atelier's own notes; whatever they quote was escaped when they were written. A part that only records state is silent.
        if (p.type === 'context') {
          if (p.text) parts.push({ type: 'text', text: `<context-update>\n${p.text}\n</context-update>` });
        } else if (p.type === 'text' && m.role === 'user') parts.push({ type: 'text', text: escapeTags(p.text) });
        else if (p.type === 'image' && !info.capabilities.vision) parts.push({ type: 'text', text: '[An image was attached, but this model cannot view images.]' });
        else if (p.type === 'document' && !(p.mime === 'application/pdf' && info.capabilities.pdf)) {
          parts.push(
            canExtractText(p.mime)
              ? { type: 'text', text: `<document name="${escapeAttr(p.name)}">\n${escapeTags(await this.textOf(p.blob, p.mime))}\n</document>` }
              : { type: 'text', text: `[Attached file ${p.name} (${p.mime}) cannot be read by this model.]` },
          );
        } else parts.push(p);
      }
      out.push({ ...m, parts });
    }
    return answerDanglingToolCalls(capToolResults(out, resultChars));
  }

  // ------------------------------------------------------- context, compaction, titles

  /**
   * The system prompt, tools and window budget a session's requests are built with. Tools come in a fixed order with
   * descriptions for the model's tier, and connector tools as the snapshot froze them, so the prefix stays cacheable.
   * `rebuild`: a run may replace a stale snapshot; measuring and compacting use the stored one.
   */
  private async requestContext(session: SessionRow, model: ResolvedModel, signal: AbortSignal, rebuild: boolean): Promise<RequestContext> {
    const { info } = model;
    // `none`: the model can't call tools at all, natively or prompted (set per model in Settings › Admin › Models).
    // Compact-tier models (small, local) keep to the core tools: a leaner prompt, and they rarely start background work.
    const side = isSideChat(session);
    const all = side ? sideChatTools(session.mode, await this.toolsFor(session)) : await this.toolsFor(session);
    const offered = info.capabilities.tools === 'none' ? [] : orderTools(all.filter((t) => !(info.tier === 'compact' && COMPACT_SKIPS.has(t.name))));
    const names = new Set(offered.map((t) => t.name));
    const described = offered.map((t) => compactConnector(describeTool(t, { tier: info.tier, mode: session.mode, has: (name) => names.has(name) }), info.tier));
    const previous = await this.storedSnapshot(session.id);
    const snapshot = await this.systemFor(session, info, described, previous, rebuild);
    const frozen = new Map((snapshot.mcpTools ?? []).map((t) => [t.name, t]));
    const describedTools = described.map((t) => {
      const def = frozen.get(t.name);
      return def ? { ...t, description: def.description, inputSchema: def.inputSchema } : t;
    });
    const deferred = model.adapter.type === 'chatgpt-chat' ? deferConnectors(describedTools, await this.deps.repo.history(session.id)) : null;
    const tools = deferred?.tools ?? describedTools;
    const toolDefs = (deferred?.available() ?? tools).map(toolDef);
    const system = snapshot.blocks;
    const effort = this.resolveEffort(session, info);
    // A thinking switch or a model without levels sends High or nothing for Ultracode, and still works as it.
    const ultracode = shownEffort(session.effort as Effort | null, info, session.mode, this.effortOptions(session)) === 'ultracode';
    const maxOutputTokens = Math.min(info.maxOutput, outputCap(ultracode ? 'ultracode' : effort));
    const limit = info.contextLength;
    return {
      sessionId: session.id,
      model,
      system,
      snapshot,
      previous,
      tools,
      ...(deferred ? { availableTools: deferred.available } : {}),
      toolDefs,
      effort,
      ultracode,
      maxOutputTokens,
      fixedTokens: Math.ceil(requestChars(requestSize(system, toolDefs, [])) / DEFAULT_CHARS_PER_TOKEN),
      threshold: compactThreshold(limit, this.deps.settings().context.autoCompactAt, outputReserve(limit, maxOutputTokens)),
      signal,
      ...(side ? { mainSessionId: session.parentSessionId! } : {}),
    };
  }

  /**
   * What the next request sends (ARCHITECTURE §8), checked before every request of a turn: compacted first when it
   * would pass the threshold, and as a last resort with older tool results left out. Announces the context it fills.
   */
  private async prepareRequest(run: RequestContext): Promise<PreparedRequest> {
    await this.deliverNotices(run.sessionId);
    await this.takeOutbox(run.sessionId);
    if (run.availableTools) {
      run.toolDefs = run.availableTools().map(toolDef);
      run.fixedTokens = Math.ceil(requestChars(requestSize(run.system, run.toolDefs, [])) / DEFAULT_CHARS_PER_TOKEN);
    }
    let messages = await this.forModel(run);
    let usage = await this.measure(run, messages);
    const midReply = (run.requests = (run.requests ?? 0) + 1) > 1;
    if (usage.used > run.threshold && midReply) {
      // In the middle of a reply, first leave out tool output the model has already read (oldest first, never the
      // newest round) instead of stopping to summarize. Clearing down to well under the threshold keeps the same
      // results cleared for the next requests, so a local server's prompt cache stays valid between them.
      messages = stubOldResults(messages, Math.ceil((usage.used - run.threshold * MID_REPLY_TARGET) * usage.charsPerToken));
      usage = await this.measure(run, messages, false);
    }
    if (usage.used > run.threshold && !run.compactionFailed && (await this.autoCompact(run))) {
      messages = await this.forModel(run);
      usage = await this.measure(run, messages);
    }
    if (usage.used > run.threshold) {
      messages = stubOldResults(messages, Math.ceil((usage.used - run.threshold) * usage.charsPerToken));
      usage = await this.measure(run, messages, false);
    }
    this.emit(run.sessionId, { type: 'context', context: usage });
    return { messages, maxOutputTokens: Math.max(256, Math.min(run.maxOutputTokens, usage.limit - usage.used)) };
  }

  /** The model-visible history as a request sends it. */
  private async forModel(run: RequestContext): Promise<Message[]> {
    const { resultChars, tailChars } = roomBudgets(run.threshold - run.fixedTokens);
    const history = await this.deps.repo.history(run.sessionId);
    const sent = run.mainSessionId ? withSideChatNote(history, await this.mainConversation(run.mainSessionId, tailChars)) : history;
    return this.prepareHistory(sent, run.model.info, resultChars);
  }

  /** A side chat's note: the main conversation as it stands, its reply in progress too, in at most `maxChars`. */
  private async mainConversation(mainId: string, maxChars: number): Promise<string> {
    const main = await this.requireSession(mainId);
    const live = this.live.get(mainId);
    const history = (await this.deps.repo.history(mainId)).map((m) => (m.id === live?.messageId ? { ...m, parts: [...live.parts] } : m));
    return sideChatNote({ title: main.title, running: this.runs.has(mainId), transcript: mainTranscript(history, maxChars) }, this.deps.promptOverrides());
  }

  /**
   * `/btw`: a side chat beside `parentId` (ARCHITECTURE › Side chats), asking `question` at once when there is one. It
   * runs on its own, whatever the main session is doing, and never waits for it.
   */
  async startSideChat(parentId: string, question?: string): Promise<SessionSummary> {
    const parent = await this.requireSession(parentId);
    if (parent.parentSessionId) throw new Error('A side chat belongs to a main session.');
    const text = question?.trim() ?? '';
    const child = await this.deps.repo.create({
      mode: parent.mode,
      userId: parent.userId,
      projectId: parent.projectId,
      workspaceId: parent.workspaceId,
      model: parent.model,
      effort: SIDE_CHAT_EFFORT,
      permissionMode: parent.permissionMode,
      parentSessionId: parent.id,
      ...(text ? { title: sideChatTitle(text) } : {}),
      overrides: { [SIDE_CHAT_KEY]: true, thinking: parent.overrides.thinking !== false, originClient: parent.overrides.originClient, remoteControl: parent.overrides.remoteControl !== false },
    });
    if (text) await this.send(child.id, [{ type: 'text', text }]);
    return (await this.deps.repo.get(child.id)) ?? child;
  }

  /** A main session's side chats, oldest first. */
  async sideChats(parentId: string): Promise<SessionSummary[]> {
    return (await this.deps.repo.children(parentId)).filter(isSideChat).map((row) => toSummary(row));
  }

  /** How much of the window `messages` fill; close to the threshold the provider counts, where it can cheaply. */
  private async measure(run: RequestContext, messages: Message[], count = true): Promise<ContextUsage> {
    const { info, adapter } = run.model;
    const size = requestSize(run.system, run.toolDefs, messages);
    if (adapter.type === 'chatgpt-chat' && run.toolDefs.length) {
      const promptedChars = toolSpecPrompt(run.toolDefs).length;
      const toolChars = size.fixed.systemTools + size.fixed.mcpTools;
      size.fixed.systemTools += Math.max(0, promptedChars - toolChars);
    }
    const opts = { model: info.ref, charsPerToken: this.calibration.charsPerToken(info.ref), limit: info.contextLength, threshold: run.threshold };
    let usage = contextUsage(size, messages, opts);
    if (count && adapter.countTokens && Math.abs(usage.used - run.threshold) <= run.threshold * 0.15) {
      const exact = await adapter
        .countTokens({
          model: info.modelId,
          system: run.system,
          messages,
          ...(run.toolDefs.length ? { tools: run.toolDefs } : {}),
          maxOutputTokens: run.maxOutputTokens,
          contextLength: info.contextLength,
          signal: AbortSignal.any([run.signal, AbortSignal.timeout(5_000)]),
        })
        .catch(() => null);
      if (exact && this.calibration.observe(info.ref, requestChars(size), exact)) {
        usage = contextUsage(size, messages, { ...opts, charsPerToken: this.calibration.charsPerToken(info.ref), exact });
      }
    }
    run.last = { size, messages, used: usage.used };
    return usage;
  }

  /** A reply's usage calibrates the estimates and gives the exact context, when its count is plausible. */
  private observeUsage(run: RequestContext, usage: Usage): void {
    if (!run.last) return;
    const { info } = run.model;
    const input = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    const counted = this.calibration.observe(info.ref, requestChars(run.last.size), input);
    const exact = (counted ? input : run.last.used) + usage.output;
    const opts = { model: info.ref, charsPerToken: this.calibration.charsPerToken(info.ref), limit: info.contextLength, threshold: run.threshold, exact };
    this.emit(run.sessionId, { type: 'context', context: contextUsage(run.last.size, run.last.messages, opts) });
  }

  /** The context window as the next request would fill it, for Code's context popover; null without a usable model. */
  async contextUsage(sessionId: string): Promise<ContextUsage | null> {
    const session = await this.requireSession(sessionId);
    const ref = session.model ?? defaultModelFor(this.deps.settings(), session.mode);
    const model = ref ? await this.deps.models.resolve(ref, session.userId).catch(() => null) : null;
    if (!model) return null;
    const run = await this.requestContext(session, model, AbortSignal.timeout(10_000), false);
    return this.measure(run, await this.forModel(run), false);
  }

  /** Compacts before a request that would pass the threshold, keeping the newest messages; false when it couldn't. */
  private async autoCompact(run: RequestContext): Promise<boolean> {
    // The same task summarized again and again is going nowhere: the work doesn't fit this window.
    if ((run.compactions ?? 0) >= MAX_TURN_COMPACTIONS) throw new ContextLoopError(run.compactions!);
    const tail = roomBudgets(run.threshold - run.fixedTokens);
    try {
      const compacted = await this.compactNow(run.sessionId, { signal: run.signal, current: run.model, tail, summaryTokens: tail.summaryTokens });
      if (compacted) run.compactions = (run.compactions ?? 0) + 1;
      return compacted;
    } catch (error) {
      if (run.signal.aborted) return false;
      run.compactionFailed = true;
      const reason = error instanceof Error ? error.message : String(error);
      await this.addContextMessage(run.sessionId, `The conversation could not be summarized (${reason}). Older tool results are left out of what the model sees for the rest of this turn.`);
      return false;
    }
  }

  /**
   * Summarizes the older part of the model-visible history into a summary node (ARCHITECTURE §8). With `tail`, the
   * newest messages within `tailChars` (as sent, results cut at `resultChars`) stay verbatim after it (auto-compaction);
   * without, everything does but a request still waiting for its answer. False when there was nothing new to summarize.
   */
  private async compactNow(
    sessionId: string,
    opts: { focus?: string; signal: AbortSignal; current: ResolvedModel; tail?: { tailChars: number; resultChars: number }; summaryTokens: number },
  ): Promise<boolean> {
    const session = await this.requireSession(sessionId);
    const history = await this.deps.repo.history(sessionId);
    const last = history.at(-1);
    // A "/compact" the person just sent is not a request left unanswered.
    const echo = last?.parts.some((p) => p.type === 'context' && p.notice?.kind === 'command');
    const waiting = last?.role === 'user' && last.kind !== 'compaction_summary' && !echo ? 1 : 0;
    const start = opts.tail ? tailStart(capToolResults(history, opts.tail.resultChars), opts.tail.tailChars, waiting) : history.length - waiting;
    const summarized = history.slice(0, start);
    if (!summarized.some((m) => m.kind !== 'compaction_summary')) return false;
    const state = renderState(await this.carriedState(session, summarized, history.slice(start)));
    this.emit(sessionId, { type: 'compacting', active: true });
    try {
      const { text, model } = await this.summarizeWith(session, opts.current, summarized, state, opts);
      const through = summarized.at(-1)!.id;
      const tail = history[start];
      const stored = await this.storedSnapshot(sessionId);
      const carried = afterCompaction(
        {
          ...carriedReference(summarized),
          state: { ...(stored ? snapshotFacts(stored) : {}), ...announcedState(summarized) },
          models: new Map([[opts.current.info.ref, opts.current.info.displayName]]),
        },
        this.deps.promptOverrides(),
      );
      const body = `This conversation was compacted. Summary of everything before this point:\n\n${text}${state ? `\n\n## Carried over verbatim\n\n${state}` : ''}`;
      // What it saved: the messages it replaces against its own size, in this model's characters per token.
      const perToken = this.calibration.charsPerToken(opts.current.info.ref) || DEFAULT_CHARS_PER_TOKEN;
      const saved = Math.max(0, Math.round((requestChars(requestSize([], [], summarized)) - body.length) / perToken));
      const summary = await this.deps.repo.insertMessage(
        {
          id: newId(),
          sessionId,
          parentId: through,
          role: 'user',
          parts: [{ type: 'text', text: body }, carried.type === 'context' ? { ...carried, notice: { kind: 'compaction', saved } } : carried],
          model,
          usage: null,
          stopReason: null,
          error: null,
          kind: 'compaction_summary',
          summarizesThroughId: through,
        },
        { setHead: !tail },
      );
      // The verbatim tail continues after the summary.
      if (tail) await this.deps.repo.reparent(tail.id, summary.id);
      this.contexts.delete(sessionId);
      this.emit(sessionId, { type: 'message', message: summary });
      this.emit(sessionId, { type: 'compacted', summaryMessageId: summary.id });
      return true;
    } finally {
      this.emit(sessionId, { type: 'compacting', active: false });
    }
  }

  /**
   * The summary from the small model, else the session's own, else the session's own again with chunks half the size.
   * A transcript longer than the summarizer's window goes in chunks (`summarize`).
   */
  private async summarizeWith(
    session: SessionRow,
    current: ResolvedModel,
    summarized: Message[],
    state: string,
    opts: { focus?: string; signal: AbortSignal; summaryTokens: number },
  ): Promise<{ text: string; model: string }> {
    const helper = await this.smallModel(current.info.ref);
    const small = helper && helper.info.ref !== current.info.ref ? helper : null;
    const queue: QueueOptions = { priority: session.parentSessionId ? 'subagent' : 'foreground', onWait: (ahead) => this.emit(session.id, { type: 'queued', ahead }) };
    const attempts = [...(small ? [{ model: small, scale: 1 }] : []), { model: current, scale: 1 }, { model: current, scale: 0.5 }];
    const system = render(template('compaction', this.deps.promptOverrides()), { focus: opts.focus ? `\nFocus especially on: ${opts.focus}` : '' });
    const blocks = summarized.map(renderForSummary);
    let failure: unknown = new Error('No summary was written');
    for (const { model, scale } of attempts) {
      if (opts.signal.aborted) break;
      const { info } = model;
      const summarizer = {
        contextLength: info.contextLength,
        // Never more than 4 characters a token: a summary request that overflows costs a whole attempt.
        charsPerToken: Math.min(this.calibration.charsPerToken(info.ref), DEFAULT_CHARS_PER_TOKEN),
        complete: (user: string, maxOutputTokens: number) =>
          collectText(model, {
            system: [{ text: system }],
            user,
            maxOutputTokens,
            signal: opts.signal,
            queue,
            onUsage: (usage) => this.deps.recordUsage({ model: info, sessionId: session.id, userId: session.userId, mode: session.mode, usage }),
          }),
      };
      try {
        const text = (await summarize(summarizer, blocks, state, Math.min(opts.summaryTokens, info.maxOutput, Math.floor(info.contextLength / 4)), scale)).trim();
        if (text) return { text, model: info.ref };
        failure = new Error('The summary came back empty');
      } catch (error) {
        failure = error;
      }
    }
    throw opts.signal.aborted ? new Error('Compaction was stopped') : failure;
  }

  /**
   * The current request (unless the verbatim tail has it: an earlier compaction may have summarized it already), the
   * todo list, changed files and skills loaded, kept verbatim.
   */
  private async carriedState(session: SessionRow, summarized: Message[], tail: Message[]): Promise<CarriedState> {
    const turn = await this.deps.repo.currentTurn(session.id);
    const request = turn && !tail.some((m) => m.id === turn) ? await this.deps.repo.getMessage(turn) : undefined;
    const files = new Set((await this.deps.checkpoints?.list(session.parentSessionId ?? session.id))?.flatMap((c) => c.paths));
    const skills = new Set<string>();
    for (const m of summarized) {
      for (const p of m.parts) {
        const input = p.type === 'tool_call' ? ((p.input ?? {}) as Record<string, unknown>) : {};
        if (p.type === 'tool_call' && (p.name === 'Write' || p.name === 'Edit') && typeof input.file_path === 'string') files.add(input.file_path);
        if (p.type === 'tool_call' && p.name === 'Skill' && typeof input.skill === 'string') skills.add(input.skill);
        if (p.type === 'context') for (const [, name] of p.text.matchAll(/^<skill name="([^"]+)">/gm)) skills.add(unescapeAttr(name!));
      }
    }
    return { request: request ? messageText(request.parts) : null, todos: session.todos as Todo[], files: [...files].slice(-50), skills: [...skills] };
  }

  /**
   * A short guess at the person's next message after a turn in Code or Cowork (their prefs' `code.suggestions`), from
   * what they usually say at this point and the reply: the small model's, or the conversation's own. Best-effort, at
   * background priority; a new turn cancels it.
   */
  private async suggestReply(sessionId: string, current: ResolvedModel): Promise<void> {
    const controller = new AbortController();
    this.suggesting.get(sessionId)?.abort();
    this.suggesting.set(sessionId, controller);
    try {
      const session = await this.requireSession(sessionId);
      if (!(await this.deps.person(session.userId)).prefs.code.suggestions) return;
      const { messages } = await this.deps.repo.branch(sessionId);
      const said = messages.flatMap((m) => (m.role === 'user' && m.kind === 'normal' ? [messageText(m.parts).trim()] : [])).filter(Boolean).slice(-SUGGESTION_HISTORY);
      const reply = messages.findLast((m) => m.role === 'assistant' && messageText(m.parts).trim());
      if (!said.length || !reply) return;
      const model = (await this.smallModel(current.info.ref)) ?? current;
      // Browser chat has one conversation slot, which the person's next message needs.
      if (model.adapter.type === 'chatgpt-chat') return;
      const text = await collectText(model, {
        system: [{ text: template('suggestion', this.deps.promptOverrides()) }],
        user: `The person's messages so far, oldest first:\n${said.map((m) => `- ${m.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}\n\nThe assistant's last reply:\n${messageText(reply.parts).slice(-3000)}`,
        maxOutputTokens: 300,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2 * 60_000)]),
        queue: { priority: 'background', timeoutMs: 60_000, owner: sessionId },
        onUsage: (usage) => this.deps.recordUsage({ model: model.info, sessionId, userId: session.userId, mode: session.mode, usage }),
      });
      const suggestion = sanitizeSuggestion(text);
      if (!suggestion || controller.signal.aborted || this.runs.has(sessionId)) return;
      this.suggestions.set(sessionId, suggestion);
      this.emit(sessionId, { type: 'suggestion', text: suggestion });
    } catch {
      // Suggestions are best-effort: the box keeps its usual placeholder.
    } finally {
      if (this.suggesting.get(sessionId) === controller) this.suggesting.delete(sessionId);
    }
  }

  private dropSuggestion(sessionId: string): void {
    this.suggesting.get(sessionId)?.abort();
    this.suggesting.delete(sessionId);
    if (this.suggestions.delete(sessionId)) this.emit(sessionId, { type: 'suggestion', text: null });
  }

  private async generateTitle(sessionId: string, current: ResolvedModel): Promise<void> {
    this.titling.add(sessionId);
    try {
      const { messages } = await this.deps.repo.branch(sessionId);
      const firstUser = messages.find((m) => m.role === 'user' && m.kind === 'normal');
      if (!firstUser) return;
      const userText = messageText(firstUser.parts) || '(attachment)';
      const small = (await this.smallModel(current.info.ref)) ?? current;
      // Browser chat has one conversation slot; a local title avoids an extra page load ahead of the reply.
      const ask = (model: ResolvedModel) => {
        if (model.adapter.type === 'chatgpt-chat') return Promise.resolve('');
        return collectText(model, {
          system: [{ text: template('title', this.deps.promptOverrides()) }],
          user: `First message:\n${userText.slice(0, 2000)}`,
          maxOutputTokens: 400,
          // A short request that goes ahead of the queue; once it runs, 30 seconds is plenty.
          signal: AbortSignal.timeout(5 * 60_000),
          queue: { priority: 'urgent', timeoutMs: 30_000, owner: sessionId },
        });
      };
      // A failing small model falls back to the chat's model, then to the first words of the message.
      const generated = await ask(small).catch(() => (small === current ? '' : ask(current).catch(() => '')));
      const title = sanitizeTitle(generated) || sanitizeTitle(userText.split(/\s+/).slice(0, 6).join(' '));
      if (!title) return;
      const summary = await this.deps.repo.update(sessionId, { title });
      this.emit(sessionId, { type: 'title', title });
      this.deps.sessionChanged(summary);
    } catch {
      // Titles are best-effort; the session keeps its fallback label.
    } finally {
      this.titling.delete(sessionId);
    }
  }
}

const CANCELLED = 'Cancelled before the tool ran.';

/**
 * What the model reads when a call is refused. A deny rule is the person's or an administrator's decision, so the
 * model hears that working around it (`find -delete` for a denied `rm`) is out, not just that this call failed.
 */
function refusal(decision: Decision): string {
  if (!decision.rule) return decision.reason;
  return `${decision.reason} The person's settings rule this out: don't get the same result another way, with another command or tool. Tell them what was blocked.`;
}
/** Tool calls without a TodoWrite before the task list gets a reminder. */
const TODO_NUDGE_CALLS = 10;
/** Tools whose first visit to a folder announces its instruction file. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write']);
/** Folders whose instruction files were written for other projects (dependencies, builds); never announced. */
const NOT_INSTRUCTIONS = new Set(['node_modules', 'vendor', '.venv', 'venv', 'target', 'dist', 'build', '.git']);
/** A nested instruction file's text in its note, at most. */
const NESTED_CHARS = 20_000;
/** A compact-tier connector description: its first sentence, at most this long (docs/PROMPTS.md §1.3). */
const COMPACT_CONNECTOR_CHARS = 200;

/** Tools whose path the runner scopes to the workspace's roots. */
const REACH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);
/** Tools compact-tier models don't get: their prompt and tools have to fit COMPACT_BUDGET_CHARS, and small models rarely need them. */
const COMPACT_SKIPS = new Set(['TaskStop', 'ChangeDirectory', 'SendMessage', 'ListSessions', 'MemoryView', 'ChatRead', 'Time', 'Usage']);
/** One instruction file of a folder the session moved to, at most this long in the tool's result. */
const MOVED_INSTRUCTION_CHARS = 8_000;

/** Skill bodies kept for the after-compaction note, each at most this long. */
const CARRIED_SKILL_CHARS = 8_000;

/**
 * From the summarized messages: the plan the person approved last, the three skills loaded most recently (their text
 * from the Skill result or the `/name` part) and the ten files read most recently.
 */
function carriedReference(messages: Message[]): { plan: string | null; skills: { name: string; text: string }[]; files: string[] } {
  const calls = new Map<string, Extract<Part, { type: 'tool_call' }>>();
  let plan: string | null = null;
  const skills = new Map<string, string>();
  // Most recent last: a skill loaded again moves to the end.
  const loaded = (name: string, text: string) => {
    skills.delete(name);
    skills.set(name, text);
  };
  const files: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_call') {
        calls.set(p.id, p);
        const path = (p.input as { file_path?: unknown } | null)?.file_path;
        if (p.name === 'Read' && typeof path === 'string') files.push(path);
      } else if (p.type === 'tool_result' && !p.isError) {
        const call = calls.get(p.callId);
        const text = p.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
        const input = (call?.input ?? {}) as { plan?: unknown; skill?: unknown };
        if (call?.name === 'ExitPlanMode' && approvedMode(text) && typeof input.plan === 'string') plan = input.plan;
        if (call?.name === 'Skill' && typeof input.skill === 'string') loaded(input.skill, text);
      } else if (p.type === 'context') {
        const slash = /^<skill name="([^"]+)">\n([\s\S]*)\n<\/skill>$/.exec(p.text);
        if (slash) loaded(unescapeAttr(slash[1]!), slash[2]!);
      }
    }
  }
  return {
    plan,
    skills: [...skills].slice(-3).map(([name, text]) => ({ name, text: text.slice(0, CARRIED_SKILL_CHARS) })),
    files: [...new Set(files.reverse())].slice(0, 10).reverse(),
  };
}

function withoutProperty(schema: JsonSchema, name: string): JsonSchema {
  const { [name]: _dropped, ...properties } = (schema.properties ?? {}) as Record<string, unknown>;
  return { ...schema, properties };
}

function toolDef(t: DescribedTool | ToolDef): ToolDef {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

function compactConnector(tool: DescribedTool, tier: ModelInfo['tier']): DescribedTool {
  if (tier !== 'compact' || !tool.name.startsWith('mcp__')) return tool;
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(tool.description.trim())?.[0] ?? tool.description.trim();
  return { ...tool, description: first.length > COMPACT_CONNECTOR_CHARS ? `${first.slice(0, COMPACT_CONNECTOR_CHARS - 1)}…` : first };
}

/** Connector (MCP server) names, from their tools' `mcp__<server>__<tool>` names. */
function connectorsOf(toolNames: string[]): string[] {
  return [...new Set(toolNames.filter((n) => n.startsWith('mcp__')).map((n) => n.split('__')[1]!))].sort();
}

/** What a frozen system prompt states, as context-note state: what the model knows without being told. */
function snapshotFacts(s: SystemSnapshot): NoteState {
  const facts: NoteState = {};
  if (s.date) facts.date = s.date;
  if (s.modelRef) facts.model = s.modelRef;
  if (s.safeguardsHash !== undefined) facts.safeguards = s.safeguardsHash;
  if (s.skills) facts.skills = [...s.skills].sort().join('\n');
  if (s.mcpTools) facts.connectors = connectorsOf(s.mcpTools.map((t) => t.name)).join('\n');
  return facts;
}
/** Where a session's questions to the person appear: a sub-agent's in its parent's transcript, a side chat's in its own. */
function askerOf(session: SessionRow): string {
  return session.parentSessionId && !isSideChat(session) ? session.parentSessionId : session.id;
}

/** How often Stop hooks may send the model back to work in one turn. */
const MAX_STOP_ROUNDS = 3;

type SessionHooks = { workspace: Workspace; configs: HooksConfig[] };

/** The skills and commands one session can use, and how to read them. */
export interface ExtensionCatalog {
  skills: Skill[];
  commands: Command[];
  agents: AgentDef[];
  read(item: Skill | Command | AgentDef): Promise<string | null>;
  /** Lets the session's tools reach the skill's own files, where its machine allows. */
  reach?(skill: Skill): Promise<void>;
  /** For `${CLAUDE_PROJECT_DIR}`; empty without a workspace. */
  projectDir: string;
}
/** How much of a running tool's live output a reconnecting client gets. */
const OUTPUT_TAIL_CHARS = 30_000;

/**
 * Every tool call needs a result right after it, or providers reject the whole history (Anthropic 400s on
 * a `tool_use` without `tool_result`). Calls cut off by Stop, a restart or a stream error get one.
 */
export function answerDanglingToolCalls(input: Message[]): Message[] {
  const history = [...input];
  const out: Message[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    out.push(m);
    if (m.role !== 'assistant') continue;
    const next = history[i + 1];
    const answered = new Set(next?.role === 'tool' ? next.parts.flatMap((p) => (p.type === 'tool_result' ? [p.callId] : [])) : []);
    const missing: ToolResultPart[] = m.parts.flatMap((p) =>
      p.type === 'tool_call' && !answered.has(p.id) ? [{ type: 'tool_result', callId: p.id, isError: true, content: [{ type: 'text', text: CANCELLED }] }] : [],
    );
    if (missing.length === 0) continue;
    if (next?.role === 'tool') {
      history[i + 1] = { ...next, parts: [...next.parts, ...missing] };
    } else {
      out.push({ ...m, id: `${m.id}:cancelled`, parentId: m.id, role: 'tool', parts: missing, model: null, usage: null, stopReason: null, error: null });
    }
  }
  return out;
}

/**
 * The passages a reply quotes (`notice.kind === 'quote'`): at most QUOTE_MAX_COUNT of QUOTE_MAX_CHARS, and what the model
 * is told is written here from the passage itself (escaped, as a block quote), whatever the client put in `text`.
 */
export function withQuotes(parts: Part[]): Part[] {
  let count = 0;
  return parts.flatMap((p): Part[] => {
    if (p.type !== 'context' || p.notice?.kind !== 'quote') return [p];
    const quoted = p.notice.text.slice(0, QUOTE_MAX_CHARS).trim();
    if (!quoted || ++count > QUOTE_MAX_COUNT) return [];
    const block = escapeTags(quoted)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return [{ type: 'context', text: `The person is replying to this passage from earlier in the conversation:\n${block}`, notice: { kind: 'quote', text: quoted } }];
  });
}

/** The person's own messages a suggestion is guessed from, at most (their habits show in the recent ones). */
const SUGGESTION_HISTORY = 12;

/** A suggested next message as the box shows it: one line, no quotes, at most 120 characters; NONE is none. */
export function sanitizeSuggestion(raw: string): string | null {
  const line = (raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  if (!line || /^none\.?$/i.test(line) || line.length > 120) return null;
  return line;
}

export function sanitizeTitle(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/^["'“”‘’#*\s]+|["'“”‘’.!?*\s]+$/g, '').slice(0, 80);
}

/**
 * The level for helper work (titles, summaries, page answers): a leveled model's lowest where leaving the level out
 * means the provider's default reasoning (gpt-oss on Ollama spent half of a 723-token summary budget reasoning at its
 * default and the summary was cut off; OpenAI's reasoning models default to medium). Anthropic models get none: there
 * a level turns adaptive thinking on, and without one they don't think.
 */
function helperEffort(model: ResolvedModel): Effort | null {
  if (model.info.capabilities.reasoning !== 'effort' || model.adapter.type === 'anthropic') return null;
  return nativeEfforts(model.info)[0] ?? null;
}

/** Runs a one-shot, tool-less request and returns the concatenated text. */
export async function collectText(
  model: ResolvedModel,
  req: { system: SystemBlock[]; user: string; maxOutputTokens: number; signal: AbortSignal; queue?: QueueOptions; onUsage?(usage: Usage): void },
): Promise<string> {
  let text = '';
  const now = Date.now();
  for await (const ev of model.adapter.stream({
    model: model.info.modelId,
    system: req.system,
    messages: [{ id: 'x', sessionId: 'x', parentId: null, role: 'user', parts: [{ type: 'text', text: req.user }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: now }],
    maxOutputTokens: req.maxOutputTokens,
    effort: helperEffort(model),
    contextLength: model.info.contextLength,
    signal: req.signal,
    ...(req.queue ? { queue: req.queue } : {}),
  })) {
    if (ev.type === 'text') text += ev.delta;
    if (ev.type === 'text_snapshot') text = ev.text;
    if (ev.type === 'usage') req.onUsage?.(ev.usage);
    if (ev.type === 'finish' && ev.error) throw new Error(ev.error.message);
  }
  return text;
}
