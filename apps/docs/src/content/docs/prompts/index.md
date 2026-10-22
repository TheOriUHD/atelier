---
title: System prompts and instructions
sidebar:
  label: Overview
description: Every prompt Atelier gives a model, in full. Where to read them, how a session's prompt is assembled, and how to change them.
---

Atelier talks to models with text it ships: a system prompt per mode, a few single-purpose prompts, short notes that
update a running conversation, and a description for every tool. The project wrote all of it, and these pages publish
it word for word. The short messages the program puts into a tool result (a refusal, an error) are in the code, not
here.

## Get the prompts

| I want to… | Go to |
|---|---|
| Read Chat's system prompt | [Chat prompts](/prompts/chat/) |
| Read Cowork's | [Cowork prompts](/prompts/cowork/) |
| Read Code's | [Code prompts](/prompts/code/) |
| Read the fragments (search, artifacts, memory), the sub-agent prompt, the optional safeguards and the instruction-file header | [Shared prompts](/prompts/shared/) |
| Read the prompts for Auto mode review, compaction, memory updates, titles and web page questions | [Side prompts](/prompts/side-prompts/) |
| Read the notes that update a running conversation (permission mode changed, plan mode, effort, Ultracode, a connector…) | [Context-update notes](/prompts/context-updates/) |
| Read what every tool is described as, and its parameters | [Built-in tools](/reference/tools/) |
| See the complete text a model receives in a typical session | [Assembled prompts](/prompts/assembled/) |
| Understand how all of it is assembled, cached and tested | [How prompts are built](/prompts/design/) |
| Download everything | [`atelier-prompts.md`](/prompts/atelier-prompts.md) · [`atelier-prompts.json`](/prompts/atelier-prompts.json) |

### In the repository

The templates are plain Markdown files, one per prompt:

```text
packages/core/prompts/
  chat.full.md  chat.compact.md        Chat
  work.full.md  work.compact.md        Cowork (the mode's internal name is "work")
  code.full.md  code.compact.md        Code
  subagent.md                          sub-agents without a prompt of their own
  auto-mode.md  compaction.md  memory-update.md  title.md  web-fetch.md
  safeguards.full.md  safeguards.compact.md
  fragments/    search, no-search, artifacts, memory
  notes/        one file per context-update note
  strings/      the instruction-file header
```

From a checkout of the repository, `pnpm prompts:show` lists them, `pnpm prompts:show chat.full` prints one, and
`pnpm prompts:show --assembled code.full` prints the complete assembled text of a Code session (`--all` prints every
template). The assembled examples live in `packages/core/src/prompts/__snapshots__/prompts/`, and the tool
descriptions are in `packages/core/src/tools/`.

### In your own sessions

The pages here show the shipped text. Your sessions add your folder, instruction files, skills, memory and settings,
so the exact request differs; [Assembled prompts](/prompts/assembled/) shows how the pieces combine. The app cannot
show the exact text a session sent: the request inspector (**Settings › Admin › Developer › Record provider
requests**) lists requests to your model providers with address, status, timing and masked headers, but never prompts
or replies.

## What a model receives

A session’s system prompt is built when the session starts, from these pieces, in this order:

1. **The core prompt** for the mode and the model’s tier (or the sub-agent prompt).
2. **Fragments** that match the tools the session has: searching and citing, artifacts, memory.
3. **The optional safeguards block**, only if an administrator or the person turned it on. Atelier adds nothing of this
   kind by default.
4. **`<env>`**: the app, the mode, the model and who developed it, the date, and in Cowork and Code the folder and platform.
5. **Instructions**: your administrator’s text, then the instruction files (`ATELIER.md`, `AGENTS.md`, `CLAUDE.md`,
   rules). See [Customize](/customize/).
6. **The skill list**, **your personalization** (name, personality, response style, your own instructions), the
   **memory** digest and a project’s instructions and files, where the mode has them.

The request also carries the **tool definitions** ([Built-in tools](/reference/tools/), plus any connector tools), and the
person’s messages, each of which can carry a hidden [context-update note](/prompts/context-updates/) in front of it.

