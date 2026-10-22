/**
 * MCP connectors (ARCHITECTURE §9-B): servers in Claude Code's `mcpServers` shape, kept in the system settings
 * by admins, their live status, and the desktop's import from Claude Code.
 */
import { z } from 'zod';

export const McpServerName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'Use up to 64 letters, digits, - and _.');

export const McpTransport = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransport>;

/**
 * One server. `env`, `headers` and `url` may reference `${secret:<id>}` and `${ENV}`; they are resolved only when
 * connecting. stdio servers run only where the backend may start programs (the desktop app). An HTTP or SSE server
 * with `auth: 'oauth'` is signed in once by an admin; the backend keeps its tokens and uses them for every session.
 */
export const McpServerConfig = z
  .object({
    type: McpTransport.default('stdio'),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    /** The server's own names of tools that never reach a model. */
    disabledTools: z.array(z.string()).default([]),
    /** The catalog entry it was set up from (`cloudflare`, `github`, …). */
    preset: z.string().optional(),
    /** Sign in with OAuth instead of sending a token in `headers`. */
    auth: z.literal('oauth').optional(),
  })
  .refine((s) => (s.type === 'stdio' ? !!s.command : !!s.url), { message: 'stdio servers need a command; http and sse servers need a url.' })
  .refine((s) => s.type !== 'stdio' || !s.auth, { message: 'Only http and sse servers can sign in with OAuth.' });
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** Regular users get names, states and enabled tool names only; admins also see descriptions, errors and the era. */
export const McpServerStatus = z.object({
  name: z.string(),
  type: McpTransport,
  state: z.enum(['connecting', 'ready', 'error', 'disabled']),
  error: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional(), readOnly: z.boolean(), enabled: z.boolean() })),
  /** `modern` is the stateless 2026-07-28 protocol, `legacy` the `initialize` handshake of earlier ones. */
  protocolEra: z.enum(['modern', 'legacy']).optional(),
  /** An OAuth server (state `error`) that has no usable sign-in: `needed` until an admin signs in, `waiting` while the sign-in page is open. */
  signIn: z.enum(['needed', 'waiting']).optional(),
});
export type McpServerStatus = z.infer<typeof McpServerStatus>;

/**
 * A Claude Code server converted for import. `secrets` are paths into `config` of literal credentials to move into
 * the secret store; `source` says where Claude Code keeps it (`~/.claude.json`, a project in it, or a `.mcp.json`).
 */
export const McpImportEntry = z.object({ name: McpServerName, config: McpServerConfig, secrets: z.array(z.array(z.string())), source: z.string() });
export type McpImportEntry = z.infer<typeof McpImportEntry>;

/**
 * The model-facing name of a server's tool, built as Claude Code builds it so its permission rules apply:
 * `mcp__<server>__<tool>`, other characters replaced by `_`, at most 64 characters.
 */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
