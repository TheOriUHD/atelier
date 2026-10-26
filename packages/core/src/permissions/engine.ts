/**
 * Permission decision for one tool call, before hooks (ARCHITECTURE §8):
 *   deny rules → ask rules → allow rules → mode default,
 * with compound Bash commands checked part by part and dangerous commands always prompting outside Bypass.
 * In Auto mode what would prompt goes to a reviewing model instead (`review`, permissions/auto-mode.ts), except ask
 * rules and deletions outside the workspace, which still ask the person.
 */
import { tmpdir } from 'node:os';
import { pathOps, type PathFlavor } from '../paths.ts';
import { commandWord, splitCommand, words } from './bash.ts';
import { dangerousReason } from './dangerous.ts';
import { parseRule, ruleMatches, type MatchContext, type Rule, type ToolCall } from './rules.ts';
import { credentialPath } from './sensitive.ts';

import type { PermissionMode } from '@atelier/protocol';

export interface RuleSet {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface PermissionContext extends MatchContext {
  mode: PermissionMode;
  rules: RuleSet;
  /** Workspace roots (the runner's); file access outside them prompts. */
  roots: string[];
  /** Tools that never change anything (Read, Glob, Grep, …); for MCP tools only the server's untrusted hint. */
  isReadOnly(tool: string): boolean;
  /** Whether the session offers a tool, so a refusal points only to tools it has (sub-agents lack ExitPlanMode); every tool when absent. */
  offers?(tool: string): boolean;
}

export interface Decision {
  behavior: 'allow' | 'ask' | 'deny' | 'review';
  /** Shown in the prompt or returned to the model on deny. */
  reason: string;
  /** The rule that decided, when one did. */
  rule?: string;
  /** Red warning for dangerous commands. */
  warning?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Folders and files whose edits change how git, shells, editors or the agent itself behave: never auto-approved. */
const PROTECTED_DIRS = new Set(['.git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.claude', '.atelier']);
const PROTECTED_FILES =
  /^(\.gitconfig|\.gitmodules|\.bash(rc|_profile|_login|_aliases|_logout)|\.z(shrc|profile|shenv|login|logout)|\.profile|\.envrc|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|\.?bunfig\.toml|\.pre-commit-config\.yaml|\.?lefthook\.ya?ml|\.devcontainer\.json|\.mcp\.json|\.claude\.json)$/;
/** Allow rules that would let Auto mode run any code unreviewed: the whole shell, an interpreter, any sub-agent. */
const BROAD_RULE = /^(Bash|PowerShell)(\((\*|:\*|(python3?|node|ruby|perl|php|bash|sh|zsh|deno|bun|npx|pnpx|bunx|uv run|(npm|pnpm|yarn|bun) run)[ :]?\*)\))?$|^(Agent|Task)$/;
/** Tools that only touch the session itself (an artifact is the app's data, not the workspace's): allowed in plan mode too. */
const PLAN_TOOLS = new Set(['ExitPlanMode', 'TodoWrite', 'AskUser', 'artifact', 'inline_visual']);
/**
 * Tools that always ask the person themselves, with their own card: no second, generic prompt in front (a `path` that
 * is outside the workspace is ChangeDirectory's point; AddConnector adds to the person's setup).
 */
const ASKS_ITSELF = new Set(['ChangeDirectory', 'AddConnector', 'ComputerAccess', 'FullControl']);
/**
 * Computer use's actions: what they may do is decided on the computer, by the apps the person allowed there and at which
 * tier (apps/desktop/src/computer/), not by a prompt per click. Plan mode still refuses the ones that act.
 */
const GRANT_GATED = new Set(['Screenshot', 'ComputerApps', 'OpenApp', 'ComputerAction']);
/** Where a command's deletions are ordinary scratch work in Auto mode (never the folders themselves, never a glob). */
const SCRATCH_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];
/** Generated or disposable folders and files: clearing them is routine cleanup, however many at once, however often. */
const DISPOSABLE = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite', '.output',
  'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', 'coverage', '.nyc_output', '.gradle',
  'tmp', 'temp', '.DS_Store', 'test-results', 'playwright-report',
]);

