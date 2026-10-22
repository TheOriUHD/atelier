---
title: Customize
description: Teach Atelier how you and your projects work with instruction files, skills, custom commands and sub-agents, and change the prompts themselves.
---

Atelier can be taught in five ways, from a sentence of preference to the prompt text itself:

| What | It is | Where it lives | Used in |
|---|---|---|---|
| [Instructions](#instructions) | Standing rules in plain Markdown | Settings, and `ATELIER.md`, `AGENTS.md` and `CLAUDE.md` files | Chat (settings only), Cowork, Code |
| [Skills](#skills) | A folder with a `SKILL.md` that teaches the model one kind of task | `skills` folders | Chat, Cowork, Code |
| [Commands](#commands) | A saved prompt you start with `/name` | `commands` folders | Chat, Cowork, Code |
| [Sub-agents](#sub-agents) | A named helper with its own prompt, tools and model | `agents` folders | Cowork, Code |
| [Prompt overrides](#prompt-overrides) | A replacement for one of Atelier's own prompt files | `~/.atelier/prompts` | Everything |

Tools from other services are [connectors](/connectors/); commands that run at points of a session are
[hooks](/hooks-and-plugins/#hooks); a bundle of skills, commands, agents and hooks is a
[plugin](/hooks-and-plugins/#plugins). Atelier reads Claude Code's files and folders as well as its own: see
[Claude Code compatibility](/claude-code-compatibility/) for the full list.

## The Customize page

<!-- screenshot: the Customize page on the Skills tab, with Project, Global and Plugin badges -->
**Customize** in the Chat and Code sidebars opens one page with three tabs:

- **Skills:** every skill Atelier can see, badged **Project**, **Global** or **Plugin**, and **Only by /name** for a skill
  that sessions never start on their own. A skill installed from GitHub shows its source, commit
  (`from owner/repo 3f9a1c2`) and date. Problems with a skill's file (a name that doesn't match its folder, frontmatter
  that isn't YAML) show under it. **Project skills from** adds the skills of one folder to the list.
- **Connectors:** for admins the full [Connectors](/connectors/) page; for everyone else a read-only list of what the admin
  set up, with each connector's state and tools. Choose which ones a conversation uses under **+ › Connectors**.
- **Plugins:** for admins the full plugins page; for everyone else a read-only list of the installed plugins and what
  they bring.

Admins also get **Install from GitHub** under Skills and **Add plugins** in the **+** menu. The same lists are in
**Settings › Skills**, **Settings › Admin › Connectors** and **Settings › Admin › Plugins**.

## Instructions

Instructions are text the model is given with every conversation, ahead of its own defaults. They never override the
permission system or an administrator's content safeguards.

### The layers, in order of rank

| # | Layer | Where you write it | Applies to |
|---|---|---|---|
| 1 | **Administrator's instructions** | **Settings › Admin › Capabilities › Instructions for every conversation** (up to 20,000 characters) | Every Chat, Cowork and Code conversation and every sub-agent, for every account |
| 1 | **System `AGENTS.md`** | **Settings › Admin › Code › Instructions › System AGENTS.md** (up to 60,000 characters). Stored as `AGENTS.md` in the config folder (`~/.atelier` on the desktop, the data directory on a server); an `ATELIER.md` beside it is read too on a server | Code sessions and Cowork tasks, for every account |
| 2 | **What you say in the conversation** | The message box | That conversation |
| 3 | **Your own files** | Desktop only: `~/.claude/CLAUDE.md` (with Claude Code compatibility on) and `~/.atelier/ATELIER.md` | Your Code sessions and Cowork tasks |
| 3 | **Your ATELIER.md** | **Settings › Account › Instructions for Code and Cowork** (up to 60,000 characters; kept with your account, so it works on a server too) | Your Code sessions, Cowork tasks and their sub-agents. Where a project's `ATELIER.md` disagrees, yours wins |
| 3 | **Your instructions** | **Settings › Account › Instructions** (up to 20,000 characters), next to **What should Atelier call you?** and the response style | Every new conversation of yours, in all three modes |
| 4 | **The project's files** | `ATELIER.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` in the project folder and above it, and `.claude/rules/**/*.md` | Code sessions and Cowork tasks in that folder |

When two layers disagree, the lower number wins. Within a layer the more specific one wins: a file nearer the folder you
work in beats one further up, and in one folder `ATELIER.md` beats `AGENTS.md`, which beats `CLAUDE.md`
(`CLAUDE.local.md` wins over all the others in its folder). Chat gets only the administrator's text and your
personal **Instructions** from this list: it has no folder. Memory adds your saved Preferences as standing instructions
(see [Memory](/memory/)).

The model is told this order (the header is on [Shared prompts](/prompts/shared/#instruction-files-header)), and each
file arrives as its own block naming its source.

### Project files

For a Code session or Cowork task, Atelier reads these names in every folder from the **filesystem root down to the
folder you opened**, not only up to the repository root: a `CLAUDE.md` in your home folder or `~/Developer` applies to
every project below it. Outermost folders come first and the nearest last, so the nearest wins. In each folder the order is
`CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `ATELIER.md`, `CLAUDE.local.md`.

| File | Written by | Notes |
|---|---|---|
| `ATELIER.md` | You, and Atelier's agents | Atelier's own file. An agent asked to set up or update the project's instructions writes `ATELIER.md`, and adds a lasting preference you state there, telling you. It may keep more notes files and link them with `@path`. |
| `AGENTS.md` | You | Read for compatibility with other coding agents. |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` | You | Read while **Claude Code compatibility** is on (below). |
| `.claude/rules/**/*.md` | You | Every Markdown file under the project's `.claude/rules` loads (up to 200, in name order); path-scoping frontmatter is not interpreted. Needs compatibility on. |

Files are read wherever the project lives, including an SSH host or a codespace. Each file is cut at 60,000 characters (`[Truncated]`).

**Imports.** A line in an instruction file can pull in another file with `@path`: `@./docs/style.md`, `@../shared/rules.md`,
`@~/notes/me.md` or `@README.md`. The path needs a file extension; `@mentions`, emails and anything in a code span or
fenced block are ignored. Imports are followed up to four levels deep, and every file loads once. Your ATELIER.md from
Settings has no folder, so its `@path` lines are not followed.

**Nested files.** A file in a subfolder (`src/payments/AGENTS.md`) isn't loaded up front. The first time Read, Edit or Write
works under that folder, it is attached to the tool's result (up to 20,000 characters) with a note that it applies only
there and ranks below the administrator, you and the project root's files. `node_modules`, `vendor`, `.venv`, `venv`,
`target`, `dist`, `build` and `.git` are skipped. See `instructions-nested` in the [context updates](/prompts/context-updates/).

A conversation keeps the instructions it started with; new or changed files apply to new conversations.

### Claude Code compatibility

**Settings › Admin › Code › Compatibility › Claude Code compatibility** (on by default) controls whether Atelier also
reads what Claude Code uses: `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules` and `~/.claude/CLAUDE.md`;
permission rules and hooks in `.claude/settings.json`, `.claude/settings.local.json` and the desktop's
`~/.claude/settings.json`; the `.claude` skills, commands and agents folders; and plugins installed by Claude Code. It
does not affect `AGENTS.md`, `ATELIER.md`, the `.atelier` and `.agents` folders, or **Import from Claude Code** for
connectors. Turn it off if a project's Claude Code files shouldn't steer Atelier. Details are on
[Claude Code compatibility](/claude-code-compatibility/).

## Skills

A skill is a folder with a `SKILL.md` that teaches the model how to do one kind of task: a release-notes routine, how your
team writes migrations, a house style for reports. The model sees each skill's name and description, loads the full text
with the `Skill` tool when a request matches, and follows it. You can also start one yourself.

### Where skills live

| | This computer | A project |
|---|---|---|
| Atelier's own | `~/.atelier/skills` | `.atelier/skills` |
| Shared with other agents | `~/.agents/skills` (desktop) | `.agents/skills` |
| Claude Code's | `~/.claude/skills` (desktop, with compatibility on) | `.claude/skills` (with compatibility on) |

On a server the global folder is `skills` in the data directory, and there is no `~/.agents` or `~/.claude`. When two skills share a name, the first found wins in this order: project folders (`.atelier`, `.agents`,
`.claude`), then global ones, then plugins; a folder linked into two places counts once. Every immediate subfolder with a
`SKILL.md` is a skill; folders starting with a dot are skipped.

New skills show up without a restart, including ones added with `npx skills add … -g`. A running conversation is told about
them with your next message (`skills-added` in the [context updates](/prompts/context-updates/)).

### The file

```markdown
---
name: release-notes
description: Draft release notes from the commits since the last tag. Use when asked for a changelog or release notes.
argument-hint: "[since-tag]"
---

Run `git log $ARGUMENTS..HEAD --oneline` and group the commits under Added, Changed and Fixed.
Skip merge commits. Use the script `${CLAUDE_SKILL_DIR}/scripts/group.py` if there are more than 40.
```

| Frontmatter | Meaning |
|---|---|
| `name` | Lowercase letters, digits and hyphens. Defaults to the folder name. An invalid name shows a warning in Settings and falls back to the folder name; a valid name that differs from the folder name is used, with a warning. |
| `description` | **Required**; a skill without one is ignored without a message. Say what it does and when to use it: that is all the model sees until it loads the skill. Cut at 1,024 characters. |
| `disable-model-invocation: true` | Only `/name` starts it; it is left out of the model's list. Shown as **Only by /name**. |
| `user-invocable: false` | Leaves it out of the `/` menu; the model can still load it. |
| `argument-hint` | Shown after the name in the `/` menu, such as `[since-tag]`. |

Other fields Claude Code defines (such as `allowed-tools`) are ignored. The frontmatter is read leniently: if it isn't
valid YAML, only `name` and `description` are used and Settings shows "The frontmatter isn’t valid YAML; only its name and
description were read."

In the body, `$ARGUMENTS` is replaced with what you typed after the name, and `$0`, `$1`, … with its words (counting from
0). If the body mentions neither, the arguments are appended as `ARGUMENTS: …`. `${CLAUDE_SKILL_DIR}`,
`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_SESSION_ID}` are filled in. The model is told the skill's
base directory, so a skill can ship scripts and reference files next to it and the model can read them (on the desktop
they are reachable from a project on the same computer).

### What the model sees

Names and descriptions go into the system prompt as an `<available_skills>` list, each description cut at 250
characters. The list gets about 1% of the model's context window (four characters a token), and at least 2,000 characters;
when it doesn't all fit, it ends with "(N more not listed; the Skill tool can load any skill by name.)". Models with a small
window may see names only. The `Skill` tool takes the exact name (`plugin:skill` for a plugin's).

### Starting one yourself

Type `/` at the start of a message to get the menu: Atelier's own commands first, then your skills (those not marked
`user-invocable: false`), then your custom commands. Pick one and add arguments (`/release-notes v1.2`), or choose a skill
from **+ › Skills**, which inserts `/name `. The skill's text joins your message as a hidden part.

### Installing from GitHub

Admins install skills from **Settings › Skills › Install from GitHub** (also on the Customize page): paste `owner/repo`,
`owner/repo@ref/path` or a `github.com` URL (`…/tree/<ref>/<path>` works too) and choose **Install**. Atelier downloads the
repository at that ref (the default branch if none) and copies every folder that has a `SKILL.md` within three levels of
the path (or just the folder itself if it has one). Public repositories only, up to 100 MB unpacked.

On the desktop the skills go to `~/.agents/skills`, linked from `~/.claude/skills` (with compatibility on), the layout
`npx skills -g` uses, so Claude Code and other agents see the same installs; on a server they go to the data directory.
Atelier notes what it installed in its own lock file (`skills-lock.json`) and never touches another tool's. Skills added by
other tools show up in the list by themselves and are removed with the tool that added them; only Atelier's installs have an
uninstall button.

| Message | Meaning |
|---|---|
| `Use owner/repo, owner/repo@ref/path, or a github.com URL.` | The source isn't in a form Atelier understands. |
| `owner/repo wasn't found (or is private).` | Public repositories only. |
| `No SKILL.md found under the repository root.` | Nothing to install there. |
| `skills/pdf has no description in its SKILL.md.` | The skill lacks the required `description`. |
| **Replace pdf?** | A skill with that name exists that Atelier didn't install; replacing overwrites it. |

## Commands

A custom command is a saved prompt you start with `/name`. It is a Markdown file in a `commands` folder:
`.atelier/commands` or `.claude/commands` in a project, `~/.atelier/commands` or `~/.claude/commands` on this computer
(Claude Code's with compatibility on), and a plugin's `commands` folder. A subfolder (one level) only groups files; the command is named
after the file (`review.md` is `/review`). A skill with the same name wins. A plugin's are `/plugin:name`.

```markdown
---
description: Review the staged changes
argument-hint: "[focus]"
---

Review the staged changes in git. Focus on: $1
```

`/review security performance` sends "Review the staged changes in git. Focus on: security". In commands `$ARGUMENTS` is the
whole text after the name and `$1`, `$2`, … its words, counting from 1 (skills count from 0). If the file mentions neither,
the arguments are appended as `ARGUMENTS: …`. The description in the `/` menu is the `description` field or, without one,
the first line of the file, cut at 120 characters. File names may use letters, digits, `_` and `-`, up to 64 characters.

## Sub-agents

In Cowork and Code the model can hand work to a sub-agent through the `Agent` tool. Besides the built-in
`general-purpose` agent, you can define your own as a Markdown file in an `agents` folder: `.atelier/agents` or
`.claude/agents` in a project, `~/.atelier/agents` or `~/.claude/agents` on this computer, or a plugin's `agents` folder
(named `plugin:agent`). The file name or `name` is lowercase letters, digits and hyphens.

```markdown
---
name: reviewer
description: Reviews a diff for bugs and missing tests. Use after a change is finished.
tools: Read, Grep, Glob
model: sonnet
maxTurns: 12
---

You review code. Read the changed files, look for bugs, risky assumptions and missing tests, and report findings only.
Do not change anything.
```

| Field | Meaning |
|---|---|
| `name` | Defaults to the file name. |
| `description` | **Required** (the file is ignored without it). It is what the model reads to pick the agent, listed in the `Agent` tool's description. |
| `tools` | Comma-separated list or YAML list of the tools it may use; empty or `*` means all of the parent's. |
| `disallowedTools` | Tools it may not use. |
| `model` | `inherit` or nothing: the same model as the session. `opus`, `sonnet`, `haiku` or `fable`: the model you assigned to that name under **Settings › Admin › Models › Aliases** (not set means the session's own model). Anything else is read as a model, as `provider/model` (for example `ollama/qwen3:32b`). |
| `maxTurns` | A ceiling on its steps, replacing the default. |

The body is the agent's whole prompt, in place of Atelier's generic sub-agent prompt. Other Claude Code fields (such as
`color` or `skills`) are ignored. A sub-agent works in the same folder, permission mode and instruction files as the
session, can't ask you questions, and doesn't start sub-agents of its own; every call it makes goes through the same
permission check. On a server that holds only one model at a time, a definition's model is replaced by the session's to
avoid swapping models mid-task. The permission rule `Agent(reviewer)` allows or blocks one agent by name.

## Prompt overrides

Every prompt Atelier sends is a Markdown file you can replace. Put a file with the same relative name in
`~/.atelier/prompts` (on a server, the `prompts` folder in the data directory), for example
`~/.atelier/prompts/chat.full.md` for Chat's full prompt or `~/.atelier/prompts/notes/research.md` for the Research note.
Atelier reads the folder again when it changes; a file that is empty is ignored; a name that isn't a template is never
used.

Conversations keep the system prompt they started with, so try an override in a new conversation. Guards
(`<!-- if:Skill -->…<!-- endif -->`) and `{{app}}`-style variables work as in the originals, and an unknown guard
condition is an error, not ignored: the conversation fails with an
error such as `Unknown condition "Skil" in prompt template chat.full`. Other template errors read `Nested guard in prompt
template …`, `Unmatched <!-- endif --> in prompt template …` and `Unclosed guard in prompt template …`. The optional
safeguards block is added by Atelier, not by a template, so an override can't remove it. Overrides apply to everyone on a
server. The file names, variables and guards are on [Prompts](/prompts/).

## Who can change what

| | You | Admins |
|---|---|---|
| Instructions | Your **Instructions**, **Your ATELIER.md**, project files | Instructions for every conversation, the system `AGENTS.md`, compatibility |
| Skills | Add folders on your computer; the list in **Customize** | Install and uninstall from GitHub |
| Commands, sub-agents | Add files on your computer or in a project | The same, for the server's own folders |
| Connectors | Switch them per conversation under **+ › Connectors** | Add, sign in, set tool permissions |
| Plugins | See them | Install, enable, disable, uninstall |
| Hooks | Project settings files | **Settings › Admin › Code › Hooks** |
| Prompts | | Files in the config folder |
