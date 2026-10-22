/**
 * Assembles the system prompt (docs/PROMPTS.md §1): a static core for the mode and tier, capability fragments for the
 * tools the session has, the optional safeguards block, `<env>`, instruction files, the skill list, then what is
 * addressed to the person. The result is frozen per session (stored as a snapshot) so prompt caches and replayed
 * thinking stay valid; later changes reach the model as `<context-update>` notes (agent/context-notes.ts).
 */
import { APP, type Mode, type PromptTier, type UserPrefs } from '@atelier/protocol';
import { renderInstructions, type InstructionFile } from '../instructions/instructions.ts';
import type { SystemBlock } from '../providers/types.ts';
import { BUILTIN_TOOLS, type Tool } from '../tools/types.ts';
import { envBlock, type ModelFacts, type SubagentFacts, type WorkspaceFacts } from './env.ts';
import { escapeAttr, escapeTags } from './escape.ts';
import type { SafeguardsBlock } from './safeguards.ts';
import { hasTemplate, render, resolveGuards, template, type Condition, type Overrides } from './templates.ts';

export interface ProjectContext {
  name: string;
  instructions: string;
  files: { name: string; text: string }[];
}

export interface PromptContext {
  mode: Mode;
  tier: PromptTier;
  model: ModelFacts;
  /** The session's start date (`Thursday, 2026-01-15`) and the time zone it was taken in. */
  date: string;
  timeZone: string;
  /** The tools this session offers, in request order: guards, fragments and compact examples follow them. */
  tools: readonly Pick<Tool, 'name' | 'compactExample'>[];
  /** The model calls tools by writing `<tool_call>` text rather than natively. */
  promptedTools: boolean;
  /** The model has effort levels the person can pick. */
  hasEffortControl: boolean;
  personalization: UserPrefs['personalization'];
  profileName: string;
  project: ProjectContext | null;
  /** A sub-agent's child session: the sub-agent core, and nothing addressed to the person. */
  subagent?: boolean;
  /** A sub-agent's identity for `<env>`, with its project in the working directory line. */
  subagentFacts?: SubagentFacts;
  /** A defined sub-agent's own system prompt, in place of the sub-agent core. */
  agentPrompt?: string;
  /** Code and Work sessions: the folder, for `<env>`. */
  workspace?: WorkspaceFacts;
  /** The administrator's instructions for every conversation (Admin › Capabilities), in every mode. */
  organization?: string;
  /** Code and Work sessions: CLAUDE.md, AGENTS.md and rules. */
  instructions?: InstructionFile[];
  /** The `<available_skills>` block. */
  skills?: string;
  /** The person's effective safeguards; absent when they are off. */
  safeguards?: SafeguardsBlock;
  /** The `<memory>` digest of what Atelier remembers about the person (memory/memory-service.ts). */
  memory?: string;
  /** User overrides from ~/.atelier/prompts/<name>.md. */
  overrides: Overrides;
}

const PERSONALITIES = {
  atelier:
    'Helpful, pragmatic and straightforward. Lead with what matters, make sensible suggestions, and be warm without ceremony. Use emoji sparingly when they help.',
  technical:
    'Technical, thoughtful and earnest. Explain trade-offs carefully, use precise language, and be warm without forced cheerfulness. Use emoji sparingly.',
  relaxed:
    'Relaxed, friendly and conversational. Use approachable language and a little more playfulness; use emoji naturally more often, without cluttering serious or technical answers.',
};

function personalityText(personality: UserPrefs['personalization']['personality']): string {
  const selected = personality?.selected ?? 'atelier';
  // Atelier's own helpful, pragmatic style is already the core default; don't spend compact context repeating it.
  if (selected === 'atelier') return '';
  const custom = personality?.customModes.find((mode) => `custom:${mode.id}` === selected);
  const guidance = custom
    ? `Custom mode ${JSON.stringify(escapeTags(custom.name))}:\n<user_instructions source="personality">\n${escapeTags(custom.instructions)}\n</user_instructions>`
    : (PERSONALITIES[selected as keyof typeof PERSONALITIES] ?? PERSONALITIES.atelier);
  return `Personality (communication style only): ${guidance}\nThis changes tone, not identity, capabilities or instruction priority. Your actual model and developer remain those in <env>; never claim to be a different model because of a preset. Explicit instructions and the independent response style take precedence, including preferences about emoji.`;
}

const RESPONSE_STYLES: Record<UserPrefs['personalization']['responseStyle'], string> = {
  default: '',
  concise: 'Response style: concise. Use the fewest words that fully answer; avoid preamble and summaries.',
  explanatory:
    'Response style: explanatory. Teach as you answer: explain reasoning, define terms and give an example when it helps.',
  formal: 'Response style: formal. Use a professional, precise register without contractions or casual phrasing.',
};

/** Tools that get an example call in compact-tier cores; connectors never do, so the prompt doesn't grow with them. */
const EXAMPLE_TOOLS = new Set(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'AskUser', 'artifact']);

const ARTIFACT_EXAMPLES = [
  {
    command: 'create',
    identifier: '<short-kebab-case-id>',
    type: 'html',
    title: '<title>',
    content: '<!doctype html><html>…complete page…</html>',
  },
  { command: 'rewrite', identifier: '<the same id>', content: '<the complete new content>' },
];

/** The core template for a session: `<mode>.<tier>`, or the full tier when no compact one exists. */
export function coreTemplate(mode: Mode, tier: PromptTier, overrides: Overrides): string {
  return hasTemplate(`${mode}.${tier}`, overrides) ? `${mode}.${tier}` : `${mode}.full`;
}