export function decide(call: ToolCall, ctx: PermissionContext): Decision {
  const parse = (list: string[]) => list.map(parseRule).filter((r): r is Rule => r !== null);
  const deny = parse(ctx.rules.deny);
  const ask = parse(ctx.rules.ask);
  const auto = ctx.mode === 'auto';
  const allow = parse(auto ? ctx.rules.allow.filter((r) => !BROAD_RULE.test(r.trim())) : ctx.rules.allow);
  const bypass = ctx.mode === 'bypassPermissions';
  // What would prompt in another mode: in Auto the reviewing model decides instead.
  const unsure = auto ? 'review' : 'ask';

  // Bash: every simple command in a compound line is checked on its own.
  const isBash = call.name === 'Bash' && typeof call.input.command === 'string';
  const { parts, allow: allowGroups, opaque } = isBash ? splitCommand(call.input.command as string) : { parts: [], allow: [], opaque: null };
  const bashUnit = (command: string): ToolCall => ({ name: 'Bash', input: { ...call.input, command } });
  const units: ToolCall[] = isBash ? [call, ...parts.map(bashUnit)] : [call];
  const firstMatch = (rules: Rule[], subjects: ToolCall[]) => rules.find((r) => subjects.some((u) => ruleMatches(r, u, ctx)));

  const denied = firstMatch(deny, units);
  if (denied) return { behavior: 'deny', reason: `Blocked by the rule ${denied.source}.`, rule: denied.source };

  const warning =
    isBash && !bypass ? dangerousReason(call.input.command as string, { cwd: ctx.cwd, home: ctx.home, roots: ctx.roots, ...(ctx.flavor ? { flavor: ctx.flavor } : {}), ...(auto ? { scratch: [...SCRATCH_DIRS, tmpdir()] } : {}) }) : null;
  // Deleting outside the workspace asks the person even in Auto mode: a model's slip there can't be undone.
  const critical = auto && !!warning && /deletes .*, outside the workspace$/.test(warning);
  const warned = (d: Decision): Decision =>
    warning ? { behavior: critical ? 'ask' : unsure, reason: `This command ${warning}.`, warning, ...(d.rule ? { rule: d.rule } : {}) } : d;

  if (ctx.mode === 'plan' && !ctx.isReadOnly(call.name) && !PLAN_TOOLS.has(call.name) && !ASKS_ITSELF.has(call.name)) return { behavior: 'deny', reason: planRefusal(ctx.offers ?? (() => true)) };

  const asked = firstMatch(ask, units);
  if (asked) return warned({ behavior: 'ask', reason: `The rule ${asked.source} asks before this runs.`, rule: asked.source });

  if (opaque && !bypass) return warned({ behavior: unsure, reason: `This command uses ${opaque}.` });

  // Allow rules: for Bash, every simple command must be allowed on its own (in one of its forms: `time npm test` by
  // `Bash(time *)` or `Bash(npm test *)`), and so must what `find -exec`, `xargs` or `sh -c` run. Never match the
  // whole line: `Bash(npm test *)` must not approve `npm test && rm -rf ~`.
  const allowRule = (u: ToolCall) => allow.find((r) => ruleMatches(r, u, ctx));
  const perPart = isBash ? allowGroups.map((forms) => forms.map((form) => allowRule(bashUnit(form))).find(Boolean)) : [allowRule(call)];
  const allowed = perPart.length > 0 && perPart.every(Boolean) ? perPart[0] : undefined;
  if (allowed) return warned({ behavior: 'allow', reason: `Allowed by the rule ${allowed.source}.`, rule: allowed.source });

  if (bypass) return { behavior: 'allow', reason: 'Bypass mode.' };

  // Auto mode: removing build output, caches and temp files is cleanup, not a mass deletion to worry about.
  if (auto && isBash && !opaque && !warning && routineCleanup(parts, ctx)) return { behavior: 'allow', reason: 'Auto mode: clearing generated or temporary files.' };

  if (ASKS_ITSELF.has(call.name)) return { behavior: 'allow', reason: 'It asks the person itself.' };
  if (GRANT_GATED.has(call.name)) return { behavior: 'allow', reason: 'Decided by the apps allowed on this computer.' };

  // A connector describes its own tools: a read-only hint lets a call into plan mode but never skips the prompt,
  // and its paths are the server's, not the workspace's.
  const connector = call.name.startsWith('mcp__');
  const outside = connector ? null : outsideRoots(call, ctx);
  if (outside) {
    // Auto mode: looking at a file elsewhere on the machine is ordinary work. Credentials, keys and private data still
    // go to the reviewer, and so does anything that writes (below the reviewer decides, as for edits in the workspace).
    if (auto && ctx.isReadOnly(call.name) && !EDIT_TOOLS.has(call.name)) {
      const why = credentialPath(outside);
      return why
        ? { behavior: 'review', reason: `${call.name} reads ${outside}, which holds ${why}.` }
        : { behavior: 'allow', reason: 'Auto mode: reading a file outside the workspace.' };
    }
    return { behavior: unsure, reason: `${call.name} wants to access ${outside}, outside the workspace.` };
  }

  if ((ctx.isReadOnly(call.name) && !connector) || PLAN_TOOLS.has(call.name)) return warned({ behavior: 'allow', reason: 'Read-only.' });
  if (ctx.mode === 'acceptEdits' && EDIT_TOOLS.has(call.name)) return { behavior: 'allow', reason: 'Accept edits mode.' };
  if (auto && EDIT_TOOLS.has(call.name)) {
    const target = protectedTarget(call);
    return target ? { behavior: 'review', reason: `${call.name} changes ${target}, which configures tools or the agent itself.` } : { behavior: 'allow', reason: 'Auto mode: an edit in the workspace.' };
  }
  return warned({ behavior: unsure, reason: `${call.name} needs your approval.` });
}

