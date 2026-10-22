---
title: "How prompts are built"
description: "Principles, assembly, cache breakpoints, tool descriptions, context updates, effort notes, safeguards and the tests behind them."
editUrl: false
---

<!-- GENERATED from docs/PROMPTS.md by packages/core/src/prompts/__fixtures__/publish-docs.ts. Do not edit; run `pnpm docs:generate`. -->

This page is the project’s design document for prompts, published as it is kept in the repository (`docs/PROMPTS.md`). It explains how the prompt of every session is assembled, why each piece exists, and how tests keep it honest.

How Atelier talks to models: which text a session's model reads, where each piece comes from, when it changes, and
how tests keep it honest. Architecture lives in `ARCHITECTURE.md` (§8 runtime, §13 prompts). Everything in `packages/core/prompts/` is Atelier's own writing.

---

## 0. Principles

1. **Same behaviour, own words.** Code should work the way a careful coding agent works, Chat and Cowork the way a
   good assistant does: stay in scope, verify, report truthfully, keep git safe, delegate sensibly, format with
   restraint, search before citing. The prompts encode those behaviours in Atelier's sentences. Published
   prompts of other products are read only to check that nothing was copied (§10).
2. **Compatible where people rely on it.** Tool and parameter names stay Claude Code's (`Read`, `Edit`, `old_string`,
   `replace_all`, `run_in_background`, `subagent_type`, …), so CLAUDE.md files, skills, agents and hooks keep working.
   Where Atelier differs (`AskUser`, `Agent`, lowercase `artifact`), prompts use Atelier's names.
3. **Nothing added by default.** Shipped prompts carry no topic restrictions, refusal criteria, disclaimers or
   moralizing. What the model and its provider do on their own is all that applies. An administrator can switch on
   optional safeguards for everyone or per person (§9). Agentic safety (permissions, destructive steps, prompt
   injection, secrets) is not content policy and stays in every prompt.
4. **A frozen system prompt; changes travel as notes.** The system prompt and tools are fixed per session so provider
   caches and replayed thinking stay valid. What changes later reaches the model as a short `<context-update>` note
   (§7). The prompt is rebuilt only when something it states has changed (§1.6).
5. **Describe only what exists.** A prompt never names a tool, setting or feature the session lacks. Guards drop text
   for absent tools, fragments appear only with their tool, and nothing about safeguards appears while they are off.
6. **Two tiers.** `full` for strong models: calm sentences that give the reason for a rule. `compact` for local and
   small models: at most twelve short numbered rules, the most important first, one example call per core tool, and
   the language rule repeated last. `tierFor` picks the tier; Settings › Admin › Models can override it per model.
7. **The harness enforces; the prompt explains.** Permissions, plan mode and approvals are enforced in code. A prompt
   sentence is never the only thing between a model and a destructive step.

---

## 1. Assembly

### 1.1 Files

`packages/core/prompts/` holds every template; `scripts/embed-prompts.mjs` embeds them (subfolders included) into
`src/prompts/templates.gen.ts`, and a test fails when the two drift apart. Files in `~/.atelier/prompts/` with the same
relative name override a template; overrides are read again when that folder changes.

