/**
 * Claude Code's connectors in Atelier's shape, for the desktop's import (ARCHITECTURE §9-B): the user's
 * (`~/.claude.json` → `mcpServers`), each project's there (`projects[path].mcpServers`), and the shared ones in
 * `.mcp.json` at the top of the given folders. `${VAR}` references already mean the same here; literal credentials
 * are flagged so the UI can offer to move them into the secret store. Nothing is written.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServerConfig, type McpImportEntry } from '@atelier/protocol';

/** Names of env vars, headers and query parameters that usually hold credentials. */
const CREDENTIAL_NAME = /token|key|secret|passw|credential|auth|pat$/i;
/** Prefixes of well-known token formats (OpenAI/Anthropic, GitHub, Slack, Linear, Notion, AWS, JWTs). */
const CREDENTIAL_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abpr]-|lin_api_|ntn_|secret_|AKIA|eyJ)/;

const readJson = (file: string): Promise<Record<string, unknown> | null> =>
  readFile(file, 'utf8').then(
    (t) => JSON.parse(t) as Record<string, unknown>,
    () => null,
  );

export async function importClaudeCode(home: string, folders: string[] = []): Promise<McpImportEntry[]> {
  const found: { servers: unknown; source: string }[] = [];
  const user = await readJson(join(home, '.claude.json')).catch(() => null);
  if (user) {
    found.push({ servers: user.mcpServers, source: '~/.claude.json' });
    for (const [path, project] of Object.entries((user.projects as Record<string, { mcpServers?: unknown }> | undefined) ?? {})) {
      found.push({ servers: project?.mcpServers, source: `~/.claude.json (${path})` });
    }
  }
  for (const folder of folders) {
    const file = join(folder, '.mcp.json');
    found.push({ servers: (await readJson(file).catch(() => null))?.mcpServers, source: file });
  }

  const entries: McpImportEntry[] = [];
  const taken = new Set<string>();
  for (const { servers, source } of found) {
    if (!servers || typeof servers !== 'object') continue;
    for (const [rawName, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as { type?: string; url?: string };
      // Claude Code leaves `type` out for stdio servers; websocket and SDK servers have no counterpart here.
      const parsed = McpServerConfig.safeParse({ ...entry, type: entry.type ?? (entry.url ? 'http' : 'stdio') });
      if (!parsed.success) continue;
      const config = parsed.data;
      const secrets = [
        ...Object.entries(config.env).flatMap(([k, v]) => (looksLikeCredential(k, v) ? [['env', k]] : [])),
        ...Object.entries(config.headers).flatMap(([k, v]) => (looksLikeCredential(k, v) ? [['headers', k]] : [])),
        ...([...(URL.parse(config.url ?? '')?.searchParams ?? [])].some(([k, v]) => looksLikeCredential(k, v)) ? [['url']] : []),
      ];
      // Projects often reuse a name; later ones get a number.
      const base = rawName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      taken.add(name);
      entries.push({ name, config, secrets, source });
    }
  }
  return entries;
}

function looksLikeCredential(name: string, value: string): boolean {
  if (value.length < 8 || value.includes('${')) return false;
  return CREDENTIAL_NAME.test(name) || CREDENTIAL_VALUE.test(value.replace(/^(Bearer|Basic|Token)\s+/i, ''));
}
