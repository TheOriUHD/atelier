/**
 * The published prompts: every system prompt, context-update note, side prompt and tool description Atelier sends to a
 * model, written out as documentation pages and downloads (docs/PROMPTS.md has the design). Everything here is
 * derived from `packages/core/prompts/`, the tool definitions and the assembled snapshots, so nothing is typed twice;
 * `published.test.ts` fails when a committed file is stale, and `pnpm docs:generate` rewrites them.
 *
 * The pages are `apps/docs/src/content/docs/prompts/*.md` and `reference/tools.md`; the downloads are in
 * `apps/docs/public/prompts/`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BUILTIN_TOOLS } from '../../tools/types.ts';
import { defaultTemplates } from '../templates.gen.ts';
import { assemble, CASES, describeCase, type PromptCase } from './prompt-cases.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const DOCS = 'apps/docs/src/content/docs';
const PUBLIC = 'apps/docs/public/prompts';
const REPO_URL = 'https://github.com/TheOriUHD/atelier/blob/main';
const NOTICE = (source: string) =>
  `<!-- GENERATED from ${source} by packages/core/src/prompts/__fixtures__/publish-docs.ts. Do not edit; run \`pnpm docs:generate\`. -->`;

/** A code fence that the text cannot close: longer than any run of backticks inside it. */
export function fence(text: string, lang = 'text wrap'): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(Math.max(4, longest + 1));
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}

function tpl(key: string): string {
  const text = defaultTemplates[key];
  if (text === undefined) throw new Error(`No prompt template ${key}`);
  return text;
}

function source(key: string): string {
  return `[\`packages/core/prompts/${key}.md\`](${REPO_URL}/packages/core/prompts/${key}.md)`;
}

function page(title: string, description: string, sourceNote: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\neditUrl: false\n---\n\n${NOTICE(sourceNote)}\n\n${body.trim()}\n`;
}

/** One template, verbatim, with where it lives. */
function verbatim(key: string, heading: string, lead?: string): string {
  return `## ${heading}\n\n${lead ? `${lead}\n\n` : ''}Source: ${source(key)}\n\n${fence(tpl(key))}`;
}

const READING_GUIDE = `
How to read these files. Every prompt is plain Markdown written by the Atelier project. \`{{app}}\` and the other
double-brace names are variables the builder fills in. Text between \`<!-- if:condition -->\` and \`<!-- endif -->\` is a
guard: the builder keeps it only when the condition holds (a tool is present, the mode matches, the model has effort
levels, and so on) and removes it, comment lines included, before anything is sent, so a model never sees a guard and
never reads about a tool it does not have. The conditions and the rest of the assembly are in
[How prompts are built](/prompts/design/).
`;