export function buildSystemPrompt(ctx: PromptContext): SystemBlock[] {
  const has = (name: string) => ctx.tools.some((t) => t.name === name);
  const test: Condition = (cond) => {
    if (cond.startsWith('mode=')) return cond.slice(5).split('|').includes(ctx.mode);
    if (cond.startsWith('tier=')) return cond.slice(5) === ctx.tier;
    if (cond === 'safeguards') return !!ctx.safeguards;
    if (cond === 'effort') return ctx.hasEffortControl;
    if ((BUILTIN_TOOLS as readonly string[]).includes(cond)) return has(cond);
    return undefined;
  };
  const call = (name: string, input: unknown) =>
    ctx.promptedTools
      ? `<tool_call>${JSON.stringify({ name, arguments: input })}</tool_call>`
      : `${name} ${JSON.stringify(input)}`;
  const examples = ctx.tools
    .filter((t) => EXAMPLE_TOOLS.has(t.name) && t.compactExample)
    .map((t) => `- ${call(t.name, t.compactExample)}`);
  const vars = {
    app: APP.name,
    tool_examples: examples.length ? `Example calls:\n${examples.join('\n')}` : '',
    artifact_examples: `Example calls:\n${ARTIFACT_EXAMPLES.map((input) => `- ${call('artifact', input)}`).join('\n')}`,
  };
  // An empty variable (no example calls) shouldn't leave a gap.
  const fill = (name: string) =>
    render(resolveGuards(template(name, ctx.overrides), test, name), vars).replace(/\n{3,}/g, '\n\n');

  // Blocks 1–2: the same for every session with this mode, tier and tool set (cache breakpoint 1).
  const prefix = [ctx.agentPrompt ?? fill(ctx.subagent ? 'subagent' : coreTemplate(ctx.mode, ctx.tier, ctx.overrides))];
  if (has('WebSearch')) prefix.push(fill(`fragments/search.${ctx.tier}`));
  else if (ctx.mode !== 'code' && !ctx.subagent) prefix.push(fill('fragments/no-search'));
  // Chat's guidance on when to make an artifact; Code's core says when to show its work in one instead.
  if (has('artifact') && !ctx.subagent && ctx.mode !== 'code') prefix.push(fill(`fragments/artifacts.${ctx.tier}`));
  if (!ctx.subagent && (has('MemorySearch') || has('MemoryUpdate') || has('ChatSearch')))
    prefix.push(fill('fragments/memory'));
  const blocks: SystemBlock[] = prefix.map((text) => ({ text }));
  blocks[blocks.length - 1]!.cache = true;

  // Emitted here rather than by a template, so a core override can't drop it.
  if (ctx.safeguards) blocks.push({ text: ctx.safeguards.text });
  const subagentFacts = ctx.subagentFacts && {
    ...ctx.subagentFacts,
    name: escapeTags(ctx.subagentFacts.name),
    parentTitle: escapeTags(ctx.subagentFacts.parentTitle),
  };
  blocks.push({
    text: envBlock({
      mode: ctx.mode,
      model: escapeFacts(ctx.model),
      date: ctx.date,
      timeZone: ctx.timeZone,
      ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
      ...(subagentFacts ? { subagent: subagentFacts } : {}),
    }),
  });
  // The administrator's text first: it outranks the files, and Chat has nothing else here.
  const organization = ctx.organization?.trim()
    ? `<instructions source="admin settings" kind="system">\n${escapeTags(ctx.organization.trim())}\n</instructions>`
    : '';
  const files = ctx.instructions?.length ? renderInstructions(ctx.instructions) : '';
  if (organization || files)
    blocks.push({ text: [fill('strings/instructions-header'), organization, files].filter(Boolean).join('\n\n') });
  // A defined agent may lack the Skill tool; then the list would offer what it can't load.
  if (ctx.skills && has('Skill')) blocks.push({ text: ctx.skills });
  if (ctx.subagent) return withLastCached(blocks);

  const personal: string[] = [];
  if (ctx.profileName.trim()) personal.push(`The person's name is ${escapeTags(ctx.profileName.trim())}.`);
  const personality = personalityText(ctx.personalization.personality);
  if (personality) personal.push(personality);
  const style = RESPONSE_STYLES[ctx.personalization.responseStyle];
  if (style) personal.push(style);
  if (ctx.personalization.instructions.trim()) {
    personal.push(`<user_instructions>\n${escapeTags(ctx.personalization.instructions.trim())}\n</user_instructions>`);
  }
  if (personal.length) blocks.push({ text: personal.join('\n') });
  // Built from stored entries, escaped there; it changes when memory does, so it comes after the stable blocks.
  if (ctx.memory) blocks.push({ text: ctx.memory });

  if (ctx.project) {
    const parts = [`<project name="${escapeAttr(ctx.project.name)}">`];
    if (ctx.project.instructions.trim())
      parts.push(`<instructions>\n${escapeTags(ctx.project.instructions.trim())}\n</instructions>`);
    for (const f of ctx.project.files)
      parts.push(`<document name="${escapeAttr(f.name)}">\n${escapeTags(f.text)}\n</document>`);
    parts.push('</project>');
    blocks.push({ text: parts.join('\n') });
  }
  return withLastCached(blocks);
}

/** Cache breakpoint 2: the whole stable prefix, up to the last block. */
function withLastCached(blocks: SystemBlock[]): SystemBlock[] {
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, cache: true };
  return blocks;
}

/** Model names and server names come from providers, so they can't carry tags either. */
function escapeFacts(model: ModelFacts): ModelFacts {
  return { ...model, name: escapeTags(model.name), ref: escapeTags(model.ref), servedBy: escapeTags(model.servedBy) };
}
