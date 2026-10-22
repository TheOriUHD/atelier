/**
 * Facts for the `<env>` block (docs/PROMPTS.md §1.4): one per line, stable for the whole session. The model's
 * developer is told apart from the software serving it, so a local model doesn't name Ollama as its maker.
 */
import { PROVIDER_LABELS, type ModelInfo, type ProviderConfig } from '@atelier/protocol';

export interface ModelFacts {
  name: string;
  ref: string;
  /** Who trained the model, when its id says so. */
  developer: string | null;
  /** The serving software or API, as the person named it. */
  servedBy: string;
}

export interface WorkspaceFacts {
  /** Where the folder lives, in words ("a folder on the computer that runs Atelier", "SSH host build-box"). */
  kind: string;
  /** The session started with no folder: `root` is a scratch folder made for it. */
  scratch: boolean;
  root: string;
  additionalDirectories: string[];
  git: boolean;
  platform: string;
  shell: string;
}

/** Model families by id, most specific first (a Llama-based Nemotron is NVIDIA's, a DeepSeek distill DeepSeek's). */
const DEVELOPERS: [RegExp, string][] = [
  [/nemotron/i, 'NVIDIA'],
  [/deepseek/i, 'DeepSeek'],
  [/claude/i, 'Anthropic'],
  [/gpt-oss/i, 'OpenAI'],
  [/(^|[/_-])(gpt|chatgpt|codex|o[1-9])\b/i, 'OpenAI'],
  [/(^|[/_-])(meta-)?(code)?llama(\d|[-:.]|$)/i, 'Meta'],
  [/(^|[/_-])qw(en|q)/i, 'Alibaba Cloud (Qwen team)'],
  [/(^|[/_-])gem(ma|ini)/i, 'Google'],
  [/(^|[/_-])(mistral|mixtral|magistral|devstral|codestral|ministral|pixtral)/i, 'Mistral AI'],
  [/(^|[/_-])phi[-\d]/i, 'Microsoft'],
  [/(^|[/_-])granite/i, 'IBM'],
  [/(^|[/_-])(command-r|c4ai|aya)/i, 'Cohere'],
  [/(^|[/_-])(chat)?glm/i, 'Zhipu AI'],
  [/(^|[/_-])kimi/i, 'Moonshot AI'],
  [/(^|[/_-])olmo/i, 'Ai2'],
  [/(^|[/_-])grok/i, 'xAI'],
];

export function modelDeveloper(modelId: string, provider: ProviderConfig['type'] | undefined): string | null {
  const known = DEVELOPERS.find(([re]) => re.test(modelId))?.[1];
  if (known) return known;
  return provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : null;
}

export function modelFacts(info: ModelInfo, provider: ProviderConfig | undefined): ModelFacts {
  const label = provider ? PROVIDER_LABELS[provider.type] : info.providerId;
  const servedBy = provider && provider.name !== label ? `${provider.name} (${label})` : label;
  return { name: info.displayName, ref: info.ref, developer: modelDeveloper(info.modelId, provider?.type), servedBy };
}

/** `Thursday, 2026-01-15` and the ISO date, in `timeZone`. */
export function localDate(now: Date, timeZone: string): { iso: string; long: string } {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  return { iso, long: `${weekday}, ${iso}` };
}

/** Who a sub-agent is: the label its delegating agent gave the task, its own session and the session that started it. */
export interface SubagentFacts {
  name: string;
  sessionId: string;
  parentTitle: string;
}

const MODES = { chat: 'Chat', work: 'Cowork', code: 'Code' } as const;

export function envBlock(facts: { mode: keyof typeof MODES; model: ModelFacts; date: string; timeZone: string; workspace?: WorkspaceFacts; subagent?: SubagentFacts }): string {
  const { model, workspace } = facts;
  const lines = [
    'App: Atelier, a self-hosted workspace',
    `Mode: ${MODES[facts.mode]}`,
    `Model: ${model.name} (${model.ref}), ${model.developer ? `developed by ${model.developer}` : 'developer unknown'}`,
    `Served through: ${model.servedBy}`,
    'Knowledge cutoff: not recorded for this model',
    `Date at session start: ${facts.date} (time zone ${facts.timeZone})`,
    'Model changes: the person can switch the model during the conversation',
  ];
  if (facts.subagent) {
    const { name, sessionId, parentTitle } = facts.subagent;
    lines.push(`Role: sub-agent "${name}" (session ${sessionId}), started by the session "${parentTitle}"`);
  }
  if (workspace) {
    lines.push(`Workspace: ${workspace.kind}`, `Working directory: ${workspace.root}`);
    if (workspace.scratch) lines.push("Folder: none chosen; the working directory is a new, empty scratch folder that Atelier made for this session, not one of the person's projects");
    if (workspace.additionalDirectories.length) lines.push(`Additional directories: ${workspace.additionalDirectories.join(', ')}`);
    if (facts.mode === 'code') lines.push(`Git repository: ${workspace.git ? 'yes' : 'no'}`);
    lines.push(`Platform: ${workspace.platform}`, `Shell: ${workspace.shell}`);
  }
  return ['<env>', ...lines, '</env>'].join('\n');
}