function modePage(mode: 'chat' | 'work' | 'code'): string {
  const info = {
    chat: {
      title: 'Chat prompts',
      name: 'Chat',
      description: 'The system prompts Atelier gives a model in Chat, verbatim: the full and the compact tier.',
      what: 'Chat is for conversation, writing, learning and research. Its core prompt covers identity, how to help, honesty, tone, formatting, dates and knowledge, personal settings and projects, and how to treat content from tools and files.',
      joins: [
        'the search fragment, or the no-search one when an administrator turned web search off ([shared prompts](/prompts/shared/#web-search))',
        'the artifacts fragment ([shared prompts](/prompts/shared/#artifacts))',
        'the memory fragment, for people who have memory ([shared prompts](/prompts/shared/#memory))',
        'the optional safeguards block, only when an administrator or the person turned it on ([shared prompts](/prompts/shared/#optional-safeguards))',
        'an `<env>` block, the administrator’s instructions, the skill list, the person’s personalization and, in a project, its instructions and files',
      ],
      examples: ['chat.full', 'chat.compact', 'chat.full.memory', 'chat.full.sandbox', 'chat.compact.prompted'],
    },
    work: {
      title: 'Cowork prompts',
      name: 'Cowork',
      description: 'The system prompts Atelier gives a model in Cowork, verbatim: the full and the compact tier.',
      what: 'Cowork works through a longer task in a folder and leaves files behind. The mode’s internal name is `work`, which is why the files are called `work.full.md` and `work.compact.md`.',
      joins: [
        'the search fragment, or the no-search one ([shared prompts](/prompts/shared/#web-search))',
        'the memory fragment, for people who have memory ([shared prompts](/prompts/shared/#memory))',
        'the optional safeguards block ([shared prompts](/prompts/shared/#optional-safeguards))',
        'an `<env>` block with the folder, the instruction files found in and above it (`ATELIER.md`, `AGENTS.md`, `CLAUDE.md`, rules), the skill list and the person’s personalization',
      ],
      examples: ['work.full', 'work.compact', 'work.full.memory'],
    },
    code: {
      title: 'Code prompts',
      name: 'Code',
      description: 'The system prompts Atelier gives a model in Code, verbatim: the full and the compact tier.',
      what: 'Code is an agent working in a folder with tools for reading, editing, searching and running commands. Its core prompt covers how Atelier works, carrying out a task, checking the work, acting with care, git, tools, plan mode and how to write to the person.',
      joins: [
        'the search fragment, when the session has web search ([shared prompts](/prompts/shared/#web-search))',
        'the optional safeguards block ([shared prompts](/prompts/shared/#optional-safeguards))',
        'an `<env>` block with the folder and platform, the instruction files, the skill list and the person’s personalization',
        'for sub-agents, the [sub-agent core](/prompts/shared/#sub-agents) in place of this one',
      ],
      examples: ['code.full', 'code.compact', 'code.full.plan', 'code.full.subagent', 'code.compact.prompted'],
    },
  }[mode];
  const body = `
${info.what}

${READING_GUIDE.trim()}

Two tiers exist. The **full** tier is for capable models and explains the reason behind each rule. The **compact** tier
is for local and small models: at most twelve short numbered rules, one example call per core tool, and the language
rule repeated last. Atelier picks the tier from the model (Settings › Admin › Models can override it per model).

${verbatim(`${mode}.full`, 'Full tier')}

${verbatim(`${mode}.compact`, 'Compact tier')}

## What joins it

The core prompt is the first block of a longer system prompt. Also in it, in this order:

${info.joins.map((j) => `- ${j}`).join('\n')}

The exact assembled text of typical sessions is in [Assembled prompts](/prompts/assembled/): ${info.examples
    .map((c) => `[\`${c}\`](/prompts/assembled/${c}.txt)`)
    .join(', ')}.
`;
  return page(info.title, info.description, `packages/core/prompts/${mode}.*.md`, body);
}

function sharedPage(): string {
  const body = `
These prompts are not specific to one mode. Fragments join a mode’s core prompt when the session has the matching tool.
${READING_GUIDE}
${verbatim('fragments/search.full', 'Web search', 'The searching and citing guidance, joined when the session has the WebSearch tool. Full tier first, then compact.')}

${verbatim('fragments/search.compact', 'Web search (compact tier)')}

${verbatim('fragments/no-search', 'Web search switched off', 'Chat and Cowork without WebSearch (an administrator turned it off; it is on by default):')}

${verbatim('fragments/artifacts.full', 'Artifacts', 'Joined when the session has the artifact tool (Chat). Full tier:')}

${verbatim('fragments/artifacts.compact', 'Artifacts (compact tier)')}

${verbatim('fragments/memory', 'Memory', 'Joined for people who have memory, together with the memory tools. The memory digest itself is built from stored entries and appended after the personalization block; see [How prompts are built](/prompts/design/).')}

${verbatim('subagent', 'Sub-agents', 'The core prompt of a sub-agent that has no prompt of its own (an agent definition can bring its own). Sub-agents get no turn notes, no personalization and no project content.')}

${verbatim('safeguards.full', 'Optional safeguards', 'Atelier adds nothing of this kind by default: the shipped prompts carry no topic restrictions or disclaimers. An administrator can turn on optional extra safeguards for everyone, or a person for themselves; only then is this block added (the builder emits it, so overriding a core cannot remove it). Full tier:')}

${verbatim('safeguards.compact', 'Optional safeguards (compact tier)')}

${verbatim('strings/instructions-header', 'Instruction files header', 'The text above the instruction files in Code and Cowork (and above the administrator’s instructions in Chat). It says where the instructions come from and how they rank when they conflict.')}
`;
  return page(
    'Shared prompts',
    'Fragments, the sub-agent core, optional safeguards and the instruction-file header, verbatim.',
    'packages/core/prompts/fragments, subagent.md, safeguards.*.md, strings',
    body,
  );
}

function sidePage(): string {
  const body = `