| File | Use |
|---|---|
| `chat.full.md`, `chat.compact.md` | Chat core |
| `work.full.md`, `work.compact.md` | Cowork core (internal mode `work`) |
| `code.full.md`, `code.compact.md` | Code core |
| `subagent.md` | Core for every sub-agent without a prompt of its own |
| `fragments/search.full.md`, `fragments/search.compact.md` | Searching and citing, when the session has `WebSearch` |
| `fragments/no-search.md` | Chat and Cowork without `WebSearch` |
| `fragments/artifacts.full.md`, `fragments/artifacts.compact.md` | When the session has `artifact` (Chat; Code's cores say how to show work with it instead) |
| `safeguards.full.md`, `safeguards.compact.md` | The optional safeguards block (§9) |
| `notes/<key>.md` | One file per context note (§7) |
| `strings/instructions-header.md` | The header above instruction files |
| `compaction.md`, `title.md`, `web-fetch.md` | Side prompts |

Cores contain one variable, `{{app}}`, and in the compact tier `{{tool_examples}}`. The model's name and the date
live in `<env>`, so the core text is the same for every model of a tier.

**Guards.** Conditional text is wrapped in `<!-- if:<cond> -->…<!-- endif -->`, either around whole lines or inline
within one line; `!` negates a condition and `&` joins conditions that must all hold (`Write&Edit`). The builder
resolves guards before anything is sent. Conditions: a built-in tool name (`Agent`, `ExitPlanMode`, …),
`mode=chat|work|code` (a `|` list), `tier=full` or `tier=compact`, `safeguards`, and `effort` (the model has effort levels). Note templates use
variable names as conditions (true when the variable isn't empty) and, rendered for a session's tools, built-in tool
names, so a note that arrives later in a session (plan mode, the output-limit note) names only tools it has. An
unknown condition is an error, also in an override, so a typo can't silently keep or drop text. Guards don't nest.
Numbered rules are numbered again after guards removed some.

### 1.2 Blocks and cache breakpoints

`buildSystemPrompt` (`src/prompts/builder.ts`) emits these blocks in order:

| # | Block | Chat | Cowork | Code | Sub-agent |
|---|---|---|---|---|---|
| 1 | Core: `<mode>.<tier>`, `subagent`, or a defined agent's own prompt | ✓ | ✓ | ✓ | ✓ |
| 2 | Fragments: search or no-search, then artifacts, then memory (with the memory tools) | ✓ | ✓ | search | search |
| — | *cache breakpoint 1, on the last of 1–2* | | | | |
| 3 | Safeguards, only when on for the person | ✓ | ✓ | ✓ | ✓ |
| 4 | `<env>` | ✓ | ✓ | ✓ | ✓ |
| 5 | Instructions: the administrator's text, then the instruction files (§1.5) | admin's text | ✓ | ✓ | ✓ |
| 6 | `<available_skills>`, only with the Skill tool | ✓ | ✓ | ✓ | ✓ |
| 7 | Personalization: name, response style, `<user_instructions>` | ✓ | ✓ | ✓ | — |
| 7a | Memory digest, when they have memory (§5.4): Preferences as `<user_instructions source="memory">`, then `<memory>` background | ✓ | ✓ | — | — |
| 8 | `<project>` | Chat projects | — | — | — |
| — | *cache breakpoint 2, on the last block* | | | | |

Models without native tool calling get the prompted-tools specification appended by their adapter wrapper, after the
second breakpoint.

- Blocks 1–2 are identical for every session with the same mode, tier and tool set, so breakpoint 1 gives cache hits
  across sessions. The Anthropic adapter spends its four breakpoints on these two, the final message and the previous
  person turn; the tools array is covered by breakpoint 1 because it comes first in the cache prefix.
- The safeguards block is emitted by the builder, not by a template, so overriding a core can't remove it, and it sits
  before `<env>` so sub-agents get it too.
- Sub-agents never get personalization or project content.

### 1.3 Tools in requests

- **Order.** Built-in tools in one fixed order (`Read, Write, Edit, Glob, Grep, Bash, BashOutput, KillShell,
  TodoWrite, AskUser, Agent, SendMessage, ListSessions, Skill, ExitPlanMode, WebSearch, WebFetch, MemorySearch, MemoryView, MemoryUpdate,
  ChatSearch, ChatRead, artifact`), then connector tools by name
  (`BUILTIN_TOOLS`, `orderTools` in `src/tools/types.ts`).
- **Descriptions.** A built-in tool's description is a function of the tier, the mode and which other tools the
  session has, and nothing else, so the tools JSON is byte-stable and only names tools that exist.
- **Compact examples.** Core tools (`Read, Edit, Write, Bash, Grep, Glob, TodoWrite, AskUser`) carry a
  `compactExample` with placeholder values (`"<path>"`, `"<exact text from the file>"`). Compact cores render one
  example line per present core tool, as `Name {json}` or, for prompted tools, as `<tool_call>{…}</tool_call>`.
  Placeholders, never realistic paths, because small models copy examples literally.
- **Connectors.** A server's tool descriptions pass through, escaped (§1.7) and capped at 2,048 characters; in the
  compact tier only the first sentence, at most 200 characters, is kept, and the compact budget may shorten it further
  (§1.8). Each connector tool's definition is frozen in the session's snapshot when first seen, and requests send the
  frozen copy until the set of connector tools or the tier changes, so a server that reorders its tools or edits a
  description mid-session doesn't break the cache.

### 1.4 `<env>`

One fact per line, the same for the whole session:

| Line | Chat | Cowork | Code |
|---|---|---|---|
| `App: Atelier, a self-hosted workspace` | ✓ | ✓ | ✓ |
| `Mode` | ✓ | ✓ | ✓ |
| `Model: <name> (<ref>), developed by <developer>`, or `developer unknown` | ✓ | ✓ | ✓ |
| `Served through: <provider>`, the serving software or API, kept apart from the developer | ✓ | ✓ | ✓ |
| `Knowledge cutoff` (not recorded yet, and the line says so) | ✓ | ✓ | ✓ |
| `Date at session start: <weekday>, <ISO date> (time zone <zone>)`, in the backend's time zone | ✓ | ✓ | ✓ |
| `Model changes`: the person can switch models mid-conversation | ✓ | ✓ | ✓ |
| `Workspace`: a folder on the person's computer, the Atelier server, an SSH host, a codespace | — | ✓ | ✓ |
| `Working directory`, `Additional directories` | — | ✓ | ✓ |
| `Folder: none chosen; …`: the working directory is a new, empty scratch folder made for this session, not a project (sessions started with No folder only) | — | ✓ | ✓ |
| `Git repository: yes/no` | — | — | ✓ |
| `Platform`, `Shell` | — | ✓ | ✓ |

The developer comes from the model id (`modelDeveloper` in `src/prompts/env.ts`: a Qwen model served by Ollama is
Alibaba's, not Ollama's), falling back to the provider for Anthropic and OpenAI and to "unknown" otherwise. The
repository's branch, changes and recent commits are repository data and don't belong in the system prompt: they reach
Code's first turn as the `git-snapshot` note (§7).

### 1.5 Instruction files

The header (`strings/instructions-header.md`) says that the instructions below come from the administrator, the person
and the project, that they take precedence over the defaults of the prompt, and how they rank on conflict: the
administrator's (`kind="system"`: their instructions for every conversation, then the system AGENTS.md and ATELIER.md
in the config folder), then what the person says in the conversation, then the person's own files (`personal`: on the
desktop `~/.claude/CLAUDE.md` and `~/.atelier/ATELIER.md`, then everywhere their **Your ATELIER.md** from Settings ›
Account, stored in their preferences), then the project's (`project`: per folder CLAUDE.md, .claude/CLAUDE.md,
AGENTS.md, ATELIER.md, CLAUDE.local.md, from the root upward; `rules`: `.claude/rules/**`). Within a kind the more
specific one wins: the deeper path, ATELIER.md over the other files in its folder, and the administrator's files over
their general text. The blocks appear in this load order, so within a kind the later one wins. ATELIER.md is Atelier's
own file; AGENTS.md and CLAUDE.md load for compatibility. On the desktop the config folder is `~/.atelier`, so its
ATELIER.md counts as the owner's (`personal`); on a server `<configDir>/ATELIER.md` is a system file. The stored file
has no folder, so its `@path` imports aren't followed. The compact tier has a shorter header with the same order
(guarded with `tier=compact`).
Instructions never override the permission system, nor the safeguards block when there is one (that clause is
guarded, so default prompts don't mention it). Each file is wrapped as `<instructions source="…" kind="…">`.

**The administrator's instructions** (`prompts.organizationInstructions`, Admin › Capabilities › Instructions, empty by
default) reach every mode and every sub-agent as `<instructions source="admin settings" kind="system">`, first in the
block. Chat gets only this text; its header there says it comes from the administrator and outranks the prompt's
defaults and what the person and their project ask, and `chat.full.md` puts the administrator first in its own order
of precedence. It is a setting of its own rather than the system AGENTS.md reused, because that file holds
conventions written for Code and Cowork. Like the files, it reaches new conversations, not running ones; regular
users' settings don't include it; the compact budget never cuts it.

**Writing instructions.** Code and Cowork (`code.*.md`, `work.*.md`, a section in the full tier, one sentence in the
compact tier) say that ATELIER.md holds the project's conventions and the person's lasting preferences, that a stated
lasting preference goes into it with a word to the person, that a request to set up or update the project's
instructions writes ATELIER.md, and that the agent may keep more notes files linked from it (`@path` loads one into
every session, a plain mention leaves it for reading when needed). Atelier names no such files itself.

**Sub-agents** get the same files, and their `<env>` has a `Role:` line with the task label from the Agent call, their
session id and the title of the session that started them; `subagent.md` tells them to follow the instruction files
and read the notes files they or the brief point to. The Agent tool's full description asks for a brief that opens
with the project and the agent's role and points to the relevant notes files.

