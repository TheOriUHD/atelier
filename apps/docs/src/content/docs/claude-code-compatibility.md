---
title: Claude Code compatibility
description: Exactly which of Claude Code's files, formats and names Atelier reads, and where its behavior differs.
---

Atelier reads many of the files Claude Code uses, so a project set up for Claude Code mostly works without a conversion
step. This page lists what is read, from where, what is only partly supported, and what is not. Several things below
look the same and are not.

How to read it:

* **Supported** means Atelier reads and applies the file or field. **Partly** means some fields or forms work. **Not
  supported** means it is ignored.
* Atelier's side is checked against the code. Claude Code's side follows its public documentation at the time of
  writing ("Claude Code documents" marks those statements); it changes quickly, so check it for anything that matters
  to you.

## What Atelier reads

| Feature | Where Atelier looks | Status |
|---|---|---|
| [Instruction files](#instruction-files) | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` from the folder up; `~/.claude/CLAUDE.md` on the desktop | Supported |
| [Rules](#rules-and-imports) | `.claude/rules/**/*.md` in the folder | Partly (`paths:` ignored) |
| [`@path` imports](#rules-and-imports) | Inside instruction files, 4 levels deep | Supported, inside the session's folders |
| [Skills](#skills) | `.claude/skills`, `~/.claude/skills`, and plugins | Partly |
| [Slash commands](#slash-commands) | `.claude/commands`, `~/.claude/commands`, and plugins | Partly |
| [Agents](#agents-sub-agents) | `.claude/agents`, `~/.claude/agents`, and plugins | Partly |
| [Plugins and marketplaces](#plugins-and-marketplaces) | `~/.claude/plugins/installed_plugins.json` (on and off only); GitHub marketplaces for installs | Partly |
| [Hooks](#hooks) | `hooks` in `.claude/settings*.json`, `~/.claude/settings.json`, plugins | Partly (5 events, command hooks) |
| [Connectors (MCP)](#connectors-mcp) | One-time import of `~/.claude.json` and `.mcp.json` | Partly (import, not live reading) |
| [Permission rules](#settings-files-and-permission-rules) | `permissions.allow/ask/deny` in `.claude/settings*.json` and `~/.claude/settings.json` | Partly |
| [Other settings keys](#settings-files-and-permission-rules) | `.claude/settings*.json` | Not supported |
| [Tool names](#tool-names-and-parameters) | In rules, hook matchers and agent `tools` | Partly |
| [Model aliases](#model-aliases) | `opus`, `sonnet`, `haiku`, `fable` in agent files | Supported, through a mapping you set |

Where the table says `~/.claude`, it is read on the person's own computer. The desktop app's own backend reads its
computer's. A server reads it through the desktop app of the computer a session's folder is on: a folder on that computer,
or an SSH host reached from it, while that desktop is online and signed in to the server. Sessions with no folder on one
of the person's computers (chats, codespaces, folders on the server) get none of it. Permission rules and hooks in
`~/.claude/settings.json`, Claude Code plugins' hooks, and skills' scripts apply only to folders on that same computer,
not to SSH hosts reached from it.

What a server may read there is fixed by the desktop: `~/.agents/skills`, `~/.claude/{skills,commands,agents,plugins}`,
`~/.atelier/{skills,commands,agents}`, `~/.claude/CLAUDE.md`, `~/.atelier/ATELIER.md`, and `.md` files of at most 256 KB
that those import. Of `~/.claude/settings.json` it sends only `permissions`, `hooks` and `enabledPlugins`, never `env`.
Claude Code's credentials, `~/.claude.json`, history and transcripts are never read. The person can stop it in the desktop
app (what this computer lends the server, in **Settings › System**). Skills and plugins from there are listed "From
{computer}", and switching such a plugin on or off is the person's own choice, over the admin's.

## The admin switch

**Settings › Admin › Code › Compatibility › Claude Code compatibility** is on by default. With the switch **off**,
Atelier stops reading all of this:

* `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` in a project and above it, `~/.claude/CLAUDE.md` and
  `.claude/rules/**`.
* `.claude/skills`, `.claude/commands` and `.claude/agents` in a project, and the same three under `~/.claude`.
* Permission rules and hooks from `.claude/settings.json`, `.claude/settings.local.json` and `~/.claude/settings.json`.
* The plugins installed with Claude Code (`~/.claude/plugins`), and the link Atelier adds in `~/.claude/skills` when it
  installs a skill.

What keeps working with the switch off: `AGENTS.md` and `ATELIER.md`, everything under `.atelier/` and `~/.atelier/`,
`.agents/skills` and `~/.agents/skills`, skills, plugins and connectors that Atelier installed, and the one-time
**Import from Claude Code** for connectors. The switch applies to
everyone on that backend. Instruction files are read when a session starts, so turning the switch off affects new
sessions; permission rules and hooks are read again within a few seconds.

## Instruction files

Code and Cowork sessions read these; Chat has no folder and reads none.

| File | Read from | Notes |
|---|---|---|
| `CLAUDE.md` | The session's folder and every folder above it, up to the filesystem root | The folder is the git top level when the folder you chose is in a repository. |
| `.claude/CLAUDE.md` | Same | |
| `CLAUDE.local.md` | Same | Ranks last within its folder. |
| `AGENTS.md` | Same | Always loaded, also when a `CLAUDE.md` exists. |
| `ATELIER.md` | Same | Atelier's own file. Ranks above `AGENTS.md` and `CLAUDE.md` in the same folder. |
| `~/.claude/CLAUDE.md` | On your computer (see above) | Counts as your personal instructions. Needs the compatibility switch. |
| Files in subfolders | On demand | The first time a `Read`, `Edit` or `Write` works in or below a folder that has one of these files, it is added to the tool result. `node_modules`, `vendor`, `.venv`, `venv`, `target`, `dist`, `build` and `.git` are skipped. |

Files load from the outermost folder to the nearest, so the nearest ranks highest. Each file is cut at 60,000
characters. The rank order between sources (administrator, you, project) is described on
[Customize](/customize/) and in [Prompts](/prompts/).

Not supported: Claude Code's `claudeMdExcludes`, managed or organization `CLAUDE.md` files, and loading instruction
files from extra directories.

### Rules and imports

* `.claude/rules/**/*.md` is read from the session's folder only (not `~/.claude/rules`), at most 200 files, all
  loaded on every session. A `paths:` front matter that scopes a rule to certain files (which Claude Code documents) has
  no effect: the rule is always on, and its front matter is part of the text.
* **`@path` imports** work as in Claude Code for relative, absolute and `~/` paths (`@./docs/style.md`, `@~/notes.md`,
  `@README.md`), up to four levels deep, each file once, skipping code spans and fenced blocks. In Atelier the path
  needs a file extension, and a path with spaces is not supported.
* Imports are read through the same runner as every other file access, so a file outside the session's folders is
  not followed (it is silently skipped). Claude Code documents an approval dialog for such imports; Atelier has none.
  Imports in `~/.claude/CLAUDE.md` can reach your home folder.

## Skills

A skill is a folder with a `SKILL.md`. Atelier looks, in this order, and the first skill with a name wins:

| Order | Location | Notes |
|---|---|---|
| 1 | `.atelier/skills`, `.agents/skills`, `.claude/skills` in the session's folder | Only at the folder's root: a `.claude/skills` in a subfolder is not found. |
| 2 | `<config>/skills`, `~/.agents/skills`, `~/.claude/skills` | `<config>` is `~/.atelier` on the desktop and the server's data folder on a server. The last two (and `~/.atelier/skills` on a server) are read on your computer (see above). |
| 3 | `skills/` of enabled plugins | Named `plugin:skill`. |

A skill reached twice through a symlink counts once. Atelier installs skills into `~/.agents/skills/<name>` and, with
compatibility on, links `~/.claude/skills/<name>` to it, the layout `npx skills -g` uses; **Settings › Skills** lists
what it finds, including skills other tools installed.

| `SKILL.md` front matter | Status |
|---|---|
| `name` | Supported. Lowercase letters, digits and hyphens; anything else falls back to the folder name, with a warning in Settings. |
| `description` | Supported and required. A skill without one is skipped. Whitespace is collapsed and the text is cut at 1,024 characters (250 in the skill list). |
| `disable-model-invocation: true` | Supported: kept out of the skill list; you start it with `/name`. |
| `user-invocable: false` | Supported: hidden from the `/` menu. |
| `argument-hint` | Supported, shown in the `/` menu. |
| `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `paths`, `hooks`, `when_to_use`, `arguments` | Not supported. Ignored without a warning. |

Front matter that is not valid YAML is read leniently: only `name` and `description` are taken, with a warning.

In the text of a skill, `$ARGUMENTS`, `$0`, `$1` and so on (numbered from 0), `${CLAUDE_SKILL_DIR}`,
`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}` and `${CLAUDE_SESSION_ID}` are filled in. When the text has no
placeholder for the arguments, `ARGUMENTS: <text>` is appended. Not supported: `$ARGUMENTS[N]` (the `$ARGUMENTS` part is
replaced by all the arguments and `[N]` stays as text), named arguments,
quoting of multi-word values (arguments split on whitespace), `${CLAUDE_EFFORT}`, `${CLAUDE_PLUGIN_DATA}`, and the
`` !`command` `` form that runs a command before the skill is shown to the model.

Only the name and description go into the system prompt, as `<available_skills>`, capped at about 1% of the model's
window (at least 2,000 characters). The full text is loaded by the `Skill` tool, or by you typing `/name args`.

## Slash commands

Markdown files in a `commands` folder, started with `/name`.

| Where | Notes |
|---|---|
| `.atelier/commands`, `.claude/commands` in the session's folder | |
| `<config>/commands`, `~/.claude/commands` | The second is read on your computer (see above). |
| `commands/` of enabled plugins | Named `plugin:name`. |

* The file name (without `.md`) is the command name, 1 to 64 letters, digits, `_` or `-`. A file in a subfolder (one level
  down) is found, but the folder is **not** part of the name: `frontend/component.md` is `/component`, where Claude Code
  documents `/frontend:component`. Two files with the same name: the first found wins.
* A skill and a command with the same name: the skill wins.
* Front matter: `description` (else the first line of the text) and `argument-hint`. `allowed-tools`, `model` and the
  rest are ignored.
* In the text, `$ARGUMENTS`, `$1`, `$2`... and `${CLAUDE_PLUGIN_ROOT}` are filled in. **Commands number their
  arguments from 1; skills from 0.** Claude Code's current documentation treats command files like skills and numbers
  from 0, so a command file written for it that uses `$0` gets an empty string here.
* A command or skill runs when your message is exactly `/name` or `/name arguments`, in a top-level session. It joins
  your message as a hidden part. Sub-agents do not expand slash commands.

Built-in commands are Atelier's own, not Claude Code's: `/compact [focus]` and `/rewind` (Code), `/loop` (Cowork and
Code), `/clear`, `/model` and `/btw` (every mode with a session). Claude Code's own built-in commands, such as `/init`,
do not exist here. See [Chat](/chat/), [Code](/code/) and [Shortcuts](/shortcuts/).

## Agents (sub-agents)

Markdown files whose front matter describes the agent and whose body is its system prompt.

| Where | Notes |
|---|---|
| `.atelier/agents`, `.claude/agents` in the session's folder | Only `*.md` files directly in the folder; subfolders are not read. |
| `<config>/agents`, `~/.claude/agents` | The second is read on your computer (see above). |
| `agents/` of enabled plugins | Named `plugin:agent`. |

| Front matter | Status |
|---|---|
| `name` | Lowercase letters, digits and hyphens; otherwise the file name is used. `general-purpose` is reserved for the built-in agent. |
| `description` | Required. A file without one is skipped. |
| `tools` | Supported: a comma-separated string or a YAML list; `*` means all. Names must be Atelier's [tool names](#tool-names-and-parameters), connector tools by their full `mcp__server__tool` name. |
| `disallowedTools` | Supported. |
| `model` | Supported: `opus`, `sonnet`, `haiku` or `fable` map through your [aliases](#model-aliases); `inherit` or none means the parent's model; any other text is used as a model reference (`provider/model`), so a bare Claude model ID is not translated. |
| `maxTurns` | Supported. It replaces the ceiling of 200 model calls (150 for compact-tier models). |
| `skills`, `permissionMode`, `hooks`, `mcpServers`, `memory`, `background`, `effort`, `isolation`, `color`, `initialPrompt` | Not supported. |

The model starts one with the `Agent` tool. The built-in
agent is `general-purpose` only; Claude Code's built-in Explore and Plan agents do not exist. A sub-agent runs as a
child session with its parent's folder, permission mode and rules. It cannot ask you questions or start sub-agents.
Permission rules `Agent(name)` and `Task(name)` both match it.

## Plugins and marketplaces

| Part | Status |
|---|---|
| Reading plugins installed by Claude Code (`~/.claude/plugins/installed_plugins.json`, file version 2) | On your computer (see above). You can switch them on or off in Atelier; that never touches Claude Code's files. A plugin counts as on unless Claude Code's `~/.claude/settings.json` has `enabledPlugins` set to `false` for it, or you changed it in Atelier. |
| Installing from a marketplace | **Settings › Admin › Plugins › Add from a marketplace** takes `owner/repo` or a `github.com` URL with a `.claude-plugin/marketplace.json`. Admins only. |
| Marketplace plugin sources | A relative path string, or `{ "source": "github", "repo": ..., "ref": ..., "path": ... }`. Other kinds (`url`, `git-subdir`, `archive`, ...) are listed, and cannot be installed ("Plugins from “...” sources can't be installed yet."). |
| Where installs go | `<config>/plugins/cache/<marketplace>/<plugin>/<version>`, recorded in `<config>/plugins/installed.json`. The version is the entry's, or the first 7 characters of the commit. |

What a plugin can bring: **skills, commands, agents and hooks**. The manifest (`.claude-plugin/plugin.json`) is
optional; Atelier reads `name`, `description`, `version`, and the `skills`, `commands`, `agents` and `hooks` fields.
Components default to `skills/`, `commands/`, `agents/` and `hooks/hooks.json`.

Not supported: a plugin's MCP servers (`.mcp.json`, `mcpServers`), LSP servers, output styles, monitors, `bin/`, its
own `settings.json`, `userConfig` and `dependencies`. Differences that bite:

* A manifest `skills`, `commands` or `agents` path list **replaces** the default folder. Claude Code documents that
  `skills` adds to `skills/`.
* A `commands` field written as an object map is not understood: the manifest is then treated as missing (the name
  comes from the install id and the default folders are used).
* A plugin's hooks run only for folders on the backend's own computer.
* `${CLAUDE_PLUGIN_ROOT}` is filled into hook commands, skills and commands as text; it is not exported as an
  environment variable, and `${CLAUDE_PLUGIN_DATA}` is not supported.

See [Hooks and plugins](/hooks-and-plugins/).

## Hooks

Hooks use Claude Code's settings shape: an event, a list of matcher groups, and in each group a list of handlers.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./check.sh", "timeout": 30 }] }
    ]
  }
}
```

**Where hooks come from**, all combined: `~/.claude/settings.json` (desktop, folders on this computer), enabled
plugins and **Settings › Admin › Code › Automation › Hooks** (folders on the backend's computer), and the project's
`.atelier/settings.json`, `.atelier/settings.local.json`, `.claude/settings.json` and `.claude/settings.local.json`. A
project's hooks run in the session's workspace through its runner, including on an SSH host. Chat has no hooks.
Matching hooks of one event run in parallel.

| Event | Status |
|---|---|
| `PreToolUse` | Supported. Can block, force a prompt, allow, or rewrite the input. |
| `PostToolUse` | Supported. Feedback and context are appended to the tool result. |
| `UserPromptSubmit` | Supported. Can block the message; its output joins the message as context. |
| `SessionStart` | Partly. Runs at a session's first turn (and again after the model moves the session to another folder), always with `source: "startup"`. |
| `Stop` | Supported. A block sends the model back to work, at most 3 rounds in a row. |
| Every other event | Not supported. Claude Code documents more than thirty (`SubagentStop`, `PreCompact`, `Notification`, `SessionEnd`, ...). The hooks setting shows "`<event>` hooks don’t run in Atelier." and they never run. |

| Detail | Atelier |
|---|---|
| Handler types | `command` only. `http`, `prompt`, `agent` and `mcp_tool` handlers show “`<type>` hooks under `<event>` don’t run in Atelier; only “command” hooks do.” |
| Command shell | `/bin/sh -c`; on Windows PowerShell. Working folder is the session's folder. |
| Matcher | A regular expression that must match the whole tool name (`Edit\|Write` works). Empty or `*` matches all. Comma lists (`Edit,Write`) do not work. Events that are not about a tool ignore the matcher. |
| Timeout | `timeout` in seconds; default 60, at most 3,600. A timeout does not block. |
| stdin JSON | `session_id`, `cwd`, `hook_event_name`, `permission_mode`, and as they apply `tool_name`, `tool_input`, `tool_response` (the tool's text output, a string), `prompt`, `source`, `stop_hook_active`. There is no `transcript_path`. |
| Environment | `CLAUDE_PROJECT_DIR` and `ATELIER_PROJECT_DIR`, both the session's folder. |
| Exit code 2 | Blocks; stderr is the reason. Any other non-zero exit is a non-blocking error. |
| JSON on stdout | `decision`, `reason`, `continue`, `stopReason`, and `hookSpecificOutput.permissionDecision` (`allow`, `ask`, `deny`), `permissionDecisionReason`, `updatedInput`, `additionalContext`. Plain stdout of `UserPromptSubmit` and `SessionStart` is context. |
| `permission_mode` values | `auto`, `default`, `acceptEdits`, `plan`, `bypassPermissions` (no `dontAsk`). |

A hook cannot override a deny rule, and a hook's "allow" does not skip the prompt for a command that Atelier flags as
dangerous. If several hooks answer, deny beats ask beats allow. The first rewritten input wins.

## Connectors (MCP)

Atelier does **not** read `.mcp.json` or `~/.claude.json` while it runs. Connectors live in the system settings
(`mcpServers` in `settings.json`), are managed by admins in **Settings › Admin › Connectors**, and are shared by
everyone on that backend. That is different from Claude Code, where `.mcp.json` is a project file and
`~/.claude.json` holds your own servers.

On the desktop, **Import from Claude Code** (Settings › Admin › Connectors) reads `~/.claude.json` (user servers and
each project's servers) and the `.mcp.json` of the folders you opened on this computer, shows them with check boxes,
and writes the ones you pick. Credentials written into them (tokens in `env`, headers or the URL) are moved into
[Keys & secrets](/security/). Nothing is written until you confirm.

In the desktop app signed in to a server, **Customize › Connectors › Your connectors** has the same import: what you
pick becomes [your own connectors](/connectors/#your-own-connectors-on-a-server), with their keys kept as your secrets on
the server, and the ones that run a program run on that computer, which the import allows for exactly the command line
it shows.

| Item | Status |
|---|---|
| `type` `stdio`, `http`, `sse` | Supported. An entry with `url` and no `type` imports as `http`; without `url` as `stdio`. stdio servers run only in the desktop app. |
| `type` `ws`, `sdk`, or `streamable-http` | Not imported. |
| `command`, `args`, `env`, `url`, `headers` | Supported. |
| `${VAR}` and `${VAR:-default}` | Supported in `env`, `headers` and `url` only (not in `command` or `args`), resolved when connecting, plus Atelier's `${secret:id}`. A variable with no value and no default stops the connection with "Missing the environment variable VAR." instead of being left as text. |
| `oauth` block (`clientId`, `callbackPort`, `scopes`), `headersHelper`, `timeout`, `alwaysLoad` | Not supported; dropped on import. A server can use `auth: "oauth"`, which an admin signs in once. |
| Tool names | `mcp__<server>__<tool>`, other characters replaced by `_`, at most 64 characters. Permission rules `mcp__server`, `mcp__server__tool` and `mcp__server__*` work. |
| Approval of project servers | None, because nothing is read from a project automatically. |

See [Connectors](/connectors/).

## Settings files and permission rules

Atelier's own settings are in `settings.json` in its config folder (`~/.atelier` on the desktop) with its own keys.
It does not read Claude Code's `settings.json` as a whole. From `.claude/settings.json`,
`.claude/settings.local.json` (project) and `~/.claude/settings.json` (desktop, folders on this computer) it reads
exactly these:

* `permissions.allow`, `permissions.ask` and `permissions.deny` (lists of rule strings).
* `hooks`.
* `enabledPlugins` in `~/.claude/settings.json`, for the on or off state of plugins installed by Claude Code.

Every other key is ignored: for example `permissions.defaultMode`, `permissions.additionalDirectories`, `env`, `model`,
`statusLine`, `mcpServers` and `outputStyle`. The project's `.atelier/settings.json` and `.atelier/settings.local.json`
contribute the same two things, permissions and hooks.

All sources are combined into one list per kind, and the order of evaluation is **deny, ask, allow**, whatever file a
rule came from. "Always allow in this project" writes `.atelier/settings.local.json` and keeps it out of git through
`.git/info/exclude`; "Always allow everywhere" is stored in your account, not in a file. Atelier never writes to
Claude Code's settings files.

### Rule syntax

The rule is `Tool` or `Tool(specifier)`. Tool names are case-sensitive.

| Rule | Meaning in Atelier |
|---|---|
| `Bash(npm test)` | That exact command. |
| `Bash(npm run *)` | A wildcard. A trailing ` *` also matches the bare command (`ls *` matches `ls`, never `lsof`). |
| `Bash(git status:*)` | Legacy form, the same as `Bash(git status *)`: a word boundary, so `Bash(ls:*)` matches `ls` and `ls -la` but not `lsof`. |
| `Read(./src/**)`, `Edit(/docs/**)` | Path patterns. `//path` is absolute, `~/path` is under your home folder, `/path` is under the project folder, `./path` or a bare path is under the session's folder; a bare file name matches at any depth. |
| `WebFetch(domain:example.com)` | That host **and its subdomains**. A `*` in the domain does not work. |
| `Agent(name)` or `Task(name)` | The sub-agent of that name. |
| `Skill(name)` | The skill with that name, or a plugin skill ending in `:name`. |
| `mcp__server`, `mcp__server__tool`, `mcp__server__*` | A connector's tools. Only a trailing `__*` is a wildcard. |

`Edit` covers `Edit`, `Write`, `MultiEdit` and `NotebookEdit`; `Read` covers `Read`, `Glob` and `Grep`. A specifier on
any other tool (`WebSearch(...)`, `PowerShell(...)`) never matches. Bash rules are checked against every simple command
of a compound line; deny and ask rules also see through wrappers such as `time`, `timeout`, `sudo` and `xargs`, and
allow rules need every command allowed. In Auto mode, allow rules for a bare `Bash`, an interpreter or `Agent` are
ignored.

### Permission modes

| Atelier (label) | Claude Code name | Notes |
|---|---|---|
| Auto (the default) | `auto` | A reviewing model decides what would prompt. |
| Ask | `default` | |
| Accept edits | `acceptEdits` | |
| Plan | `plan` | |
| Bypass | `bypassPermissions` | |
| (none) | `dontAsk` | Not available. |

The default for new sessions is set in **Settings › Admin › Code › Permissions**. A `permissions.defaultMode` in a
`.claude` file is not read. See [Permissions](/permissions/).

## Tool names and parameters

The model sees Atelier's tools under these names. They are the names to use in permission rules, hook matchers and
agent `tools` lists. The complete list with every description and parameter is in the
[Tools reference](/reference/tools/).

| Atelier tool | Notes against Claude Code's names |
|---|---|
| `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`, `Skill`, `TodoWrite`, `ExitPlanMode`, `TaskStop`, `ToolSearch` | Same names. |
| `Agent` | Same name as Claude Code's current one. There is no `Task` tool, but `Task(...)` rules still match `Agent`. Parameters: `description`, `prompt`, `subagent_type`, `run_in_background` (no `model` or `isolation`). |
| `AskUser` | Claude Code documents `AskUserQuestion`. A hook matcher or `tools` entry written for that name does not match. Up to 4 questions of 2 to 4 options. |
| `artifact` | Lowercase and not the same tool as Claude Code's `Artifact`: it creates, updates or rewrites a page shown in Atelier's artifact panel (`command`: `create`, `update`, `rewrite`). In Code it shows a file instead. |
| `BashOutput`, `KillShell` | Read the output of, and stop, a background command started with `run_in_background`. |
| `SendMessage`, `ListSessions` | Messages between your own sessions and sub-agents. |
| `ChangeDirectory`, `MemorySearch`, `MemoryView`, `MemoryUpdate`, `ChatSearch`, `ChatRead`, `inline_visual` | Atelier's own. |

Atelier has no tool named `MultiEdit`, `NotebookEdit`, `PowerShell`, `EnterPlanMode`, `EnterWorktree`,
`ExitWorktree`, `LSP`, `Monitor`, the `Cron*` tools, `TaskCreate`, `TaskGet`, `TaskList` or `TaskUpdate`. Rules and
matchers that name them are accepted and never match anything.

Parameter differences that matter in practice: `Bash` takes `timeout` in milliseconds (default 120,000, at most
600,000); `Read` takes `offset` (a 1-based line) and `limit`; `Grep` has `output_mode`, `-i`, `-n`, `-A`, `-B`, `-C`,
`glob`, `type`, `multiline` and `head_limit`; `WebFetch` needs only `url` (`prompt` is optional); `WebSearch` has
`freshness` and `topic`. Which tools a session gets depends on its mode; see [Cowork](/cowork/) and [Code](/code/).

## Model aliases

Agent files written for Claude Code ask for `opus`, `sonnet`, `haiku` or `fable`. Atelier does not know which of your
models that means, so you choose: **Settings › Admin › Models › Aliases** has one row for each name, set to "Not set"
until you pick a model. An alias that is not set means "use the parent's model". See [Models](/models/).

## Migration tips

* On the desktop, with compatibility on, there is nothing to convert: open the folder and Atelier reads the
  `.claude` files in it. On a server, project files are read through the folder's runner, and `~/.claude` through the
  desktop app of the computer the folder is on.
* Run **Import from Claude Code** once to bring your MCP servers over.
* Set the four [aliases](#model-aliases) if your agents or skills name a model.
* Rename `AskUserQuestion` to `AskUser` anywhere you match tool names, and drop hooks on events Atelier lacks.
* If a project has both `CLAUDE.md` and `AGENTS.md`, Atelier loads both. Keep the text in one and import it from the
  other with `@AGENTS.md`; a file imported by another loaded file is read once.
* Check hook matchers (no comma lists), the 60-second default timeout, and scripts that read `transcript_path`.
* Move `` !`command` `` blocks out of skills: have the skill tell the model to run the command.
* In a command file the first argument is `$1` (`$0` is empty); in a skill it is `$0`, and `$ARGUMENTS[0]` is not
  understood (it becomes all the arguments followed by `[0]`).
* Write `WebFetch(domain:example.com)` rather than `WebFetch(domain:*.example.com)`; the first also covers subdomains
  here and the second matches nothing.

## Things that look the same but are not

* **`AGENTS.md` and `CLAUDE.md` both load.** Claude Code documents that it reads `AGENTS.md` only when no `CLAUDE.md`
  exists in or above the folder.
* **Project skills beat personal skills.** Atelier takes the first skill with a name, project folders first. Claude
  Code documents the reverse: a personal skill overrides a project skill.
* **Hook matchers are always anchored regular expressions.** Claude Code documents exact names and `|` or `,` lists,
  and unanchored patterns for anything else. Here `Edit,Write` matches nothing, and `Fetch$` does not match
  `WebFetch`.
* **Hook defaults differ.** 60 seconds instead of Claude Code's documented 600 for commands; `tool_response` is a
  string; no `transcript_path`; `CLAUDE_PLUGIN_ROOT` is text-substituted, not an environment variable.
* **`/path` in a rule is anchored at the session's folder** even when the rule is in `~/.claude/settings.json`, where
  Claude Code documents anchoring at the settings location.
* **Nested `.claude/skills`, `.claude/commands` and `.claude/agents` below the folder's root are not found.**

Report any difference that is not listed here.