Besides the conversation’s own system prompt, Atelier asks models a few single-purpose questions. Each has a prompt of
its own, printed here verbatim.
${READING_GUIDE}
${verbatim('auto-mode', 'Auto mode reviewer', 'In Auto permission mode, a model reviews each action that would otherwise ask. It uses the session’s own model (a small model for ChatGPT Chat), reads the conversation and the proposed action, and answers allow or block. See [Permissions](/permissions/).')}

${verbatim('compaction', 'Compaction', 'Written when a conversation is compacted: the model produces the record that another instance continues from.')}

${verbatim('memory-update', 'Memory update', 'The background task that updates what Atelier remembers. It receives the current memory and a new part of a conversation (or an imported export) and answers with one JSON object of operations. See [Memory](/memory/).')}

${verbatim('title', 'Titles', 'Asks for a two to six word title for a conversation.')}

${verbatim('web-fetch', 'Web page questions', 'WebFetch fetches a page and a helper model answers the question about it for the main model, treating the page as data.')}
`;
  return page(
    'Side prompts',
    'The prompts for Auto mode review, compaction, memory updates, titles and web page questions, verbatim.',
    'packages/core/prompts',
    body,
  );
}

/** When each context-update note is sent (docs/PROMPTS.md §7.2); a test fails when a note has no entry here. */
export const NOTE_WHEN: Record<string, { group: string; when: string }> = {
  date: { group: 'Session', when: 'The first turn on a new local date.' },
  model: { group: 'Session', when: 'The session’s model changed (the system prompt is rebuilt).' },
  'git-snapshot': {
    group: 'Session',
    when: 'Code: the first turn in a git repository, with the branch, default branch, changed files and the last five commit subjects, labelled as repository data that does not update.',
  },
  'permission-ask': { group: 'Permissions and plan mode', when: 'Code: the person switched to Ask permissions.' },
  'permission-accept-edits': { group: 'Permissions and plan mode', when: 'Code: the person switched to Accept edits.' },
  'permission-auto': { group: 'Permissions and plan mode', when: 'Code: the person switched to Auto.' },
  'permission-bypass': { group: 'Permissions and plan mode', when: 'Code: the person switched to Bypass permissions.' },
  'plan-on': { group: 'Permissions and plan mode', when: 'Code: plan mode started.' },
  'plan-still-on': { group: 'Permissions and plan mode', when: 'Code: every turn while plan mode continues.' },
  'plan-off': { group: 'Permissions and plan mode', when: 'Code: the picker ended plan mode.' },
  'effort-brief': { group: 'Effort', when: 'Low, on a model whose own setting cannot express it: when it starts or changes, again after ten person turns, and after a compaction.' },
  'effort-careful': { group: 'Effort', when: 'High, on a model whose own setting cannot express it (same cadence).' },
  'effort-thorough': { group: 'Effort', when: 'Extra, on a model whose own setting cannot express it (same cadence).' },
  'effort-exhaustive': { group: 'Effort', when: 'Max, on a model whose own setting cannot express it (same cadence).' },
  'effort-normal': { group: 'Effort', when: 'Back to the default (Medium) after a different level.' },
  'ultracode-on': { group: 'Effort', when: 'Code: Ultracode started, on the first turn of a branch that runs at Ultracode, and on the first turn after a compaction.' },
  'ultracode-still-on': { group: 'Effort', when: 'Code: after ten person turns without an Ultracode note while it stays on.' },
  'ultracode-off': { group: 'Effort', when: 'Code: the first turn after Ultracode was switched off or clamped away.' },
  'skills-added': { group: 'Capabilities', when: 'Skills were installed since the prompt was built or since the last announcement.' },
  'connector-on': { group: 'Capabilities', when: 'A connector’s tools appeared.' },
  'connector-off': { group: 'Capabilities', when: 'A connector’s tools went away.' },
  research: { group: 'Capabilities', when: 'Every message while Research is on and web search is enabled.' },
  'safeguards-changed': { group: 'Capabilities', when: 'Safeguards were turned on or changed.' },
  'workspace-settings-changed': { group: 'Capabilities', when: 'Safeguards were turned off (neutral wording; it does not claim anything is lifted).' },
  refresher: { group: 'Long conversations', when: 'Right after a compaction, once per compaction cycle past 60% of the window, and every 30 person turns in Chat and Cowork; repeats style guidance and lists open tasks.' },
  'after-compaction': { group: 'Long conversations', when: 'On every compaction summary: the announced state restated, the approved plan, recently loaded skills and the files read most recently.' },
  'output-cut': { group: 'Long conversations', when: 'A reply stopped at the output limit; the loop carries on once, after this note.' },
  'restart-continue': { group: 'Long conversations', when: 'Atelier restarted while a reply was being written and the person asked it to continue.' },
  'todo-nudge': { group: 'Tool loops', when: 'Code and Cowork: ten tool calls without a TodoWrite while the task list has unfinished items. Rides on a tool result.' },
  'instructions-nested': { group: 'Tool loops', when: 'Code and Cowork: the first file tool call in or under a folder that has its own instruction file. Rides on a tool result.' },
  'message-while-working': { group: 'Tool loops', when: 'The person sent a message while the model was working; it joins at the next step.' },
  'message-interrupt': { group: 'Tool loops', when: 'The person pressed Send now: the message interrupted the work in progress.' },
  'background-agent': { group: 'Agents and sessions', when: 'Code and Cowork: a sub-agent started with run_in_background ended. Carries its task, how it ended and its result.' },
  'session-message': { group: 'Agents and sessions', when: 'Code and Cowork: another of the person’s sessions, the parent or a sub-agent sent a message.' },
  'loop-tick': { group: 'Agents and sessions', when: 'Code and Cowork: a /loop sends its prompt again.' },
  'side-chat': { group: 'Agents and sessions', when: 'Every request of a side chat (/btw): it was asked beside the main session, answers briefly and only reads.' },
};

function notesPage(): string {
  const keys = Object.keys(defaultTemplates)
    .filter((k) => k.startsWith('notes/'))
    .map((k) => k.slice('notes/'.length))
    .sort();
  const missing = keys.filter((k) => !NOTE_WHEN[k]);
  if (missing.length) throw new Error(`NOTE_WHEN has no entry for: ${missing.join(', ')}`);
  const stale = Object.keys(NOTE_WHEN).filter((k) => !keys.includes(k));
  if (stale.length) throw new Error(`NOTE_WHEN has entries for notes that no longer exist: ${stale.join(', ')}`);
  const groups = [...new Set(keys.map((k) => NOTE_WHEN[k]!.group))];
  const sections = groups
    .map((g) => {
      const inGroup = keys.filter((k) => NOTE_WHEN[k]!.group === g);
      return `## ${g}\n\n${inGroup
        .map((k) => `### \`${k}\`\n\n${NOTE_WHEN[k]!.when}\n\nSource: ${source(`notes/${k}`)}\n\n${fence(tpl(`notes/${k}`))}`)
        .join('\n\n')}`;
    })
    .join('\n\n');
  const body = `