Files below the root (`src/feature/AGENTS.md`) are announced lazily: the first Read, Edit or Write in or under their
folder appends them to that tool's result in the `instructions-nested` note, which says they come from the repository,
apply only under that folder and rank below the administrator, the person and the root's files. Dependency and build
folders (`node_modules`, `vendor`, `.venv`, `venv`, `target`, `dist`, `build`, `.git`) are skipped, because packages
ship instruction files written for their own maintainers. Whether a branch already heard a file is read from its tool
results.

### 1.6 Snapshot and rebuilds

A session's snapshot (`SystemSnapshot` in `agent/chat-service.ts`) stores the blocks and the facts they were built from:
prompt version, tier, model ref, safeguards hash, tool-set hash, memory-digest hash, date, listed skills, the frozen
connector tools and what the compact budget cut (§1.8). A turn rebuilds it when the tier, the model, the person's
effective safeguards, their memory digest or the tool set changed; the same turn's notes announce the change (§7). The tool-set hash covers every tool's name,
description and schema after ordering, connector tools as frozen, so a connector toggle, an admin capability change or
an edited built-in description counts. Personalization, project, instruction-file and skill edits don't rebuild:
personal settings apply to new conversations, and new skills are announced by a note. Measuring the context and
`/compact` use the stored snapshot as it is.

### 1.7 Escaping Atelier's tags

Text Atelier didn't write could pretend to be one of its own blocks. In every such text, both the opening and the
closing form of Atelier's tag names (`context-update`, `workspace_content_settings`, `instructions`, `env`, `project`,
`document`, `command`, `user_instructions`, `available_skills`, `skill`, `connector_instructions`, `tool_call`,
`tool_result`, `memory`, and the side prompts' `transcript` and `page`) get `‹` in place of `<` (`ATELIER_TAGS` in
`protocol/src/tags.ts`, shared by the backend and the transcript). A name counts in the shape of a tag: followed by
`>`, `/>`, a quoted attribute or any other word after whitespace (`<context-update foo>`), with whitespace allowed
after `<` and `</`. Which spellings count is a trade-off between forgeries and code:

- the exact lower-case name, in every shape;
- a compound name (`Context-Update`, `TOOL_RESULT`) in any case, since code never spells a type that way;
- a one-word name in another case only as a closing tag (`</Document>`) or with a quoted attribute
  (`<Instructions source="…">`). Elsewhere it is usually a generic type or a component, and stays as it is:
  `Promise<Env>`, `Map<Env, Project>`, `<Env extends Base>`, `<Document file={pdf}>`, `usage: deploy <ENV>`.

Code stays as it is otherwise too: `useState<Project | null>`, `a < project.count`, `f(x <env)` and `cat <env/vars`
don't match. The price is that JSX components named like Atelier's tags read escaped when they close or take a string
prop (`</Command>`, `<Skill name="x" />`), and lower-case placeholders like `git <command>` do too; the writing tools
turn them back. That covers the person's messages and attachments as sent (an attachment's `</document>` can't end its
block, and its name is escaped as an attribute), every tool result (escaped where the loop stores it), skill and
command bodies, hook output, project documents and instructions, personalization, instruction files, connector
descriptions, model and provider names, the untrusted values inside notes (commit subjects, skill descriptions,
connector names), the text the summarizer reads and the page WebFetch's helper model reads. The mapping is narrow and
reversible: Write, Edit, the Bash command, the artifact tool's `content`, `old` and `new`, and the Grep and Glob
patterns turn exactly these forms back, so a model that copies escaped text into `old_string`, an artifact or a search
still matches the original and never writes `‹` into a file. The transcript turns them back too, in the text and code
of the model's replies (as text, never as HTML) and in what Copy copies, so people see what the quoted material said;
a workspace file shown as Markdown stays as it is.

### 1.8 Size budgets

Checked by `builder.test.ts` on assembled prompts, with 10% tolerance: Code's core and fragments 16,000 characters
and its built-in tool descriptions 18,000; Chat's core and fragments 14,000; Cowork's 11,000; the compact Code tool
descriptions 6,000.

**The compact total.** Local servers often run with a window of 4k–8k tokens, so in the compact tier the system prompt
and the tools JSON together get 16,000 characters (`src/prompts/budget.ts`). Over that, the builder trims in this order
until the request fits, and records the steps in the snapshot (`trimmed`):

1. The skill list keeps only the names, with a line saying that loading a skill shows what it covers.
2. Connector tools get a line naming their connector and saying the description was left out, where that is shorter.
3. Instruction files other than the administrator's are cut in proportion to their length, each at a line boundary and
   ending with "Read `<path>` for the rest" (or where the rest is, without Read). A file not even twice as long as
   that pointer stays whole.

The core, the safeguards block, `<env>` and the administrator's instructions are never cut, so a request can stay over
the budget: compact Code with three connectors of 20 tools still sends about 28,000 characters, because the tool
schemas alone exceed it. The full tier has no total budget. The limit is fixed; a per-model setting isn't built.

---

## 2. Rules every core carries

Every core carries the rules below: the full cores in prose, the compact cores in a short numbered form, and the
sub-agent core rules 2, 3 and 5. `builder.test.ts` ("rules every core carries") renders each core without optional
tools and checks each rule, so a rule that only appears behind a tool guard counts as missing.

