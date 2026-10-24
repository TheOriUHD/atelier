import { z } from 'zod';
import { Message, MessageError, Part, Usage } from './messages.ts';
import { Effort } from './models.ts';
import { Mode, PermissionMode, SettingsLayer } from './settings.ts';

export const SessionStatus = z.enum(['idle', 'running', 'waiting', 'interrupted', 'error']);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** A temporary chat's privacy: `private` keeps it out of history and memory; `fresh` also gives the model nothing personal. */
export const TemporaryMode = z.enum(['private', 'fresh']);
export type TemporaryMode = z.infer<typeof TemporaryMode>;

export const SessionSummary = z.object({
  id: z.string(),
  mode: Mode,
  workspaceId: z.string().nullable(),
  permissionMode: PermissionMode.nullable(),
  title: z.string(),
  projectId: z.string().nullable(),
  model: z.string().nullable(),
  effort: Effort.nullable(),
  thinking: z.boolean().optional(),
  remoteControl: z.boolean().optional(),
  /** Connectors switched off for this session; the rest offer their tools. */
  connectorsOff: z.array(z.string()),
  /** Research: each message asks the model to search broadly and cite its sources (while web search is on). */
  research: z.boolean(),
  /** From `sessions.list` only: whether it made an artifact or, in Cowork, changed files in its folder. */
  produced: z.boolean().optional(),
  /** A turn finished while the person was elsewhere, and they haven't opened the session since (the sidebar's blue dot). */
  finishedUnseen: z.boolean().optional(),
  /** The person's sidebar group it is filed under. */
  groupId: z.string().nullable().optional(),
  /** When it was archived (put away), if it was. */
  archivedAt: z.number().nullable().optional(),
  /** Set on temporary chats: never listed or searched, and deleted when the person leaves them. */
  temporary: TemporaryMode.nullable().optional(),
  status: SessionStatus,
  pinnedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** One of the person's own groups in the sidebar's Code and Cowork lists. */
export const SessionGroup = z.object({ id: z.string(), name: z.string(), collapsed: z.boolean(), createdAt: z.number() });
export type SessionGroup = z.infer<typeof SessionGroup>;

/** What the person is asked before a tool call runs (ARCHITECTURE §8). */
export const PermissionRequest = z.object({
  callId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  /** Why it needs approval: the matching ask rule, the mode default, access outside the workspace … */
  reason: z.string(),
  /** Set for dangerous commands; the prompt shows it in red. */
  warning: z.string().optional(),
  /** The rule "Always allow" would add, e.g. `Bash(npm test *)`; empty when the answer can't be remembered (plan approval). */
  suggestedRule: z.string(),
  /** Set when a sub-agent asks: the task it was given (its session title). */
  agent: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** A pending interaction the run is blocked on; survives reconnects (cleared if the backend restarts). */
export const PendingInteraction = z.object({ kind: z.enum(['permission', 'question', 'elicitation']), id: z.string(), payload: z.unknown() });
export type PendingInteraction = z.infer<typeof PendingInteraction>;

/**
 * The person's answer to a permission request. `remember` widens an approval beyond this one call: for this
 * session, for this project (the workspace's `.atelier/settings.local.json`), or always (their own rules).
 */
export const PermissionAnswer = z.object({
  behavior: z.enum(['allow', 'deny']),
  remember: z.enum(['session', 'project', 'always']).optional(),
  /** Told to the model on deny ("use the staging database instead"). */
  message: z.string().max(2000).optional(),
  /** Approving an ExitPlanMode plan: the mode to continue in. */
  mode: z.enum(['auto', 'default', 'acceptEdits']).optional(),
  /** Approving a ChangeDirectory: the folder to move to (the person may have corrected or picked it). */
  path: z.string().max(4096).optional(),
});
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;

/** AskUser (ARCHITECTURE §8): multiple-choice questions; the person can also type their own answer. */
export const Question = z.object({
  question: z.string().min(1).max(500),
  /** A short chip label ("Database"). */
  header: z.string().max(24),
  options: z.array(z.object({ label: z.string().min(1).max(80), description: z.string().max(300) })).min(2).max(4),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof Question>;

export const QuestionRequest = z.object({ callId: z.string(), questions: z.array(Question).min(1).max(4) });
export type QuestionRequest = z.infer<typeof QuestionRequest>;

/** Answers keyed by question text: chosen labels joined by ", ", or the person's own text. Empty when dismissed. */
export const QuestionAnswer = z.object({ answers: z.record(z.string(), z.string().max(4000)) });
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

/**
 * An MCP server asks the person something during a tool call (ARCHITECTURE §9-B). Form mode carries
 * `requestedSchema` (a flat object of string, number, boolean and enum fields); URL mode carries `url`, which
 * the person opens themselves after consenting; it is never opened automatically.
 */
export const ElicitationRequest = z.object({
  /** The tool call it belongs to, when the server's request can be tied to one. */
  callId: z.string().optional(),
  server: z.string(),
  message: z.string(),
  requestedSchema: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
});
export type ElicitationRequest = z.infer<typeof ElicitationRequest>;

/** `content` holds the form's values on accept; URL mode accepts without content. */
export const ElicitationAnswer = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
});
export type ElicitationAnswer = z.infer<typeof ElicitationAnswer>;

/** One entry of the Code view's file tree; `path` is relative to the workspace root with `/` separators. */
export const WorkspaceEntry = z.object({ name: z.string(), path: z.string(), kind: z.enum(['file', 'dir', 'symlink']), size: z.number() });
export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;

export const WorkspaceFile = z.object({
  path: z.string(),
  /** null for binary files. */
  content: z.string().nullable(),
  truncated: z.boolean(),
  size: z.number(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

export const GitFileStatus = z.object({
  path: z.string(),
  status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']),
  staged: z.boolean(),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

/**
 * null outside a git repository. `branch` is null when HEAD is detached; `upstream` is null when the branch
 * tracks nothing yet, otherwise how many commits it is ahead of and behind it.
 */
export const GitStatus = z
  .object({ branch: z.string().nullable(), upstream: z.object({ ahead: z.number(), behind: z.number() }).nullable(), files: z.array(GitFileStatus) })
  .nullable();
export type GitStatus = z.infer<typeof GitStatus>;

/** What the Diff pane compares the working tree with (`workspaces.diff`). */
export const DiffCompare = z.enum(['head', 'staged', 'base', 'session']);
export type DiffCompare = z.infer<typeof DiffCompare>;

/** A skill as Settings shows it: where it comes from and whether Atelier installed it. */
export const SkillSummary = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.enum(['project', 'global', 'plugin']),
  /** Only people can start it with /name. */
  manualOnly: z.boolean(),
  warnings: z.array(z.string()),
  /** Set when Atelier installed it: where from and at which commit. */
  installed: z.object({ source: z.string(), sha: z.string(), installedAt: z.string() }).nullable(),
  /** The person's computer it is on, for one from their home folder there (a desktop signed in to a server). */
  device: z.string().optional(),
});
export type SkillSummary = z.infer<typeof SkillSummary>;

/** A plugin and what it brings; plugins installed for Claude Code are read-only here apart from on/off. */
export const PluginSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  source: z.enum(['claude-code', 'atelier']),
  enabled: z.boolean(),
  skills: z.array(z.string()),
  commands: z.array(z.string()),
  agents: z.array(z.string()),
  /** The person's computer it is installed on (Claude Code's plugins there); switching it is their own preference. */
  device: z.string().optional(),
});
export type PluginSummary = z.infer<typeof PluginSummary>;

/** A request to a model provider, as Settings › Admin › Developer shows it: no bodies except a failed response's, credentials masked. */
export const InspectedRequest = z.object({
  id: z.string(),
  at: z.number(),
  method: z.string(),
  url: z.string(),
  requestHeaders: z.record(z.string(), z.string()),
  requestBytes: z.number().nullable(),
  /** null while waiting, or when the request failed before an answer. */
  status: z.number().nullable(),
  /** Until the response's headers arrived. */
  ms: z.number().nullable(),
  error: z.string().nullable(),
  errorBody: z.string().nullable(),
});
export type InspectedRequest = z.infer<typeof InspectedRequest>;

/** One day of usage for one model and mode. `costUsd` covers the priced requests; `unpriced` counts the rest. */
export const UsageRow = z.object({
  day: z.string(),
  providerId: z.string(),
  modelId: z.string(),
  mode: z.string(),
  requests: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  costUsd: z.number().nullable(),
  unpriced: z.number(),
  /** Averaged over the `timed` requests that reported a speed. */
  tokensPerSecond: z.number().nullable(),
  timed: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;

/**
 * The Code and Cowork homes' stats card: one person's root sessions in a mode over a period. Messages are theirs
 * and the model's replies; tokens include the sessions' sub-agents. Days and hours are the person's local ones.
 */
export const StatsSummary = z.object({
  sessions: z.number(),
  messages: z.number(),
  tokens: z.number(),
  activeDays: z.number(),
  /** The hour (0–23) with the most messages. */
  peakHour: z.number().nullable(),
  /** The model ref with the most tokens. */
  favoriteModel: z.string().nullable(),
  /** The last 26 weeks whatever the period, for the activity heatmap; days without messages are left out. */
  days: z.array(z.object({ day: z.string(), sessions: z.number(), messages: z.number() })),
  /** Most tokens first. */
  models: z.array(z.object({ ref: z.string(), tokens: z.number(), requests: z.number() })),
});
export type StatsSummary = z.infer<typeof StatsSummary>;

export const CodespaceSummary = z.object({
  name: z.string(),
  displayName: z.string(),
  repo: z.string(),
  /** GitHub's state: Available, Shutdown, Starting, … */
  state: z.string(),
  machine: z.string().nullable(),
  idleTimeoutMinutes: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
  /** Where the repository is checked out inside it. */
  root: z.string(),
});
export type CodespaceSummary = z.infer<typeof CodespaceSummary>;

/** A repository on the person's GitHub account, for the picker that opens it in a codespace. */
export const GitHubRepo = z.object({
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.number().nullable(),
});
export type GitHubRepo = z.infer<typeof GitHubRepo>;

/**
 * A message sent while the agent was working: it joins the conversation at the agent's next step (or when the turn
 * ends), unless it is taken back or sent right away, which interrupts the step in progress.
 */
export const OutboxMessage = z.object({ id: z.string(), parts: z.array(Part) });
export type OutboxMessage = z.infer<typeof OutboxMessage>;

export const CodespaceMachine = z.object({ name: z.string(), displayName: z.string(), cpus: z.number(), memoryBytes: z.number() });
export type CodespaceMachine = z.infer<typeof CodespaceMachine>;

export const Todo = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  /** Present-tense label shown while in progress ("Running tests"). */
  activeForm: z.string().optional(),
});
export type Todo = z.infer<typeof Todo>;

/** A loop's schedule (`/loop`), for its card in Background tasks. */
export const LoopSchedule = z.object({
  intervalMs: z.number().int().positive(),
  /** How many times it has sent its prompt. */
  runs: z.number().int().nonnegative(),
  /** When it sends next; null once it has ended. */
  nextAt: z.number().nullable(),
  /** A run came due while the session was busy: it goes once the session is idle. */
  waiting: z.boolean(),
});
export type LoopSchedule = z.infer<typeof LoopSchedule>;

/**
 * Something a Code or Cowork session keeps going beside its turns, for the Background tasks pane: a command Bash
 * started with `run_in_background`, a sub-agent, or a loop (`/loop`). Kept in memory while the backend runs.
 */
export const BackgroundTask = z.object({
  id: z.string(),
  kind: z.enum(['command', 'agent', 'loop']),
  /** The command's description (or the command itself), the sub-agent's task, or the loop's prompt. */
  title: z.string(),
  /** Commands: what runs. */
  command: z.string().nullable(),
  /** Sub-agents: their own session, to follow what they do. */
  sessionId: z.string().nullable(),
  /** Sub-agents the model started with `run_in_background`: its turn went on without waiting for their report. */
  background: z.boolean(),
  /** Loops: how often they send their prompt, and when next. */
  loop: LoopSchedule.nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: z.enum(['running', 'done', 'failed', 'stopped']),
  /** Commands that ended on their own: the exit code. */
  exitCode: z.number().int().nullable(),
});
export type BackgroundTask = z.infer<typeof BackgroundTask>;

const Tokens = z.number().int().nonnegative();

/** What fills a session's context window (ARCHITECTURE §8), in tokens: exact where the provider counted, estimated since. */
export const ContextUsage = z.object({
  used: Tokens,
  limit: z.number().int().positive(),
  /** Auto-compaction starts above this: `autoCompactAt` of the window, less room for the reply. */
  threshold: Tokens,
  /** Adds up to `used`. */
  categories: z.object({ systemPrompt: Tokens, systemTools: Tokens, mcpTools: Tokens, skills: Tokens, messages: Tokens }),
  /** Characters per token observed for this model (4 until usage reports calibrate it), for live estimates. */
  charsPerToken: z.number().positive(),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

/** Tokens a session (and its sub-agents) used so far, for the context popover. */
export const SessionUsage = z.object({
  requests: Tokens,
  input: Tokens,
  output: Tokens,
  cacheRead: Tokens,
  cacheWrite: Tokens,
  /** Null when no request had a price. */
  costUsd: z.number().nonnegative().nullable(),
  /** Of the last reply that reported its speed. */
  tokensPerSecond: z.number().nonnegative().nullable(),
});
export type SessionUsage = z.infer<typeof SessionUsage>;

/**
 * Before a local model's first output token: its server is loading the model into memory (`loading`), or has it and
 * is reading the prompt (`reading`). Hosted providers report neither.
 */
/** What a run waits on before its first output: a model server loading or reading, or a codespace being woken. */
export const RunPhase = z.enum(['loading', 'reading', 'waking', 'retrying', 'quiet', 'thinking']);
export type RunPhase = z.infer<typeof RunPhase>;

export const SessionSnapshot = z.object({
  session: SessionSummary,
  /** Messages on the active branch, root → head. */
  messages: z.array(Message),
  /** For each message on the branch: sibling ids (including itself) in creation order, for ‹ 2/3 › switching. */
  siblings: z.record(z.string(), z.array(z.string())),
  /** The assistant message currently streaming, if any (already included in `messages`). */
  streamingMessageId: z.string().nullable(),
  pending: PendingInteraction.nullable(),
  todos: z.array(Todo),
  /** Background commands, sub-agents and loops, newest last. */
  tasks: z.array(BackgroundTask),
  /** The recent output of tool calls still running, by call id. */
  toolOutput: z.record(z.string(), z.string()),
  context: ContextUsage.nullable(),
  /** The conversation is being summarized right now. */
  compacting: z.boolean(),
  /** The next request waits for the model's server, with this many requests (or sub-agents) ahead of it. */
  queued: z.number().int().nonnegative().nullable(),
  /** What a local model server is doing before the reply's first token (RunPhase), null otherwise. */
  phase: RunPhase.nullable(),
  retryAttempt: z.number().int().min(1).max(10).optional(),
  /** Messages sent while the agent worked that it hasn't taken yet, oldest first. */
  outbox: z.array(OutboxMessage),
  seq: z.number().int().nonnegative(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshot>;

/** Streaming deltas address a part by index within the message. */
export const RunEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: Message }),
  z.object({
    type: z.literal('delta'),
    messageId: z.string(),
    index: z.number().int().nonnegative(),
    kind: z.enum(['text', 'thinking', 'tool_input']),
    text: z.string(),
  }),
  z.object({ type: z.literal('part'), messageId: z.string(), index: z.number().int().nonnegative(), part: Part }),
  z.object({
    type: z.literal('done'),
    messageId: z.string(),
    usage: Usage.nullable(),
    stopReason: z.string().nullable(),
    error: MessageError.nullable(),
  }),
  z.object({ type: z.literal('status'), status: SessionStatus }),
  z.object({ type: z.literal('context'), context: ContextUsage }),
  z.object({ type: z.literal('title'), title: z.string() }),
  z.object({ type: z.literal('artifact'), artifact: z.lazy(() => ArtifactSummary) }),
  /** Summarizing started (true) or ended (false, after `compacted` when it worked). */
  z.object({ type: z.literal('compacting'), active: z.boolean() }),
  z.object({ type: z.literal('compacted'), summaryMessageId: z.string() }),
  /** Waiting for a turn on the model's server with this many ahead (requests, or sub-agents), or no longer (null). */
  z.object({ type: z.literal('queued'), ahead: z.number().int().nonnegative().nullable() }),
  /** The model server is loading the model or reading the prompt (RunPhase), or the reply started or ended (null). */
  z.object({ type: z.literal('phase'), phase: RunPhase.nullable(), retryAttempt: z.number().int().min(1).max(10).optional() }),
  /** The messages sent while the agent worked and not yet taken changed (one was queued, delivered, taken back). */
  z.object({ type: z.literal('outbox'), items: z.array(OutboxMessage) }),
  z.object({ type: z.literal('todos'), todos: z.array(Todo) }),
  /** The session's background commands, sub-agents and loops changed (one started, ended, was stopped or ran). */
  z.object({ type: z.literal('tasks'), tasks: z.array(BackgroundTask) }),
  /** Live output of a running tool call (Bash). Not stored: the tool result carries the final output. */
  z.object({ type: z.literal('tool_output'), messageId: z.string(), callId: z.string(), text: z.string() }),
  /** The run waits for the person (permission prompt, question) or stopped waiting (null). */
  z.object({ type: z.literal('pending'), pending: PendingInteraction.nullable() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const WorkspaceSummary = z.object({
  id: z.string(),
  kind: z.enum(['local', 'ssh', 'codespace']),
  name: z.string(),
  root: z.string(),
  /** SSH workspaces: the host as `ssh` knows it; codespaces: the codespace's name. */
  host: z.string().nullable(),
  deviceId: z.string().nullable(),
  /** Whether its machine can run tools right now (the device is online, or it is this backend's machine). */
  available: z.boolean(),
  /**
   * A folder Atelier made, empty, for one session started with no folder (`sessions.create` with `scratch`). It isn't
   * one of the person's folders: the folder menu's Recent and Settings › Folders leave it out.
   */
  scratch: z.boolean(),
  /**
   * Whether the person answered "Trust this workspace?" for it. Until they do, the backend ignores what the folder brings
   * itself: its settings files (permission rules, hooks), instruction files, skills, commands and agents. A folder on a
   * computer or an SSH host is trusted when it is added (the desktop app asks first); a codespace's only when the call that
   * adds it, or `workspaces.trust`, says the person agreed. Absent from a server that predates it (it applies everything).
   */
  trusted: z.boolean().optional(),
  lastUsedAt: z.number(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  /** Pinned projects are listed under "Pinned" in the sidebar, newest pin first. */
  pinnedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof Project>;

export const FileRef = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  blob: z.string(),
  kind: z.enum(['upload', 'generated', 'output', 'project']),
  tokens: z.number().int().nonnegative().nullable(),
  createdAt: z.number(),
});
export type FileRef = z.infer<typeof FileRef>;

/** Token budget for a project's files in the system prompt of each new chat. */
export const PROJECT_FILE_BUDGET_TOKENS = 60_000;

/**
 * The project files that go into the system prompt: in upload order, every file whose text still
 * fits the remaining budget. Files without extractable text (`tokens` null) are never included.
 */
export function projectFilesInPrompt<F extends Pick<FileRef, 'tokens'>>(files: readonly F[], budget = PROJECT_FILE_BUDGET_TOKENS): F[] {
  const included: F[] = [];
  let left = budget;
  for (const file of files) {
    if (file.tokens === null || file.tokens > left) continue;
    left -= file.tokens;
    included.push(file);
  }
  return included;
}

export const ArtifactType = z.enum(['html', 'react', 'svg', 'mermaid', 'markdown', 'code']);
export type ArtifactType = z.infer<typeof ArtifactType>;

/**
 * The identifier of the artifact that shows a workspace file (Code's `artifact` tool takes only the path), so showing
 * the same path again adds a version and the transcript finds the artifact from the call.
 */
export function artifactIdForPath(path: string): string {
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(-64).replace(/^-+|-+$/g, '');
  return slug || 'file';
}

export const ArtifactSummary = z.object({
  id: z.string(),
  sessionId: z.string(),
  identifier: z.string(),
  type: ArtifactType,
  title: z.string(),
  language: z.string().nullable(),
  version: z.number().int().positive(),
  versions: z.number().int().positive(),
  updatedAt: z.number(),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

/** An artifact on the Artifacts page, with the chat it came from (untitled chats have an empty title). */
export const ArtifactListItem = ArtifactSummary.extend({ sessionTitle: z.string() });
export type ArtifactListItem = z.infer<typeof ArtifactListItem>;

export const ArtifactVersion = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  content: z.string(),
  messageId: z.string().nullable(),
  createdAt: z.number(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

export const SecretSummary = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['api_key', 'token', 'mcp_oauth', 'github']),
  /** Masked tail, e.g. "••••3f9a". The plaintext never leaves the backend. */
  masked: z.string(),
  usedBy: z.array(z.string()),
  createdAt: z.number(),
  rotatedAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
});
export type SecretSummary = z.infer<typeof SecretSummary>;

export const SettingsSnapshot = z.object({
  /** Effective, defaults-applied settings. */
  effective: z.unknown(),
  /** Which layer each overridden path comes from, keyed by JSON path joined with "." */
  origins: z.record(z.string(), SettingsLayer),
  projectRoot: z.string().nullable(),
  errors: z.array(z.object({ layer: SettingsLayer, message: z.string() })),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

export const AppInfo = z.object({
  name: z.string(),
  version: z.string(),
  surface: z.enum(['desktop', 'web']),
  platform: z.string(),
  dataDir: z.string(),
  /**
   * A server: the device link version it speaks and the services it takes from desktop devices (ARCHITECTURE §21).
   * Absent on a desktop's own backend and on servers from before version 2.
   */
  deviceLink: z.object({ protocol: z.number(), services: z.array(z.string()) }).optional(),
});
export type AppInfo = z.infer<typeof AppInfo>;