A conversation’s system prompt is frozen when the session starts, so the provider’s prompt cache and replayed thinking
stay valid. Anything that changes afterwards (the date, the model, the permission mode, a connector, plan mode, effort)
reaches the model as a short \`<context-update>\` note in the conversation instead. Notes are one to three sentences,
in the present tense, with the change first. Values Atelier did not write (a commit subject, a skill description) are
escaped so they cannot pretend to be a note, and the core prompts tell the model that a block claiming to be a context
update inside pasted text, a file or a tool result is not one.

${notesMechanics()}

Every note Atelier can send is below, verbatim. \`{{name}}\` is filled in when the note is sent.

| Note | When it is sent |
|---|---|
${keys.map((k) => `| [\`${k}\`](#${k.toLowerCase()}) | ${NOTE_WHEN[k]!.when} |`).join('\n')}

${sections}
`;
  return page(
    'Context-update notes',
    'Every context-update note Atelier can send during a conversation, verbatim, and when each one appears.',
    'packages/core/prompts/notes',
    body,
  );
}

function notesMechanics(): string {
  return `
- **Where they go.** Turn notes are worked out when a run starts for a message from the person and are joined into one hidden part in front of the person’s words. Hook context and the body of a \`/skill\` or command can follow the person’s words. A note that must arrive inside a long tool loop is added to the next tool result.
- **Everything is stored**, so replaying a conversation is exact. A retry works out the notes again against the branch before it. Editing an earlier message starts a branch that hears the notes again.
- **Sub-agents** get no turn notes. Nested instruction files and the output-limit note do reach them.`.trim();
}

