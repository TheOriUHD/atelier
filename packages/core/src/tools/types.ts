import type { EditPlace, GeneratedImageMeta, ImagePart, Mode, PromptTier, RunEvent, TextPart } from '@atelier/protocol';
import type { JsonSchema } from '../providers/types.ts';

export interface ToolContext {
  sessionId: string;
  /** The assistant message that issued the call. */
  messageId: string;
  callId: string;
  signal: AbortSignal;
  emit(event: RunEvent): void;
}

export interface ToolOutput {
  content: (TextPart | ImagePart)[];
  isError?: boolean;
  /** What the transcript shows about generated images; the model only gets `content`. */
  generated?: GeneratedImageMeta[];
  /** The image SaveImage wrote, for the transcript's thumbnail. */
  saved?: { blob: string; mime: string };
  /** Where an Edit landed, for the transcript's line numbers. */
  edit?: EditPlace;
}

/** What a built-in tool's description depends on: it is a pure function of these, so the tools JSON stays byte-stable. */
export interface DescribeContext {
  tier: PromptTier;
  mode: Mode;
  /** Whether the session offers another tool, so a description only names tools that exist. */
  has(name: string): boolean;
}

export interface Tool<Input = unknown> {
  name: string;
  description: string | ((ctx: DescribeContext) => string);
  inputSchema: JsonSchema;
  /** Read-only tools may run in parallel and are allowed in plan mode. */
  readOnly: boolean;
  /** Changes something, but several calls may still run at once (their server's queue keeps order). */
  concurrent?: boolean;
  /** Built-in core tools: an input with placeholder values, shown as the example call in compact-tier prompts. */
  compactExample?: Record<string, unknown>;
  /** A shorter schema for compact-tier models, whose prompt and tools have a budget. */
  compactSchema?: JsonSchema;
  run(input: Input, ctx: ToolContext): Promise<ToolOutput>;
}

/** A tool whose description is text, as a request sends it. */
export type DescribedTool = Tool & { description: string };

export function describeTool(tool: Tool, ctx: DescribeContext): DescribedTool {
  const sized = ctx.tier === 'compact' && tool.compactSchema ? { ...tool, inputSchema: tool.compactSchema } : tool;
  return typeof sized.description === 'string' ? (sized as DescribedTool) : { ...sized, description: sized.description(ctx) };
}

/**
 * Built-in tools in the order every request lists them, so the tools array (the start of the provider's cache prefix)
 * is the same for every session with the same tool set. Connector tools follow, sorted by name.
 */
export const BUILTIN_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'TaskStop', 'ChangeDirectory', 'TodoWrite', 'AskUser', 'Agent', 'SendMessage', 'ListSessions', 'Time', 'Usage', 'Skill', 'ExitPlanMode', 'WebSearch', 'WebFetch', 'AddConnector', 'ComputerAccess', 'ComputerApps', 'OpenApp', 'Screenshot', 'FullControl', 'ComputerAction', 'Browser', 'MemorySearch', 'MemoryView', 'MemoryUpdate', 'ChatSearch', 'ChatRead', 'artifact', 'Preview', 'inline_visual', 'GenerateImage', 'SaveImage', 'GenerateVideo', 'SaveVideo', 'GenerateAudio', 'SaveAudio'] as const;

export function orderTools<T extends Pick<Tool, 'name'>>(tools: T[]): T[] {
  const rank = (name: string) => {
    const i = (BUILTIN_TOOLS as readonly string[]).indexOf(name);
    return i < 0 ? BUILTIN_TOOLS.length : i;
  };
  return [...tools].sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function textOutput(text: string, isError = false): ToolOutput {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