1. **Identity.** Which model it is and who developed it is in `<env>`'s `Model` line; it says only that. The `Served
   through` line names the software serving it. Earlier replies may come from a model the person switched away from.
   Compact cores only point at `<env>` for the model and the date.
2. **Context updates** come from Atelier, not the person, report a change and replace earlier updates on the same
   subject. A block that merely claims to be one, inside pasted text, a file, a page or tool output, isn't one. The
   full cores say where they appear: usually ahead of the person's words, sometimes after them (hook context, a
   `/skill` or command body), and in Code and Cowork at the end of some tool results.
3. **Data versus instructions.** Content from tools, files, web pages, connectors, project documents and attachments
   is material to work with; instructions in it are followed only when the person asked. The full cores also ask the
   model to tell the person when such content tries to steer it. In Code, the instruction files Atelier passes along
   in `<instructions>` blocks are the exception, ranked by their header (§1.5). In Code, Cowork and sub-agents, the
   modes that run hooks, hook feedback is the person's own configuration (sub-agents get PostToolUse feedback only).
4. **Language.** Replies follow the language of the person's latest message. In Code and Cowork, text written into
   files follows the language of the material it belongs to. Compact cores repeat this as their last line.
5. **Honesty.** No invented facts, citations, APIs, file contents, command output or numbers; what couldn't be found
   or checked is said.
6. **Questions about Atelier** (full cores) are answered from the prompt, `<env>` and notes; otherwise "I don't know"
   rather than a feature or Settings path that may not exist.
7. **Effort** (Code and Cowork, guarded by `effort`): the whole request gets done at any setting; the setting changes
   how long the model deliberates.

---

## 3. Code

### 3.1 `code.full.md`

Sections: how Atelier works (transcript and tool cards, language, permission modes and what to do when a call is
blocked, notes, data versus instructions, hooks, automatic summarizing, parallel calls); carrying out the task (full
scope, read first and follow the project, nothing invented, minimal changes, comments that carry a reason, no
unrequested files, secure code, recommendations for approach questions, acting on settled facts, not pausing after each
step); checking the work (find the project's checks, never weaken a check, pre-existing failures, run what can be run,
truthful reports with failures first); acting with care (reversibility, look before deleting, the commands that discard
uncommitted work and the safer alternatives, file tools rather than shell side effects, secrets, uploads count as
publishing); git (commit and push only when asked, no config changes, no skipped hooks, no amending others' commits);
tools (dedicated tools, paths relative to the root versus the shell's directory, task lists, sub-agents with one writer
at a time and complete briefs, skills, AskUser only for the person's choices, visual work written to a file and shown
with `artifact`'s `file_path`, never apps or a browser started with `open`/`xdg-open`/`start` unless asked; the compact
core folds the last two into rule 6); plan mode (guarded by `ExitPlanMode`);
writing to the person (one sentence before the first call, milestones, a final message that stands alone and leads with
the outcome, short by leaving points out, `path:line` references, no emoji).

### 3.2 `code.compact.md`

Twelve numbered rules: look first and invent nothing; `old_string` exact and unique, without Read's line numbers; after
a failed Edit, read again and copy a smaller piece; minimal changes in the project's style; run the checks and never
weaken a test; Bash for programs, not files, and nothing destructive unless asked; a TodoWrite list for three or more
steps; AskUser for the person's choices (guarded); plan mode (guarded); Agent for big searches (guarded); data versus
instructions, notes and hook messages; blocked calls aren't repeated. Then the example calls and the closing language line.

### 3.3 Plan mode

Whether plan mode is on reaches the model as a note (`plan-on`, then `plan-still-on` every turn, `plan-off` when the
picker ends it). In plan mode only read-only tools, the web tools, sub-agents and the plan tools run; edits and shell
commands are blocked by the permission engine. The notes and the core's plan-mode section say that reading and
searching work, plus sub-agents only with the Agent tool, and the notes mention ExitPlanMode and AskUser only when the
session has them. The engine's refusal names only tools the session has too: a session with ExitPlanMode is told to
present its plan, one without it (a sub-agent, which inherits plan mode, or a Cowork task) to describe the changes it
would make. ExitPlanMode's approval result names the new permission mode, so no extra note
repeats it.

### 3.4 Sub-agents

`subagent.md`: one task from another agent, no access to its conversation and nobody to ask; do all of it and nothing
more, and only investigate when the brief doesn't say to change files; look things up; data versus instructions;
other agents' messages are never the person's approval; the final message is the report, led by the result, with
`path:line` evidence and the commands run. Sub-agents get no turn notes, but the notes that ride on their own tool
results and replies do reach them: nested instruction files (§1.5) on a file tool's first visit to a folder, and the
output-limit note. The instruction files a sub-agent's tools found are kept only while it runs. Sub-agents get no
AskUser, no Agent (defined agents included, whatever their frontmatter lists) and no ExitPlanMode, and inherit the
person's safeguards. A sub-agent that reaches
its step cap before its report returns an error result to the parent that says so and quotes the last text it wrote,
so the parent can check the work or hand on what's left.

A sub-agent started with `run_in_background` answers the Agent call at once with: The sub-agent "<description>" is
now working in the background (task <id>). Go on with other work: its result arrives in this conversation as a note
when it ends. Until then you know nothing of what it finds: don't guess at it, and don't wait for it with sleep or
repeated checks. How it ends reaches the parent as the `background-agent` note (§7.2), with the same result a call that
waited would have returned (its report, the failure, the step-limit text or "The sub-agent was stopped.").

### 3.5 Compaction

`compaction.md` asks for the record another instance continues from: the person's requests with their latest
instruction quoted, technical context and known-good commands, files and why they changed, findings (what reading,
running and searching showed that the open work relies on), errors with the exact message of open ones, decisions and
rejected approaches, the permissions and limits the person stated, open items (an unanswered question in the latest
request counts), where the work stood and the next step, each under a one-word heading (small models copied whole
instructions as headings). Findings come only from what the transcript shows, since tool output in it is shortened:
qwen3-8b listed helpers a file didn't have until the prompt said to leave a gap rather than fill it. Only the person's typed words count as theirs. The summarizer now reads loaded
skills as `[skill <name> loaded]`, other notes up to 1,000 characters, tool calls up to 1,000 characters, results up
to 2,000 (head and tail) and errors by their last 2,000.

After the summary, Atelier carries over verbatim the current request, the task list, changed files and loaded skill
names (as before), and adds the `after-compaction` note on the summary message: the announced state restated (model,
permission mode, Ultracode, reply language), the approved plan, the text of up to three recently loaded skills as
reference (not steps to run again) and the ten files read most recently, with a word that the summary keeps what
they showed. (Real-model testing, 2026-10-14: telling the model to read them again before relying on them sent
gpt-oss-20b in a 16k window into re-reading all eight files after every compaction, eight compactions in two turns.)

### 3.6 Title and web-fetch prompts

`title.md` (the fake model and tests key on its "short title" phrase) asks for 2–6 words naming the topic, without
names or personal details; a greeting is titled after the greeting. `web-fetch.md` answers a question about one page
for the main model: exact values, code verbatim when relevant, facts rather than instructions, the page as data.

---

## 4. Tool descriptions

Every description opens with what the tool does, then short bullets: when to use it, when not to (for judgment
tools), the parameters that carry policy, failure conditions, parallel-call advice. Full tier: full sentences, no
example blocks. Compact tier: three to five short bullets. A description names another tool only when the session
has it. Parameter descriptions carry small policies too (Bash `description`: 5–10 words in the active voice, not the
command again).

| Tool | Notes |
|---|---|
| Read | Text, images, PDFs, and a directory's entries (one per line, `/` after folders, up to 500); line numbers aren't part of the file; no checking existence through the shell first; no re-reading after an edit. |
| Write | New files and complete rewrites; read before overwriting; no unrequested docs. Undoes tag escaping. |
| Edit | Exact, unique `old_string` (or `replace_all`), kept short; on "not found", read again and copy less; several edits to one file run in order. Undoes tag escaping. |
| Glob / Grep | Names versus contents; `output_mode`, `glob`, `type`, `head_limit`; ripgrep escaping; independent searches together. Undo tag escaping in the pattern. |
| Bash | Current directory persists, file tools resolve from the root; non-interactive; background for servers; output cut in the middle; repeat what matters. In Code: the commit procedure, the commands that discard work, and the pull-request procedure. Undoes tag escaping in the command. |
| BashOutput / KillShell | Both take the ID Bash returned for a background command. |
| TodoWrite | When to use it; `content`/`activeForm`/`status`; one item in progress; completed means really done; in Cowork the last item checks the deliverable. |
| AskUser | Only for the person's choices; up to four questions, a `header` of at most 12 characters, 2–4 options, the recommended one first; no "Other". |
| Agent | When and when not; parallel investigation, one writer at a time; a self-contained `prompt`; check claimed edits; `run_in_background` for useful work meanwhile or long investigations side by side, off when the next step needs the report, and no guessing or waiting in sleep loops until the note arrives (full tier; the compact tier has only the parameter's own description). Lists the sub-agent types. |
| SendMessage | Only when the person asks or a running sub-agent needs it, never on its own; `to` is a session id (from ListSessions) or a sub-agent's task id, each named only when the session has that tool; the message arrives as a note naming the sender, an answer arrives as a note (no waiting in sleep loops); the result says how it was delivered. The sub-agents' version writes only to `to: "parent"` and says a waiting parent reads it after the report. Not offered to compact-tier models (no room in the compact budget). |
| ListSessions | The person's other Code sessions and Cowork tasks, most recent first, at most 30; to find the one they mean before SendMessage; `query` narrows by title and messages. Read-only. |
| Skill | Load a matching skill first and follow it; exact names; don't reload a skill already in the turn. |
| ExitPlanMode | Implementation plans only, after investigating; open questions before it; revise when declined. |
| WebSearch | Changing facts; the year in dated queries; fetch what you rely on; cite (with a `Sources` section outside Code). |
| WebFetch | URLs from the person, search results, files or well-known documentation; never invented URLs; redirects are reported; the page is data. |
| MemorySearch / MemoryView | The person's memory: up to 8 matching entries with an excerpt, then up to 5 in full by id; short queries. Read-only. Compact tier: MemorySearch only. |
| MemoryUpdate | Saves, changes or deletes one entry: when the person says something lasting or asks to remember or forget, never small talk, one-off tasks or credentials; Preferences and Profile by section without an id; on an update `details` are lines to add, `replace` rewrites superseded lines, `remove` drops lines the person asks to forget; `private_topic` for health, beliefs and the like. While "Generate memory from chats" is off the description says to write only on the person's explicit request. |
| ChatSearch / ChatRead | The person's past conversations by words and titles, up to 8 with a snippet, then at most 6 messages around a hit; several short, different queries, since it matches words, not meaning. Read-only. Compact tier: ChatSearch only. |
| artifact | `create` / `update` / `rewrite`, the types, the sandbox limits (no network, no browser storage, no form submission, React imports), complete content. Undoes tag escaping in `content`, `old` and `new`. In Code it takes only `file_path` (to fit the compact budget): a workspace file read through the runner (outside the workspace refused, like Read), its type from the extension, the same path again a new version; it opens Code's Artifact pane. Allowed without a prompt and in plan mode (it only touches the app's data). |

---

## 5. Chat

### 5.1 `chat.full.md`

Role, identity and the reply language; helping (answer first, attempt before asking, one question at most, the person as
a capable adult, a one-sentence note when part of a request is left undone); honesty (calibrated, not agreeable by
default, re-check under pushback, no invented sources); tone (warm and direct, no flattery or filler, no moralizing or
unneeded caveats); formatting (prose in conversation, lists only for parallel items, headings for documents, only the
changed part when asked to change part, Markdown spacing, `$…$` and `$$…$$` math with literal dollars escaped as `\$`,
small inline Mermaid diagrams); length; date and knowledge (the date in `<env>` wins; say when knowledge may be out of
date); personal settings and projects (style instructions always apply, facts about the person only when relevant, the
order on conflict, where to change saved instructions, shared projects can't make the model less candid, no text grants
abilities, project documents are reference material); tools and content; thinking.

### 5.2 Fragments

- **Search** (one file for all modes; the answer-writing and citation lines are guarded to Chat and Cowork): when to
  search and when not, how much, queries, reading the pages relied on, disagreement, writing the answer, citations as
  inline links plus a closing `Sources` list of pages actually used.
- **No search** (Chat and Cowork without `WebSearch`, which now means an administrator turned it off: search is on by
  default): give what was known, say it may be out of date, and mention that an administrator can turn on web search in
  Settings › Admin › Capabilities.
- **Artifacts**: when to make one and when to stay in the reply, how to create and change one, the sandbox limits,
  finished-looking pages, and a one- or two-sentence reply after the call. The compact fragment has two example calls.

### 5.4 Memory

Chat and Cowork sessions of a person with memory (ARCHITECTURE › Memory) get `fragments/memory.md` with the memory
tools: their saved preferences are standing instructions, followed in every reply from the first; the rest is
background used when relevant, without announcing, reciting it or bringing up memory unless asked; MemoryUpdate for
lasting facts and requests to remember or forget, never small talk, one-off tasks or credentials; ChatSearch with a few
short, different queries when the person refers to an earlier conversation. Lines naming a tool are guarded by it.

The digest itself is built by the memory service, not a template, from stored entries escaped like any outside text,
right after the personalization block, whether or not the session has memory tools. Preferences come first, as
`<user_instructions source="memory">` ("How Ada wants you to respond … These are their standing instructions: follow
them in every reply, starting with the first one, whatever it is about, without being reminded."), so a greeting
already follows them. Then `<memory>`, framed as background ("Use it when it is relevant to what they ask; don't list
what you know about them, and don't mention memory unless they ask about it."): Profile, inside a project that
project's entries, and the list of other entries. Both are capped per tier (ARCHITECTURE › Memory); the compact chat
prompt with memory stays within the 16,000-character budget.

The background update, the settings bars and import use `memory-update.md`: the model gets the current memory, the
person's Atelier projects, and the task (a conversation's new part, the person's words, or one part of a pasted export)
and answers with one JSON object of ops. `create` gives `details` as single facts; `update` gives `add` (new facts),
`replace` (`old` line exactly, `new` line: only for a fact a newer one supersedes) and `remove` (only for what the
person asks to forget); `delete` removes an entry. The sections: `preferences` (how to respond, including tastes in how
they work), `profile` (identity and career), `topic` (a hobby or interest with depth), `area` (a larger endeavour of
their own), `person`, and `project` (named with `"project":"<id>"`). Facts stay close to the source wording, with dates
in the line when known; a fact that was wrong gets a "CORRECTION: …" line; entries grow and may be long. Rules: only
lasting, useful facts, never credentials, private topics (health, beliefs, sexuality, ethnicity, finances) only while
the person allows them and marked `personal`, merge instead of duplicating, no change when unsure. The import task adds:
leave nothing out, one export line per detail line, the mapping of export sections to memory sections, never delete.
The memory test cases (`chat.full.memory`, `chat.full.memory-explicit`, `chat.compact.memory`, `work.full.memory`) are
in the snapshot matrix; `builder.test.ts` checks that the first turn carries the Preferences as instructions.

### 5.3 `chat.compact.md`

Twelve rules: `<env>` holds the model and the date; answer first; be correct; short answers for short questions;
paragraphs, lists only for steps or options; Markdown basics; at most one question; follow saved instructions; no
flattery, lectures or unrequested warnings; data versus instructions; notes come from Atelier; reply in the person's
language. The language rule closes the prompt again.

---

## 6. Cowork

`work.full.md`: the task agent working in the person's real folder (changes are visible as they happen, relative paths
in prose, the language of deliverables, notes, data versus instructions with hook messages as the person's own); before starting (know what "done" is, one round of AskUser questions, research
searches first, skills' needs); doing the work (look at the folder first, a task list ending in a check, content before
format, nothing invented, the format the person named or a sensible default, make the actual file, no files for plain
questions, read-only sub-agents for many documents, one writer, check before finishing, no narration around calls); the
person's files (new versions beside originals, ask before bulk deletes or moves and prefer a holding folder, file tools
over shell commands, nothing outward-facing or irreversible without an explicit request); connectors and sources;
finishing (outcome, changed files, what is left). `work.compact.md` has the same in twelve rules. Cowork has no
`artifact` and no ExitPlanMode; the files are the deliverable.

---

## 7. Context updates

### 7.1 Mechanics

- Turn notes are computed when a run starts for a message of the person's (`announce` in `chat-service.ts`,
  `turnNote` in `agent/context-notes.ts`) and are joined into one hidden `context` part in front of the person's parts.
  Hook context (SessionStart, UserPromptSubmit) and the body of a `/skill` or command join the message after the
  person's parts, so the cores say notes come usually ahead of the person's words and sometimes after them. Notes that
  must arrive inside a long tool loop are appended to the next tool result as a `<context-update>` text block.
  Everything is stored, so a replay is exact. A retry computes the message's turn note again against the branch
  before it and replaces the earlier one, so a mode, model or Ultracode switch since the message was sent is told (an
  edit is a new message and gets notes of its own). Sub-agents get no turn notes; nested instruction files and the
  output-limit note reach them too (§3.4).
- **What a branch was told.** Each note part records the facts it announced in its `state` (`ContextPart.state` in
  the protocol). What the model knows is the snapshot's facts (the date, model, skills, connectors and safeguards the
  prompt states) overlaid with the `state` of every part on the path from the nearest compaction summary to the head.
  Editing an earlier message therefore starts a branch that hears the notes again. A part that only records state has
  empty text and isn't sent. An approved ExitPlanMode result counts as announcing its mode.
- Wording: one to three sentences, present tense, what changed first, no capitals for emphasis; untrusted values are
  escaped; notes about untrusted material say what they are not.

### 7.2 Notes

| Key | When | Where |
|---|---|---|
| `date` | The first turn on a new local date | turn |
| `git-snapshot` | Code, the first turn of a git repository: branch, default branch, changed files, the last five commit subjects (escaped, cut at 100 characters), labelled as repository data that doesn't update | turn |
| `model` | The session's model changed (the prompt is rebuilt) | turn |
| `permission-ask`, `permission-accept-edits`, `permission-bypass` | Code: the picker changed the mode | turn |
| `plan-on`, `plan-still-on`, `plan-off` | Code: plan mode started, continues, or the picker ended it | turn |
| `skills-added` | Skills installed since the prompt or the last announcement | turn |
| `connector-on`, `connector-off` | A connector's tools appeared or went away | turn |
| `safeguards-changed`, `workspace-settings-changed` | Safeguards turned on or changed; turned off (neutral wording, no claim that anything is lifted) | turn |
| `research` | Every message while Research is on and web search is enabled | turn |
| `ultracode-on`, `-still-on`, `-off` | Code: Ultracode started, continues (every ten person turns) or ended (§8) | turn |
| `refresher` | Right after a compaction, once per compaction cycle past 60% of the window, and every 30 person turns in Chat and Cowork; repeats the style guidance and lists open tasks | turn |
| `todo-nudge` | Code and Cowork: ten tool calls without a TodoWrite while the list has unfinished items | tool result |
| `instructions-nested` | Code and Cowork: the first file tool call in or under a folder with its own ATELIER.md, AGENTS.md, CLAUDE.md or CLAUDE.local.md (§1.5) | tool result |
| `output-cut` | A reply stopped at the output limit; the loop carries on once, after this note | its own hidden message |
| `background-agent` | Code and Cowork: a sub-agent started with `run_in_background` ended. Its task (escaped), how it ended (finished, ended without finishing, was stopped), that the person hasn't seen the result and that claimed edits want checking, then the result (escaped). Delivered at the parent's next model request, or on a turn it starts when the parent is idle (ARCHITECTURE §8) | its own hidden message |
| `session-message` | Code and Cowork: SendMessage from another of the person's sessions, the parent (to a sub-agent) or a sub-agent (to its parent). Who sent it (title and id or task id, escaped), that another agent wrote it and it is information, never the person's approval; when it waited for the person past the message chain cap or the wake cap, why; how to answer with SendMessage (left out when the receiver lacks the tool); then the message (escaped). Delivered like `background-agent` (ARCHITECTURE §8, "Messages between sessions") | its own hidden message |
| `loop-tick` | Code and Cowork: a loop's send (`/loop`). Says it comes from the person's loop, every `{{interval}}` while the conversation is idle, which run it is, to handle it as their request and to lead with what changed since the previous run | after the loop's prompt, on that message |
| `side-chat` | A side chat's every request (`/btw`, ARCHITECTURE §8 › Side chats): that it was asked beside the main session (its title) without interrupting it, to answer briefly from the conversation and the files and web, that its tools only read and the main work isn't its to continue, whether the main session is still working, then the main conversation so far in `<transcript>` (escaped, capped to the auto-compaction tail budget) | in front of the side chat's newest message, in what is sent only |
| `after-compaction` | On every compaction summary (§3.5) | summary message |

Not built yet: connector instructions, `file-changed`, `instructions-changed`, `unattended`, detecting an `ultracode`
keyword in a message (and a note for it), and the turn-budget notes of the effort work.

---

## 8. Effort and Ultracode

Effort is an API parameter, not prompt text: no core changes per level. The one effort sentence (§2.7) renders only
for models with an effort control.

Ultracode is the exception, because it changes how the model should work rather than how long it thinks. Its notes
are `notes/ultracode-*.md`, chosen by `ultracodeNote` in `agent/context-notes.ts`. `announce` sets
`TurnFacts.ultracode.on` from the level the run shows (`shownEffort`), not from what the session stored or what the
model is sent, so a session whose Ultracode the mode or the admin clamps away is treated as off, while one on a model
without Extra (a thinking switch, no levels) is on. Without the Agent tool the notes leave out sub-agents and ask the
model to try to refute its results itself. The cadence, recorded as
`ultracode: on|off` in the note part's `state` so branches, edits and compaction summaries know what they were told:

- `ultracode-on`, the full note, on the first turn of a branch that runs at Ultracode, again whenever it is switched
  back on, and on the first turn after a compaction (the summary's `after-compaction` part says only that Ultracode is
  on) unless the verbatim tail the compaction kept still holds the full note; a reminder there isn't enough: phased work, independent investigation and review spread over parallel sub-agents, one writer at
  a time, a fresh sub-agent trying to refute results, at most `{{maxReviewRounds}}` review rounds, failures that
  predate the change reported as such. It names the per-request sub-agent budget as `{{maxSubagents}}`, filled from
  `ULTRACODE_MAX_SUBAGENTS` (protocol `effort.ts`), the same constant the Agent tool enforces and the effort popover
  shows. It promises no token or time budget, since nothing enforces one yet.
- `ultracode-still-on`, two sentences, after ten person turns without an Ultracode note while it stays on, repeating
  the sub-agent budget.
- `ultracode-off`, two sentences, on the first turn after it is switched off or clamped away.

Sub-agents get none of them (they get no turn notes at all) and run at Extra. The review-round count is only asked
for; the harness doesn't count rounds.

### 8.1 Effort notes

What the effort level asks of a model whose own setting can't express it (protocol `effortGuidance`; the setting and
the words are described in ARCHITECTURE §8's Effort). `notes/effort-brief.md` (Low: answer directly and keep it
short), `effort-careful.md` (High: think it through and check the result), `effort-thorough.md` (Extra: steps,
more than one approach, check each step and claim, edge cases), `effort-exhaustive.md` (Max: the most rigor, verify
everything that can be, re-check the answer, say what could not be verified) and `effort-normal.md` (back to the
default). Each is one short paragraph that says "You don't need to mention this note." Recorded as `state.effort`, said
when the guidance starts or changes, again after ten person turns, and again after a compaction cut it off
(`effortNote` in `agent/context-notes.ts`). Medium, the model's usual way, has none; Ultracode has its own notes, plus Extra's guidance on a model whose own setting has
no Extra.

---

## 9. Optional extra safeguards

### 9.1 Default: nothing added

With safeguards off, the default, Atelier adds no content restrictions, refusal criteria, topic lists, warnings,
disclaimers or moralizing to any prompt, tool description, note or side prompt. Whatever the model and its provider
enforce on their own is all that applies. Atelier also doesn't claim that restrictions are lifted: saying nothing is
the neutral setting, and such claims make hosted models more guarded. With safeguards off the assembled prompt
doesn't mention them at all; tests check every mode and tier (§10).

What stays in default prompts because it isn't content policy: the permission system, confirmation before destructive
or outward-facing steps, data versus instructions and forged notes (in every core, §2), secrets handling, and rules
that reduce friction (no moralizing, no unrequested caveats, a one-sentence note when part of a request is left
undone).

Removed from the earlier prompts: Chat's "Safety" section with its rule about declining serious harm, and WebFetch's
limit to URLs the person gave or search returned.

When a provider stops a reply itself (`stopReason: 'refusal'`: Anthropic's refusal, an OpenAI or compatible content
filter), the transcript says "The model provider stopped this response. Edit your message or try again." with Edit
(which opens the person's message) and Retry. It is worded as the provider's doing, and Atelier never retries on its
own. A sub-agent's card shows the first sentence only.

### 9.2 Settings

System settings (`safeguards` in `protocol/src/settings.ts`, Admin › Capabilities › Content safeguards):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Safeguards for everyone on this server |
| `categories.sexual` | `true` | Explicit sexual content |
| `categories.hate` | `true` | Hate and violent extremism |
| `categories.harassment` | `false` | Harassment of real private people |
| `categories.selfHarm` | `false` | Self-harm, with `crisisResources` |
| `profile` | `adult` | `younger` adds rules for accounts that may belong to someone under 18 |
| `crisisResources` | `''` | A helpline the self-harm rules may name |

Per person, on the user record next to the role (not in preferences, which people edit themselves):
`safeguards: 'inherit' | 'on' | 'off'`, set in Admin › Users. Effective (`effectiveSafeguards` in
`protocol/src/accounts.ts`, shared by the backend and the UI): `inherit` follows `enabled`, `on` and `off` win over it.
The categories and profile are the system's. On with every category off and the adult profile counts as off: no block.

What people see: while safeguards apply to them, Settings › Account shows a read-only "Content safeguards" row ("On,
set by your administrator" and what it covers); while they don't, nothing. Regular users' settings carry only that
view (on with the categories and profile that apply, or off with none) and never the switch for everyone or the
helpline text; admins get the settings as they are. Admin › Capabilities says plainly that
safeguards are instructions to the model, which a determined person or a model that follows instructions poorly can
get around, and that only the model provider's own filters are a hard limit. Not built: a separate Admin › Safeguards
page (the settings sit in Admin › Capabilities), per-person category and profile overrides, the composer's shield
indicator, and a classifier.

### 9.3 The block

`safeguards.<tier>.md`, rendered with only the enabled categories, the younger section when selected, and the crisis
resource when set (`src/prompts/safeguards.ts`). It says the administrator turned the safeguards on for this account,
that they apply to everything produced in the session and come before the person's saved instructions and project
instructions; it limits declines to the listed categories, asks for one or two plain sentences that name the
workspace setting and offer an alternative, and forbids changing facts or favouring a political side because of it.
Each category lists what is still fine (sex education, arguing any political position, analysing extremism, criticism
of public figures, factual health questions without signs of risk, …).

The block is its own system block in every mode and in sub-agents (they inherit the person), never in compaction,
title or web-fetch prompts. Its hash is the hash of the rendered text, so editing the template reaches live sessions;
it is empty while safeguards are off, so category edits then rebuild nobody's prompt. A change rebuilds the snapshot
and adds the neutral note.

Prompt-only safeguards hold with models that follow their instructions; a determined person or an uncensored local
model can get around them. A classifier (a local guard model or an external moderation API) is a possible later step.

---

## 10. Tests

- **Assembled prompts** (`src/prompts/builder.snapshot.test.ts`): each case of `CASES` in
  `src/prompts/__fixtures__/prompt-cases.ts` runs through the real ChatService with fixed inputs and writes its system
  blocks, first-message notes and tools JSON to `src/prompts/__snapshots__/prompts/<case>.txt`. Cases: every mode in
  both tiers, Chat without web, with a project, with personalization, prompted tools, Code in plan mode, without effort,
  sub-agents (general and defined), compact Code with three large connectors and over its total budget, Chat with the
  administrator's instructions, and safeguards on for each mode and tier (default categories, all categories with the
  younger profile, per person, in a sub-agent).
- **Invariants** (`src/prompts/builder.test.ts`): templates match their embedding; guards resolve, renumber and reject
  unknown conditions (also in overrides); every core carries the rules of §2; compact cores have at most twelve rules
  and placeholder examples; the compact budget cuts in its order, never the core, safeguards or `<env>`, and not in the
  full tier; the administrator's instructions in every mode, ahead of the files and never cut; block
  order and the two breakpoints; the prefix and the tools JSON are byte-identical across models of a tier; no
  unrendered variable or guard; no absent tool is named, in the prompt, the first message's notes or the notes that can
  arrive later (output limit, plan mode); sub-agents get no Agent tool and nothing personal;
  the effort sentence follows the effort control; size budgets; safeguards absent by default and present globally, per
  person, in sub-agents and despite a core override, and no block when nothing applies; escaping, its case and
  attribute rules with generics and other code left alone, and the document and command wrappers; model developers.
- **Notes** (`agent/context-notes.test.ts`, `agent/chat-service.test.ts`): each note fires once per change; plan mode
  on every new branch, its notes naming only the session's tools; a retried message told what is true now; model
  switch and safeguards changes rebuild the prompt; the off note is neutral; refresher cadence; Ultracode's notes on
  the first turn, every tenth turn, when it is turned off, on an edited branch and after a compaction (unless the kept
  tail holds the full note), never for a clamped session or a sub-agent; the todo nudge; nested instruction files with
  escaped paths, in sub-agents too and forgotten when they finish (`agent/permissions-flow.test.ts`); the
  after-compaction part with skill names escaped as attributes; the output-limit continuation; escaping of the person's
  text and of attached documents; connector tools stay as first seen when a server reorders or edits them, a compact
  prompt's cut descriptions until the tier changes. The plan-mode refusal per tool set
  (`permissions/permissions.test.ts`). The sub-agent budget, and its return for a sub-agent that never started. A
  background sub-agent's note at the next request or on a turn of its own, once, and a loop's send with its note. A message between sessions at the receiver's next step or on a turn it starts, both ways between a parent and its background sub-agent, the refusals, and the message chain cap (`agent/session-messages.test.ts`).
- **Neutrality** (`src/prompts/neutrality.test.ts`): every template except the safeguards files, and every assembled
  case with safeguards off, is free of content-policy vocabulary; exceptions with reasons in
  `neutrality.allow.txt`.
- **Originality** (`src/prompts/originality.test.ts`, `scripts/check-prompt-originality.mjs`): the templates, the
  assembled snapshots (their prose; schema keywords and parameter names are fixed) and this file must not contain a
  marker from `scripts/prompt-signature-phrases.txt`. With `ATELIER_PROMPT_CORPUS` set to local copies of published
  prompts (colon-separated folders, never committed), any run of ten or more words shared with them fails
  and runs of eight or nine are listed for review; justified exceptions go in `scripts/prompt-originality.allow.txt`.
  Run it for every prompt change:

  ```sh
  ATELIER_PROMPT_CORPUS=/path/to/corpus-a:/path/to/corpus-b node packages/core/scripts/check-prompt-originality.mjs
  ```

- **UI**: the provider-stop notice with Edit and Retry, and a reply's Copy with escaped tags turned back
  (`features/chat/transcript.test.tsx`); escaped tags shown as text in replies, files verbatim
  (`features/chat/markdown.test.tsx`); the read-only safeguards
  row in Settings › Account (`account-page.test.tsx`); the administrator's instructions and the safeguards caveat in
  Admin › Capabilities (`capabilities-page.test.tsx`).
- **End to end** (`e2e/safeguards.web.spec.ts`): the fake model reports whether the block reached its system prompt;
  absent by default, present after an admin sets a person to On, absent again on Default. `e2e/effort.desktop.spec.ts`:
  Ultracode's note reaches the model on the first message only, and the off note once after a switch to Low.

Only real models can show whether the prompts change behaviour as intended, whether default prompts refuse no more
than an empty system prompt, and whether prompt-only safeguards hold on local models. The eval harness
(`pnpm eval`) is where those checks belong.

---

## 11. Not built yet

Parts of the design that the prompts are worded not to claim:

- the lean tier for the newest frontier models;
- built-in `explore` and `verify` sub-agents, and scheduling that runs one writing sub-agent at a time (the prompts ask
  for it; nothing enforces it);
- a read-only shell classifier for plan mode (shell commands stay blocked there);
- a read registry that makes Write and Edit refuse files not read in the session;
- Cowork's rule that deletes always ask;
- git attribution in `<env>`, the `unattended` note, and the knowledge cutoff from the model catalog;
- skipping nested instruction files in gitignored folders (dependency and build folders are skipped);
- a per-model compact budget;
- for safeguards: a separate Admin › Safeguards page, per-person categories and profile, the composer's shield
  indicator, and a classifier;
- moving the remaining model-facing text in TypeScript (response styles, the project wrapper, the prompted-tools
  specification, the permission refusals, the compaction wrapper) into `strings/`.