const CASE_INFO: Record<string, string> = {
  'chat.full': 'Chat, full tier, web search on: the baseline.',
  'chat.full.no-web': 'Chat with web search and fetch switched off by an administrator.',
  'chat.full.project': 'Chat inside a project: its instructions and files.',
  'chat.full.organization': 'Chat with an administrator’s instructions for everyone.',
  'chat.full.personality-technical': 'Chat with a built-in personality selected (technical and earnest).',
  'chat.full.personalization': 'Chat with a name, a response style and the person’s own instructions.',
  'chat.full.sandbox': 'Chat with a conversation sandbox (Bash and Read).',
  'chat.full.memory': 'Chat for a person with memory, with the memory tools and digest.',
  'chat.full.memory-explicit': 'Chat with memory where “Generate memory from chats” and chat search are off.',
  'chat.compact': 'Chat, compact tier.',
  'chat.compact.prompted': 'Chat, compact tier, for a model that calls tools through text (prompted tool calls).',
  'chat.compact.sandbox': 'Chat, compact tier, with a conversation sandbox.',
  'chat.compact.memory': 'Chat, compact tier, with memory.',
  'work.full': 'Cowork, full tier.',
  'work.full.no-web': 'Cowork with web access and skills switched off.',
  'work.full.memory': 'Cowork for a person with memory.',
  'work.full.personality-custom': 'Cowork with a custom personality and a concise response style.',
  'work.compact': 'Cowork, compact tier.',
  'code.full': 'Code, full tier: the baseline.',
  'code.full.plan': 'Code in plan mode.',
  'code.full.scratch': 'Code started with No folder: a scratch folder of its own.',
  'code.full.no-effort': 'Code on a model without effort levels, web search off.',
  'code.full.subagent': 'A sub-agent started by the Agent tool.',
  'code.full.defined-agent': 'A sub-agent defined by an agent file with its own prompt.',
  'code.compact': 'Code, compact tier.',
  'code.compact.prompted': 'Code, compact tier, with prompted tool calls.',
  'code.compact.connectors': 'Code, compact tier, with three connectors of twenty tools each.',
  'code.compact.budget': 'Code, compact tier, over the 16,000 character budget: how the builder trims the skill list, connectors and instruction files.',
  'code.compact.personality-relaxed': 'Code, compact tier, with a built-in personality selected (relaxed, more emoji).',
  'safeguards.chat.full': 'Chat with the administrator’s optional safeguards on.',
  'safeguards.chat.compact': 'Chat, compact tier, with safeguards on.',
  'safeguards.code.full.all': 'Code with every safeguard category on.',
  'safeguards.code.compact.all': 'Code, compact tier, with every safeguard category on.',
  'safeguards.work.full.person-on': 'Cowork where the person turned safeguards on for themselves.',
  'safeguards.work.compact': 'Cowork, compact tier, with safeguards on.',
  'safeguards.code.full.subagent': 'A sub-agent inheriting the person’s safeguards (some categories on).',
};

export function caseNames(): string[] {
  return Object.keys(CASES);
}

function snapshotDir(): string {
  return join(REPO_ROOT, 'packages/core/src/prompts/__snapshots__/prompts');
}

