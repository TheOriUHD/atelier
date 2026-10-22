/**
 * Sub-agent definitions (ARCHITECTURE §8, §10): markdown files in `agents` folders whose frontmatter names the
 * agent, says when to use it and limits its tools and model; the body is its system prompt. The Agent tool
 * delegates to them by name, next to the built-in `general-purpose` agent.
 */
import type { Settings } from '@atelier/protocol';
import { frontmatter, skillBody, type ExtensionSource } from './skills.ts';

export interface AgentDef {
  name: string;
  description: string;
  /** The tools it may use; null for all of the parent's. */
  tools: string[] | null;
  disallowedTools: string[];
  /** A model ref, an alias (`opus`, `sonnet`, `haiku`, `fable`), or null/`inherit` for the parent's. */
  model: string | null;
  maxTurns: number | null;
  path: string;
  scope: ExtensionSource['scope'];
  location: ExtensionSource['location'];
}

export const GENERAL_PURPOSE = 'general-purpose';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function discoverAgents(sources: ExtensionSource[]): Promise<AgentDef[]> {
  const byName = new Map<string, AgentDef>();
  for (const { fs, location, scope, roots, plugin } of sources) {
    for (const root of roots) {
      for (const entry of (await fs.list(root).catch(() => [])).sort()) {
        if (!entry.endsWith('.md')) continue;
        const path = `${root}${fs.sep}${entry}`;
        const text = await fs.read(path).catch(() => null);
        if (text === null) continue;
        const def = parseAgent(text, entry.slice(0, -3));
        const name = def && (plugin ? `${plugin.name}:${def.name}` : def.name);
        if (def && name && name !== GENERAL_PURPOSE && !byName.has(name)) byName.set(name, { ...def, name, path, scope, location });
      }
    }
  }
  return [...byName.values()];
}

export function parseAgent(text: string, file: string): Omit<AgentDef, 'path' | 'scope' | 'location'> | null {
  const { data } = frontmatter(text);
  const name = typeof data.name === 'string' && NAME.test(data.name.trim()) ? data.name.trim() : NAME.test(file) ? file : null;
  const description = typeof data.description === 'string' ? data.description.trim().replace(/\s+/g, ' ') : '';
  if (!name || !description) return null;
  const tools = list(data.tools);
  const maxTurns = typeof data.maxTurns === 'number' && data.maxTurns > 0 ? Math.floor(data.maxTurns) : null;
  return {
    name,
    description,
    tools: tools.length && !tools.includes('*') ? tools : null,
    disallowedTools: list(data.disallowedTools),
    model: typeof data.model === 'string' && data.model.trim() && data.model.trim() !== 'inherit' ? data.model.trim() : null,
    maxTurns,
  };
}

/** `Read, Grep` or a YAML list. */
function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/** The model a definition runs on: aliases map through Settings › Admin › Models; unknown aliases and `inherit` keep the parent's. */
export function agentModel(def: AgentDef, aliases: Settings['models']['aliases'], parentModel: string | null): string | null {
  if (!def.model) return parentModel;
  if (def.model in aliases || ['opus', 'sonnet', 'haiku', 'fable'].includes(def.model)) return aliases[def.model as keyof typeof aliases] ?? parentModel;
  return def.model;
}

/** The definition's system prompt. */
export const agentPrompt = (text: string) => skillBody(text);