The system prompt stays the same so the provider’s prompt cache keeps working. It is rebuilt only when the model, its
tier, the safeguards, the memory digest or the set of tools changes (a connector switched on or off counts). Every
other change (the date, the permission mode, plan mode, effort, new skills) reaches the model as a short note in the
conversation, and so does the change that caused a rebuild. The design reasons, cache breakpoints and size budgets are
in [How prompts are built](/prompts/design/).

## Two tiers

| Tier | For | Style |
|---|---|---|
| **Full** | Anthropic and OpenAI models, and large models Atelier recognizes by name | Calm sentences that give the reason for each rule. |
| **Compact** | Every other model, which includes most local ones | At most twelve short numbered rules, the most important first, one example call per core tool, and the language rule repeated last. The whole system prompt plus the tools JSON is held to 16,000 characters where possible. |

Atelier picks the tier from the provider and the model id; **Settings › Admin › Models** can override it per model
([Models](/models/)).

## Change a prompt

You can override any template without touching the source: put a file with the same relative name in the `prompts`
folder of your Atelier config (`~/.atelier/prompts/` on the desktop, the `prompts` folder in the data directory on a
server). For example `~/.atelier/prompts/chat.full.md` replaces Chat’s full-tier prompt and
`~/.atelier/prompts/notes/plan-on.md` replaces a note. Atelier rereads the folder whenever it changes. A conversation
keeps the system prompt it started with until something that prompt states changes (for example the model), so try an
override in a new conversation; a note uses the new text from the next message.

- Keep the guards (`<!-- if:… -->` … `<!-- endif -->`) and variables (`{{app}}`) you still want. A guard with a condition
  Atelier does not know is an error, so a typo cannot silently keep or drop text.
- The optional safeguards block is added by the builder, not by a template, so overriding a core prompt cannot remove it.
- Prompts are written to work together: the cores refer to `<env>`, to context updates and to the instruction-file
  header. Changing one without the others can change how a model treats your instructions.

## What the prompts promise

The design principles are printed in full in [How prompts are built](/prompts/design/#0-principles). In short:

- **Atelier’s own words.** The prompts aim for Code to work like a careful coding agent and for Chat and Cowork to
  work like a good assistant. Every sentence is Atelier’s own.
- **Compatible where people rely on it.** Tool and parameter names stay Claude Code’s (`Read`, `Edit`, `old_string`,
  `run_in_background`, `subagent_type`…), so existing `CLAUDE.md` files, skills, agents and hooks keep working. See
  [Claude Code compatibility](/claude-code-compatibility/).
- **Nothing added by default.** The shipped prompts carry no topic restrictions, refusal criteria or disclaimers.
  What the model and its provider do on their own is all that applies. Safety for an agent that acts (permissions,
  destructive steps, instructions hidden in files and web pages, secrets) is not content policy and stays in the
  prompts where it applies.
- **Describe only what exists.** A prompt never names a tool, setting or feature the session does not have.
- **The harness enforces; the prompt explains.** Permissions, plan mode and approvals are enforced in code. A prompt
  sentence is never the only thing between a model and a destructive step ([Permissions](/permissions/)).

## How the prompts are tested

The prompts are code, and are tested like code:

- **Snapshots.** The assembled prompt of every kind of session is stored as text, so any change to a template, a tool
  description or the assembly shows up as a diff in review ([Assembled prompts](/prompts/assembled/)).
- **Published copies.** These pages are generated from the templates and the snapshots, and a test fails when they are
  stale.
- **Size budgets.** Code’s core and fragments, its tool descriptions, Chat’s and Cowork’s cores and the compact total
  each have a character limit that a test enforces.
- **Neutrality.** A test fails if a shipped prompt or note uses content-policy vocabulary while safeguards are off.
- **Originality.** A test checks that no prompt uses the signature phrases of other products’ prompts.
- **Behaviour evals.** `pnpm eval` runs the agent against real models for planted instructions, reply language and
  refusals, among other things.