function assembledPage(): string {
  const names = caseNames();
  const missing = names.filter((n) => !CASE_INFO[n]);
  if (missing.length) throw new Error(`CASE_INFO has no entry for: ${missing.join(', ')}`);
  const rows = names.map((n) => {
    const text = readFileSync(join(snapshotDir(), `${n}.txt`), 'utf8');
    return `| [\`${n}\`](/prompts/assembled/${n}.txt) | ${CASE_INFO[n]} | ${Math.round(text.length / 1024)} KB |`;
  });
  const body = `
What a model really receives is more than the templates: the builder joins a core prompt, fragments, optional
safeguards, an \`<env>\` block, instruction files, skills and personalization, and the request also carries the tool
definitions. The files below are the complete assembled text of ${names.length} typical sessions: every system block in
order (with the cache breakpoints marked), the notes on the first message, and the tools as JSON.

They are produced by the project’s test suite with fixed inputs (the date 2026-01-15 in Europe/Berlin, fake model
names, a fixed folder and a two-line \`AGENTS.md\`), and the suite fails when a template, a tool description or the
assembly changes without these files changing too, so they cannot drift from the code. In the repository they are in
[\`packages/core/src/prompts/__snapshots__/prompts/\`](${REPO_URL}/packages/core/src/prompts/__snapshots__/prompts).

Your own sessions add your folder, skills, memory and instruction files to these. The request inspector (Settings ›
Admin › Developer › Record provider requests) lists the requests sent to your model providers, but it never records
prompts or replies.

| Case | What it shows | Size |
|---|---|---|
${rows.join('\n')}

## One file with everything

- [\`atelier-prompts.md\`](/prompts/atelier-prompts.md): every template in one Markdown file.
- [\`atelier-prompts.json\`](/prompts/atelier-prompts.json): the same as JSON (\`templates\`, \`notes\`, \`tools\`).
`;
  return page(
    'Assembled prompts',
    'The complete text a model receives in typical sessions, system blocks, notes and tool definitions, as downloads.',
    'packages/core/src/prompts/__snapshots__/prompts',
    body,
  );
}

