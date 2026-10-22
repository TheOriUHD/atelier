/**
 * The compact tier's total budget (docs/PROMPTS.md §1.8). Local servers often run with a window of 4k–8k tokens, so
 * for compact-tier models the system prompt and the tools JSON together stay within 16,000 characters. Over that, the
 * prompt is trimmed in order until it fits: the skill list to names, connector tool descriptions to a line naming their
 * connector, then the instruction files, each cut at a line boundary. Every cut says how to get what was left out. The
 * core, the safeguards block, `<env>` and the administrator's instructions are never cut.
 */
import type { InstructionFile } from '../instructions/instructions.ts';
import type { SystemBlock, ToolDef } from '../providers/types.ts';
import { buildSystemPrompt, type PromptContext } from './builder.ts';

export const COMPACT_BUDGET_CHARS = 16_000;

export type Trim = 'skills' | 'connectors' | 'instructions';

export interface Fitted {
  blocks: SystemBlock[];
  /** Connector tools as the requests send them (and the snapshot freezes them). */
  mcpTools: ToolDef[];
  /** The steps that were needed, in order. */
  trimmed: Trim[];
}

interface Draft {
  ctx: PromptContext;
  tools: ToolDef[];
  blocks: SystemBlock[];
}

/** `tools` are all tool definitions as sent, connectors included; `skillNames` is the skill list without descriptions. */
export function fitCompactBudget(ctx: PromptContext, tools: ToolDef[], skillNames: string): Fitted {
  const size = (d: Draft) => d.blocks.reduce((n, b) => n + b.text.length, 0) + d.tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
  const read = ctx.tools.some((t) => t.name === 'Read');
  const steps: [Trim, (d: Draft) => Pick<Draft, 'ctx' | 'tools'>][] = [
    ['skills', (d) => ({ ctx: { ...d.ctx, skills: skillNames }, tools: d.tools })],
    ['connectors', (d) => ({ ctx: d.ctx, tools: d.tools.map(shortConnector) })],
    ['instructions', (d) => ({ ctx: { ...d.ctx, instructions: cutInstructions(d.ctx.instructions ?? [], size(d) - COMPACT_BUDGET_CHARS, read) }, tools: d.tools })],
  ];
  let draft: Draft = { ctx, tools, blocks: buildSystemPrompt(ctx) };
  const trimmed: Trim[] = [];
  for (const [name, step] of steps) {
    if (size(draft) <= COMPACT_BUDGET_CHARS) break;
    const next = step(draft);
    const built = { ...next, blocks: next.ctx === draft.ctx ? draft.blocks : buildSystemPrompt(next.ctx) };
    // A step that saves nothing (no skill list, short descriptions already) isn't taken.
    if (size(built) >= size(draft)) continue;
    draft = built;
    trimmed.push(name);
  }
  return { blocks: draft.blocks, mcpTools: draft.tools.filter(isConnector), trimmed };
}

const isConnector = (t: ToolDef) => t.name.startsWith('mcp__');

function shortConnector(tool: ToolDef): ToolDef {
  if (!isConnector(tool)) return tool;
  const line = `A ${tool.name.split('__')[1]} connector tool. Its description was left out to save room.`;
  return line.length < tool.description.length ? { ...tool, description: line } : tool;
}

/**
 * Takes `excess` characters out of the files below the administrator's, in proportion to their length. Each keeps its
 * beginning up to a line boundary and ends with where the rest is.
 */
function cutInstructions(files: InstructionFile[], excess: number, read: boolean): InstructionFile[] {
  const note = (f: InstructionFile) => (read ? `[Shortened to save room. Read \`${f.path}\` for the rest.]` : `[Shortened to save room. The rest is in \`${f.path}\`.]`);
  // The administrator's text ranks first, and a file not even twice as long as its note saves too little to lose it.
  const pool = files.filter((f) => f.kind !== 'system' && f.content.length > 2 * (note(f).length + 1));
  const total = pool.reduce((n, f) => n + f.content.length, 0);
  const keep = Math.max(0, total - excess - pool.reduce((n, f) => n + note(f).length + 1, 0));
  return files.map((f) => {
    if (!pool.includes(f)) return f;
    const end = f.content.lastIndexOf('\n', Math.floor((f.content.length * keep) / total));
    return { ...f, content: `${end > 0 ? f.content.slice(0, end) : ''}\n${note(f)}`.trim() };
  });
}
