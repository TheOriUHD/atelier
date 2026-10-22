/**
 * Claude Code permission rule syntax: `Tool` or `Tool(specifier)`.
 *   Bash(npm test)  Bash(npm run *)  Bash(git status:*)   exact, wildcard, legacy prefix
 *   Read(./src/**)  Edit(//etc/hosts)  Read(~/.zshrc)  Edit(/docs/**)   gitignore-style paths
 *   WebFetch(domain:example.com)   Agent(reviewer)   Skill(pdf)   mcp__server   mcp__server__tool   mcp__server__*
 */
import { posix } from 'node:path';
import { pathOps, type PathFlavor } from '../paths.ts';

export interface Rule {
  source: string;
  tool: string;
  specifier: string | null;
}

export interface MatchContext {
  cwd: string;
  home: string;
  /** Root that `/path` rules are relative to (the project), when there is one. */
  projectRoot: string | null;
  /** Which platform's paths these are: this machine's unless a test says otherwise. */
  flavor?: PathFlavor;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Rule tool names that cover several tools, as in Claude Code. */
const FAMILIES: Record<string, string[]> = {
  Edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  Read: ['Read', 'Glob', 'Grep'],
  Agent: ['Agent', 'Task'],
  Task: ['Agent', 'Task'],
};

export function parseRule(source: string): Rule | null {
  const m = /^\s*([A-Za-z_][\w-]*(?:__[\w-]+(?:__[\w*-]+)?)?)\s*(?:\((.*)\))?\s*$/s.exec(source);
  if (!m) return null;
  return { source, tool: m[1]!, specifier: m[2] === undefined || m[2] === '' ? null : m[2] };
}

export function ruleMatches(rule: Rule, call: ToolCall, ctx: MatchContext): boolean {
  if (rule.tool.startsWith('mcp__')) return matchMcp(rule.tool, call.name);
  const family = FAMILIES[rule.tool] ?? [rule.tool];
  if (!family.includes(call.name)) return false;
  if (rule.specifier === null) return true;
  const spec = rule.specifier;
  switch (rule.tool) {
    case 'Bash':
      return typeof call.input.command === 'string' && bashMatches(spec, call.input.command.trim());
    case 'Read':
    case 'Edit': {
      const path = callPath(call, ctx);
      return path !== null && pathMatches(spec, path, ctx);
    }
    case 'WebFetch': {
      const domain = /^domain:(.+)$/.exec(spec)?.[1]?.toLowerCase();
      if (!domain || typeof call.input.url !== 'string') return false;
      const host = URL.parse(call.input.url)?.hostname.toLowerCase();
      return !!host && (host === domain || host.endsWith(`.${domain}`));
    }
    case 'Agent':
    case 'Task':
      return call.input.subagent_type === spec;
    case 'Skill':
      return call.input.skill === spec || (typeof call.input.skill === 'string' && call.input.skill.endsWith(`:${spec}`));
    default:
      return false;
  }
}

function matchMcp(ruleTool: string, name: string): boolean {
  if (!name.startsWith('mcp__')) return false;
  if (ruleTool.endsWith('__*')) return name.startsWith(ruleTool.slice(0, -1));
  // `mcp__server` covers every tool of that server.
  return name === ruleTool || (ruleTool.split('__').length === 2 && name.startsWith(`${ruleTool}__`));
}

/**
 * `cmd:*` (legacy) means `cmd *`, as in Claude Code; `*` elsewhere is a wildcard; a trailing ` *` also matches the bare
 * command (`Bash(ls *)` allows `ls`), but the space keeps a word boundary (`ls *` never matches `lsof`).
 */
export function bashMatches(spec: string, command: string): boolean {
  const legacy = /^(.*):\*$/s.exec(spec);
  if (legacy) return bashMatches(`${legacy[1]!} *`, command);
  if (!spec.includes('*')) return command === spec;
  if (spec.endsWith(' *') && command === spec.slice(0, -2)) return true;
  const re = new RegExp(`^${spec.split('*').map(escapeRegExp).join('.*')}$`, 's');
  return re.test(command);
}

/** The file a call touches, absolute; Glob/Grep without a path act on the cwd. */
function callPath(call: ToolCall, ctx: MatchContext): string | null {
  const raw = call.input.file_path ?? call.input.path ?? call.input.notebook_path;
  if (typeof raw !== 'string') return call.name === 'Glob' || call.name === 'Grep' ? ctx.cwd : null;
  return pathOps(ctx.flavor).absolute(raw, ctx.cwd);
}

/**
 * gitignore-style path patterns anchored per Claude Code: `//abs`, `~/home`, `/project`, `./cwd` or bare. The path and
 * the folders the pattern hangs from are compared in one form (paths.ts `key`: `/` separators, folded to lower case on
 * Windows), so `C:\work\app\.env` and `C:/work/app/.env` are the same file to a rule.
 */
export function pathMatches(spec: string, path: string, ctx: MatchContext): boolean {
  const ops = pathOps(ctx.flavor);
  // On Windows a pattern may be written with backslashes too.
  const written = ops.flavor === 'win32' ? spec.replace(/\\/g, '/') : spec;
  const target = ops.key(path);
  let base: string;
  let pattern: string;
  if (written.startsWith('//')) [base, pattern] = ['', written.slice(2)];
  else if (written === '~' || written.startsWith('~/')) [base, pattern] = [ops.key(ctx.home), written.slice(2)];
  else if (written.startsWith('/')) [base, pattern] = [ops.key(ctx.projectRoot ?? ctx.cwd), written.slice(1)];
  else [base, pattern] = [ops.key(ctx.cwd), written.replace(/^\.\//, '')];
  // `//C:/Users/me/x` names a Windows path as it is; `//etc/hosts` is /etc/hosts.
  const absolute = base === '' && /^[a-zA-Z]:/.test(pattern);
  const root = absolute ? pattern : base === '' ? `/${pattern}` : pattern ? posix.join(base, pattern) : base;
  const full = ops.flavor === 'win32' ? root.toLowerCase() : root;
  // A pattern without a slash and without anchoring matches that name at any depth below the base.
  const anywhere = !written.startsWith('/') && !written.startsWith('~') && !written.startsWith('./') && !pattern.includes('/');
  const re = globToRegExp(anywhere ? posix.join(base, '**', ops.flavor === 'win32' ? pattern.toLowerCase() : pattern) : full);
  // A plain directory pattern also covers everything inside it.
  return re.test(target) || (!/[*?[]/.test(pattern) && target.startsWith(`${full.replace(/\/$/, '')}/`));
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `/**/` matches zero or more directories; a trailing `**` matches everything below.
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