function designPage(): string {
  const raw = readFileSync(join(REPO_ROOT, 'docs/PROMPTS.md'), 'utf8');
  // The title becomes the page title; the file’s own H1 and its first paragraph (repo-internal pointers) are dropped.
  const withoutTitle = raw.replace(/^# .*\n+/, '');
  const body = `This page is the project’s design document for prompts, published as it is kept in the repository (\`docs/PROMPTS.md\`). It explains how the prompt of every session is assembled, why each piece exists, and how tests keep it honest.\n\n${withoutTitle}`;
  return page(
    'How prompts are built',
    'Principles, assembly, cache breakpoints, tool descriptions, context updates, effort notes, safeguards and the tests behind them.',
    'docs/PROMPTS.md',
    body,
  );
}

type ToolDefJson = { name: string; description: string; inputSchema?: Record<string, unknown>; input_schema?: Record<string, unknown> };

const MODE_LABEL = { chat: 'Chat', work: 'Cowork', code: 'Code' } as const;

function schemaOf(tool: ToolDefJson): Record<string, unknown> {
  return (tool.inputSchema ?? tool.input_schema ?? {}) as Record<string, unknown>;
}

function typeOf(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) return (prop.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
  const t = prop.type;
  if (t === 'array') {
    const items = (prop.items ?? {}) as Record<string, unknown>;
    return `array of ${items.type ?? 'any'}`;
  }
  if (Array.isArray(t)) return t.join(' | ');
  if (typeof t === 'string') return t;
  if (Array.isArray(prop.anyOf)) return (prop.anyOf as Record<string, unknown>[]).map(typeOf).join(' | ');
  return 'any';
}

function paramTable(tool: ToolDefJson): string {
  const schema = schemaOf(tool);
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const names = Object.keys(props);
  if (!names.length) return 'No parameters.';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  return [
    '| Parameter | Type | Required | Description |',
    '|---|---|---|---|',
    ...names.map(
      (n) => `| \`${n}\` | ${cell(typeOf(props[n]!))} | ${required.has(n) ? 'yes' : 'no'} | ${cell(String(props[n]!.description ?? ''))} |`,
    ),
  ].join('\n');
}

function firstSentence(text: string): string {
  const flat = text.split('\n')[0]!.trim();
  const m = /^(.*?[.!?])(\s|$)/.exec(flat);
  return (m ? m[1]! : flat).replace(/\|/g, '\\|');
}

export interface ToolRecord {
  name: string;
  /** Distinct descriptions, with the sessions that carry each. */
  variants: { description: string; sessions: string[] }[];
  modes: { always: string[]; sometimes: string[] };
  schema: Record<string, unknown>;
  tool: ToolDefJson;
}

/** Every built-in tool as sessions send it, gathered from the assembled sessions of the snapshot matrix. */
export async function collectTools(): Promise<ToolRecord[]> {
  const byName = new Map<string, { variants: Map<string, string[]>; modes: Map<string, Set<string>>; tool: ToolDefJson }>();
  const baseline: Record<string, string> = { chat: 'chat.full', work: 'work.full', code: 'code.full' };
  const baselineTools = new Map<string, Set<string>>();
  for (const [name, c] of Object.entries(CASES) as [string, PromptCase][]) {
    if (name.startsWith('safeguards.') || c.subagent) continue;
    const a = await assemble(c);
    const defs = a.tools as unknown as ToolDefJson[];
    if (Object.values(baseline).includes(name)) baselineTools.set(c.mode, new Set(defs.map((t) => t.name)));
    for (const t of defs) {
      if (!(BUILTIN_TOOLS as readonly string[]).includes(t.name)) continue;
      const rec = byName.get(t.name) ?? { variants: new Map(), modes: new Map(), tool: t };
      rec.variants.set(t.description, [...(rec.variants.get(t.description) ?? []), name]);
      const modes = rec.modes.get(c.mode) ?? new Set();
      modes.add(name);
      rec.modes.set(c.mode, modes);
      byName.set(t.name, rec);
    }
  }
  return (BUILTIN_TOOLS as readonly string[])
    .filter((n) => byName.has(n))
    .map((n) => {
      const rec = byName.get(n)!;
      const always: string[] = [];
      const sometimes: string[] = [];
      for (const mode of ['chat', 'work', 'code'] as const) {
        if (!rec.modes.has(mode)) continue;
        (baselineTools.get(mode)?.has(n) ? always : sometimes).push(MODE_LABEL[mode]);
      }
      // The primary wording is the Code full-tier one, else the Cowork or Chat full-tier one, else the commonest.
      const variants = [...rec.variants].map(([description, sessions]) => ({ description, sessions }));
      const rank = (v: { sessions: string[] }) =>
        v.sessions.includes('code.full') ? 0 : v.sessions.includes('work.full') ? 1 : v.sessions.includes('chat.full') ? 2 : v.sessions.some((s) => s.includes('.full')) ? 3 : 4;
      variants.sort((a, b) => rank(a) - rank(b) || b.sessions.length - a.sessions.length || a.description.localeCompare(b.description));
      return { name: n, variants, modes: { always, sometimes }, schema: schemaOf(rec.tool), tool: rec.tool };
    });
}

function sessionLabel(caseName: string): string {
  const [mode, tier] = caseName.split('.');
  const m = mode === 'chat' ? 'Chat' : mode === 'work' ? 'Cowork' : mode === 'code' ? 'Code' : mode;
  return `${m}, ${tier} tier`;
}

function toolsPage(tools: ToolRecord[]): string {
  const availability = (t: ToolRecord) =>
    ['Chat', 'Cowork', 'Code']
      .flatMap((m) => (t.modes.always.includes(m) ? [m] : t.modes.sometimes.includes(m) ? [`${m} (some setups)`] : []))
      .join(', ') || '—';
  const sections = tools
    .map((t) => {
      const [primary, ...others] = t.variants;
      const alt = others.length
        ? `\n\n<details>\n<summary>The description reads differently in ${others.length} other ${others.length === 1 ? 'setup' : 'setups'}</summary>\n\nA description depends on the prompt tier, the mode and which other tools the session has, so it only names tools that exist.\n\n${others
            .map((v) => {
              const labels = [...new Set(v.sessions.map(sessionLabel))].join('; ');
              return `**${labels}**\n\n${fence(v.description)}`;
            })
            .join('\n\n')}\n\n</details>`
        : '';
      return `## ${t.name}\n\n**Available in:** ${availability(t)}\n\n### Description\n\n${fence(primary!.description)}${alt}\n\n### Parameters\n\n${paramTable(t.tool)}`;
    })
    .join('\n\n');
  const body = `
Every built-in tool, with the description a model reads and its parameters, exactly as Atelier sends them. A tool is
only offered when the session can use it; **Available in** says where. Connector tools (from MCP servers) are added
after these, named \`mcp__<connector>__<tool>\`, with the server’s own descriptions. The rules for which tools run
without asking are on [Permissions](/permissions/), and how descriptions are kept short for small models is in
[How prompts are built](/prompts/design/#4-tool-descriptions).

| Tool | Available in | What it does |
|---|---|---|
${tools.map((t) => `| [\`${t.name}\`](#${t.name.toLowerCase().replace(/_/g, '_')}) | ${availability(t)} | ${firstSentence(t.variants[0]!.description)} |`).join('\n')}

${sections}
`;
  return page(
    'Built-in tools',
    'Every built-in tool with the description and parameters a model sees.',
    'the tool definitions, via the assembled prompt matrix',
    body,
  );
}

function downloadMarkdown(tools: ToolRecord[]): string {
  const keys = Object.keys(defaultTemplates).sort();
  const out = [
    '# Atelier prompts',
    '',
    'Every prompt template Atelier ships, verbatim, in one file. Generated from `packages/core/prompts/` and the tool definitions; see https://docs.atelierhq.dev/prompts/ .',
    '`{{name}}` is a variable the builder fills in; text between `<!-- if:condition -->` and `<!-- endif -->` is kept only when the condition holds.',
    '',
    '## Contents',
    '',
    ...keys.map((k) => `- ${k}`),
    '',
  ];
  for (const k of keys) out.push(`---`, '', `## ${k}`, '', `File: packages/core/prompts/${k}.md`, '', fence(tpl(k), 'text'), '');
  out.push('---', '', '## Tools', '');
  for (const t of tools) out.push(`### ${t.name}`, '', fence(t.variants[0]!.description, 'text'), '', fence(JSON.stringify(t.schema, null, 2), 'json'), '');
  return out.join('\n');
}

