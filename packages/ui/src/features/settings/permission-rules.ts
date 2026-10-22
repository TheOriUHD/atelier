/**
 * Checks for permission list entries before they are saved. Rules use Claude Code's syntax, with the
 * grammar the backend parses (packages/core/src/permissions/rules.ts › parseRule): `Tool` or
 * `Tool(specifier)`, and `mcp__server` or `mcp__server__tool` for MCP tools.
 */
const RULE = /^([A-Za-z_][\w-]*(?:__[\w-]+(?:__[\w*-]+)?)?)\s*(?:\((.*)\))?$/s;

export const RULE_EXAMPLE = 'Bash(npm test *)';

/** Why `rule` can't be saved, or null when it is fine. */
export function ruleError(rule: string): string | null {
  const m = RULE.exec(rule);
  if (!m) return `Write a rule as Tool or Tool(specifier), like ${RULE_EXAMPLE}.`;
  const tool = m[1]!;
  // Tool names are case-sensitive: `bash(ls)` would never match anything.
  if (!tool.startsWith('mcp__') && !/^[A-Z]/.test(tool)) return 'Tool names start with a capital letter, like Bash, Read or WebFetch.';
  if (tool === 'WebFetch' && m[2] && !m[2].startsWith('domain:')) return 'WebFetch rules name a domain, like WebFetch(domain:example.com).';
  return null;
}

/** Additional directories are compared with absolute paths on the workspace's machine. */
export function directoryError(path: string): string | null {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? null : 'Use an absolute path, like /srv/shared or C:\\Shared.';
}