/** Whether every command is `rm` (or `cd`) and only removes disposable folders in the workspace or things below a temp folder. */
function routineCleanup(parts: string[], ctx: PermissionContext): boolean {
  if (parts.length === 0) return false;
  const scratch = [...SCRATCH_DIRS, tmpdir()];
  const ops = pathOps(ctx.flavor);
  let removes = false;
  for (const part of parts) {
    const cmd = commandWord(part);
    if (cmd === 'cd') continue;
    if (cmd !== 'rm') return false;
    const all = words(part);
    const targets = all.slice(all.indexOf(cmd) + 1).filter((a) => !a.startsWith('-'));
    if (targets.length === 0 || targets.some((t) => /[*?[$`]/.test(t))) return false;
    for (const target of targets) {
      const expanded = target === '~' || target.startsWith('~/') ? ctx.home + target.slice(1) : target;
      const abs = ops.absolute(expanded, ctx.cwd);
      if (scratch.some((dir) => ops.below(abs, dir))) continue;
      const root = ctx.roots.find((r) => ops.below(abs, r));
      if (!root || !ops.relative(abs, root)!.split('/').some((s) => DISPOSABLE.has(ops.flavor === 'win32' ? s.toLowerCase() : s))) return false;
    }
    removes = true;
  }
  return removes;
}

/** What still works in plan mode and how it ends, naming only tools the session has. */
function planRefusal(offers: (tool: string) => boolean): string {
  const works = ['Reading', 'searching', ...(offers('WebSearch') || offers('WebFetch') ? ['the web tools'] : []), ...(offers('Agent') ? ['sub-agents'] : [])];
  const next = offers('ExitPlanMode') ? 'present your plan with ExitPlanMode to start making changes' : 'describe the changes you would make instead of making them';
  return `Plan mode is on, so this can't run yet. ${works.slice(0, -1).join(', ')} and ${works.at(-1)} still work; ${next}.`;
}

/**
 * For sessions without a workspace (Chat): their own tools only touch the app's data or read the web, so only
 * connector (`mcp__…`) tools are gated, by the `mcp__` rules among `rules`.
 */
export function connectorContext(rules: RuleSet, home: string): PermissionContext {
  const connector = (list: string[]) => list.filter((r) => r.startsWith('mcp__'));
  return {
    mode: 'default',
    rules: { allow: connector(rules.allow), ask: connector(rules.ask), deny: connector(rules.deny) },
    cwd: home,
    home,
    projectRoot: null,
    roots: [],
    isReadOnly: (name) => !name.startsWith('mcp__'),
  };
}

/** The protected folder or file an edit touches, if any. */
function protectedTarget(call: ToolCall): string | null {
  const raw = call.input.file_path ?? call.input.notebook_path;
  if (typeof raw !== 'string') return null;
  const segments = raw.split(/[\\/]/);
  const name = segments.at(-1) ?? '';
  const dir = segments.slice(0, -1).find((s) => PROTECTED_DIRS.has(s));
  return dir ? `${dir}/` : PROTECTED_FILES.test(name) ? name : null;
}

/** The absolute path a file tool's call works on when it is outside the workspace's roots, or null. */
export function outsideRoots(call: ToolCall, ctx: Pick<PermissionContext, 'cwd' | 'roots' | 'flavor'>): string | null {
  const raw = call.input.file_path ?? call.input.path ?? call.input.notebook_path;
  if (typeof raw !== 'string') return null;
  const ops = pathOps(ctx.flavor);
  const abs = ops.absolute(raw, ctx.cwd);
  return ctx.roots.some((root) => ops.within(abs, root)) ? null : abs;
}

/** The tools a chat gets in its sandbox. */
export const SANDBOX_TOOLS = new Set(['Bash', 'Read']);

/**
 * A chat's sandbox runs under fixed rules, never a prompt: reads stay in its folder, dangerous commands are refused
 * with their reason, and other commands run. Where nothing confines commands to the folder (no OS sandbox), the
 * auto mode reviewer judges them instead.
 */
export function sandboxDecide(call: ToolCall, sandbox: { root: string; home: string; confined: boolean; flavor?: PathFlavor }): Decision {
  const ctx = { cwd: sandbox.root, home: sandbox.home, roots: [sandbox.root], ...(sandbox.flavor ? { flavor: sandbox.flavor } : {}) };
  if (call.name === 'Read') {
    const outside = outsideRoots(call, ctx);
    return outside
      ? { behavior: 'deny', reason: `Read works only inside this chat's sandbox folder (${sandbox.root}); ${outside} is outside it.` }
      : { behavior: 'allow', reason: 'Inside the sandbox.' };
  }
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  const danger = dangerousReason(command, ctx);
  if (danger) return { behavior: 'deny', reason: `The sandbox doesn't allow this: the command ${danger}.` };
  return sandbox.confined ? { behavior: 'allow', reason: 'Inside the sandbox.' } : { behavior: 'review', reason: 'A command in the chat sandbox.' };
}

/**
 * A call on a file or folder outside the project gets a rule for that folder (`Edit(//home/me/notes/**)`), never the
 * bare tool name, which would cover every path on the machine. Null for calls inside the project or without a path.
 */
function pathRule(call: ToolCall, ctx: MatchContext): string | null {
  const family = EDIT_TOOLS.has(call.name) ? 'Edit' : call.name === 'Read' || call.name === 'Glob' || call.name === 'Grep' ? 'Read' : null;
  const raw = call.input.file_path ?? call.input.path ?? call.input.notebook_path;
  if (!family || typeof raw !== 'string') return null;
  const ops = pathOps(ctx.flavor);
  const abs = ops.absolute(raw, ctx.cwd);
  if (ops.within(abs, ctx.projectRoot ?? ctx.cwd)) return null;
  const key = ops.key(abs).replace(/^\//, '');
  // Glob and Grep name the folder they search; the others name a file, so its folder is the scope.
  const folder = call.name === 'Glob' || call.name === 'Grep' ? key : key.slice(0, Math.max(0, key.lastIndexOf('/')));
  // A file at the root of a drive or of `/` has no folder to scope to: the file itself it is.
  return folder && !/^[a-z]:$/i.test(folder) ? `${family}(//${folder}/**)` : `${family}(//${key})`;
}

/** The rule offered by "Always allow" for a call that was approved once. */
export function suggestRule(call: ToolCall, ctx: MatchContext): string {
  if (call.name.startsWith('mcp__')) return call.name;
  if (call.name === 'Bash' && typeof call.input.command === 'string') {
    const first = splitCommand(call.input.command).parts[0] ?? call.input.command;
    const w = first.trim().split(/\s+/);
    // Tools whose first argument is a subcommand get a two-word prefix (`git status *`, `npm run *`).
    const prefix = /^(git|npm|pnpm|yarn|bun|cargo|go|docker|kubectl|gh|make|uv|pip|brew)$/.test(w[0]!) && w[1] && !w[1].startsWith('-') ? `${w[0]} ${w[1]}` : w[0]!;
    return `Bash(${prefix} *)`;
  }
  if (call.name === 'WebFetch' && typeof call.input.url === 'string') {
    const host = URL.parse(call.input.url)?.hostname;
    return host ? `WebFetch(domain:${host})` : 'WebFetch';
  }
  const outside = pathRule(call, ctx);
  if (outside) return outside;
  if (EDIT_TOOLS.has(call.name)) {
    const raw = call.input.file_path ?? call.input.notebook_path;
    if (typeof raw === 'string') {
      const ops = pathOps(ctx.flavor);
      const relative = ops.relative(ops.absolute(raw, ctx.cwd), ctx.projectRoot ?? ctx.cwd);
      if (relative !== null) {
        const dir = relative.split('/').slice(0, -1).join('/');
        return dir ? `Edit(/${dir}/**)` : 'Edit(/*)';
      }
    }
    return 'Edit';
  }
  if ((call.name === 'Agent' || call.name === 'Task') && typeof call.input.subagent_type === 'string') return `Agent(${call.input.subagent_type})`;
  if (call.name === 'Skill' && typeof call.input.skill === 'string') return `Skill(${call.input.skill})`;
  return call.name;
}