function downloadJson(tools: ToolRecord[]): string {
  const templates = Object.fromEntries(Object.entries(defaultTemplates).sort(([a], [b]) => a.localeCompare(b)));
  const notes = Object.fromEntries(
    Object.keys(NOTE_WHEN)
      .sort()
      .map((k) => [k, { group: NOTE_WHEN[k]!.group, when: NOTE_WHEN[k]!.when, text: tpl(`notes/${k}`) }]),
  );
  return `${JSON.stringify(
    {
      description: 'Every prompt template Atelier ships, verbatim, and the built-in tool definitions. See https://docs.atelierhq.dev/prompts/',
      templates,
      notes,
      tools: tools.map((t) => ({ name: t.name, availableIn: t.modes, description: t.variants[0]!.description, inputSchema: t.schema })),
    },
    null,
    2,
  )}\n`;
}

/** Every generated file, by repository-relative path. */
export async function publishedFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const tools = await collectTools();
  files.set(`${DOCS}/prompts/chat.md`, modePage('chat'));
  files.set(`${DOCS}/prompts/cowork.md`, modePage('work'));
  files.set(`${DOCS}/prompts/code.md`, modePage('code'));
  files.set(`${DOCS}/prompts/shared.md`, sharedPage());
  files.set(`${DOCS}/prompts/side-prompts.md`, sidePage());
  files.set(`${DOCS}/prompts/context-updates.md`, notesPage());
  files.set(`${DOCS}/prompts/assembled.md`, assembledPage());
  files.set(`${DOCS}/prompts/design.md`, designPage());
  files.set(`${DOCS}/reference/tools.md`, toolsPage(tools));
  files.set(`${PUBLIC}/atelier-prompts.md`, downloadMarkdown(tools));
  files.set(`${PUBLIC}/atelier-prompts.json`, downloadJson(tools));
  for (const n of caseNames()) files.set(`${PUBLIC}/assembled/${n}.txt`, readFileSync(join(snapshotDir(), `${n}.txt`), 'utf8'));
  return files;
}

/** Files under the generated folders that no longer have a source (a case or a page that was removed). */
export function strayFiles(files: Map<string, string>): string[] {
  const stray: string[] = [];
  const dir = join(REPO_ROOT, PUBLIC, 'assembled');
  try {
    for (const f of readdirSync(dir)) if (!files.has(`${PUBLIC}/assembled/${f}`)) stray.push(`${PUBLIC}/assembled/${f}`);
  } catch {
    // The folder does not exist before the first run.
  }
  return stray;
}

export { describeCase };
