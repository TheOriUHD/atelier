---
title: Hooks and plugins
description: Run your own commands at points of a Cowork or Code session with hooks, and bundle skills, commands, agents and hooks into plugins you install from a marketplace.
---

Two ways to extend Atelier beyond instructions and skills. **Hooks** are shell commands that run at fixed points of a
session and can block, allow or annotate what the model is about to do. **Plugins** bundle skills, commands,
sub-agents and hooks, and an admin installs them from a GitHub marketplace. Both use Claude Code's formats, so what you
have for Claude Code mostly works as it is; the differences are noted below.

## Hooks

A hook is a command Atelier runs for you at a point of a turn. Typical uses: refuse a command the model shouldn't run,
format a file after the model edits it, add a fact to the model's context when a session starts, or make the model keep
going until the tests pass.

Hooks run in **Cowork and Code**, where a session has a folder. Chat has no hooks. They run for a sub-agent's tool calls
too (`PreToolUse` and `PostToolUse` only).

### Where hooks come from

All matching hooks from every source below run; there is no override order between them.

| Source | Where you write it | Runs for |
|---|---|---|
| A project | `hooks` in `.atelier/settings.json` or `.atelier/settings.local.json`, and with **Claude Code compatibility** on, `.claude/settings.json` or `.claude/settings.local.json` | Sessions in that folder, wherever it lives (this computer, an SSH host, a codespace) |
| The admin | **Settings › Admin › Code › Automation › Hooks** | Sessions in folders on the backend's own machine, never on a person's own device |
| Claude Code's user settings | `hooks` in `~/.claude/settings.json` (desktop app, compatibility on) | Sessions in folders on this computer |
| Plugins | `hooks/hooks.json` in an enabled plugin | Sessions in folders on the backend's own machine |

<!-- screenshot: Settings › Admin › Code › Automation with the Hooks JSON editor -->

The project files are re-read every few seconds. The **Hooks** row is a JSON text area holding the hooks object itself
(without a `"hooks"` wrapper); **Save** is enabled once it parses. In every file
the shape is the same:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.atelier/hooks/no-push.sh\"", "timeout": 10 }]
      }
    ]
  }
}
```

Each event has a list of groups; a group has an optional `matcher` and a list of `hooks`. A hook has `"type": "command"`,
the `command` to run and an optional `timeout` in seconds (default 60, at most 3600). A hook that doesn't fit (a timeout of
0 or above 3600, an empty command) is skipped without a message.

### Events

| Event | Fires | `matcher` | A hook can |
|---|---|---|---|
| `SessionStart` | Before the first model request of a new session, and again after the model moves the session to another folder. | Ignored | Add context. |
| `UserPromptSubmit` | When you send a message, before the model sees it. | Ignored | Block the message; add context. |
| `PreToolUse` | Before each tool call runs, after deny rules and plan mode have had their say. | A tool name | Block the call; allow it, make it ask, or deny it; rewrite its input. |
| `PostToolUse` | After a tool call ran (whether it succeeded or failed). | A tool name | Add feedback or context to the result. The call has already happened. |
| `Stop` | When the model finishes a reply with nothing more to do. | Ignored | Send the model back to work. |

A `matcher` is a regular expression that must match the whole tool name: `Bash`, `Edit|Write`, `mcp__github__.*`. An empty
matcher or `*` matches every tool. Names are Atelier's (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`,
`WebSearch`, `Agent`, `Skill`, `TodoWrite`, `AskUser`, …, and `mcp__{connector}__{tool}` for connector tools; see
[Tools](/reference/tools/)). A matcher such as `Bash(npm *)` is a regular expression like any other and matches no tool.

### What a hook receives

The command runs on the machine the folder lives on (this computer, an SSH host or a codespace), through `/bin/sh -c`, or
through PowerShell on Windows. It starts in the project's folder with the event as JSON on standard input and two
environment variables, `CLAUDE_PROJECT_DIR` and `ATELIER_PROJECT_DIR`, both set to the folder:

```json
{
  "session_id": "…",
  "cwd": "/Users/ada/app",
  "hook_event_name": "PreToolUse",
  "permission_mode": "auto",
  "tool_name": "Bash",
  "tool_input": { "command": "git push origin main" }
}
```

`permission_mode` is `auto`, `default`, `acceptEdits`, `plan` or `bypassPermissions`. `PostToolUse` adds `tool_response` (the
tool's output as one string); `UserPromptSubmit` adds `prompt`; `SessionStart` adds `source` (always `startup`); `Stop` adds
`stop_hook_active` (true from the second round on). There is no `transcript_path`. Tool inputs use Atelier's field names:
`command` for `Bash`, `file_path` for `Read`, `Write` and `Edit`, `url` for `WebFetch`.

### What a hook answers

**Exit code.**

| Exit code | Meaning |
|---|---|
| `0` | Fine. Standard output is read (below). |
| `2` | Block. What the hook wrote to standard error is the reason (or `Blocked by hook: <command>` if it wrote nothing). |
| Anything else | A failure that blocks nothing. It is logged by the backend as `Hook failed (exit N): <command>` with the standard error; the conversation doesn't show it. |
| Timeout | Logged as `Hook timed out after 60s: <command>` (with the hook's own timeout in place of 60); blocks nothing. |

**Standard output on exit 0.** Plain text is added to the model's context for `UserPromptSubmit` and `SessionStart`, and
ignored by the other events. Output that starts with `{` is read as JSON:

| Field | Effect |
|---|---|
| `hookSpecificOutput.permissionDecision` | `allow`, `ask` or `deny` (`PreToolUse`). `deny` blocks, with `permissionDecisionReason` as the reason. |
| `decision` | `"block"` blocks, with `reason`; `"approve"` is the same as `allow`. |
| `hookSpecificOutput.updatedInput` | An object that replaces the tool's whole input (`PreToolUse`). |
| `hookSpecificOutput.additionalContext` | Text added to the model's context. |
| `continue: false` | With `stopReason`: ends the turn and shows the reason. Honored only for `UserPromptSubmit`. |

Other fields are ignored, and a field an event doesn't use (a rewritten input from `Stop`, say) has no effect there. What the
model or you see depends on the event:

- **`PreToolUse`** blocked: the tool call fails and the model reads `A PreToolUse hook blocked this call: <reason>`.
- **`PostToolUse`** feedback: added after the tool's output as `PostToolUse hook feedback: <reason>`, with any context.
- **`UserPromptSubmit`** blocked: your message is not sent to the model and the reply reads `A UserPromptSubmit hook
  blocked this message: <reason>`. While any `UserPromptSubmit` hook exists, a message you type while the model is working
  waits for the end of the turn instead of joining it, so the hook can see it.
- **`SessionStart`** and **`UserPromptSubmit`** context joins your message as a note only the model sees.
- **`Stop`** blocked: the reason is given to the model as `Stop hook feedback: <reason>` and it works on. This repeats at most
  three times a turn.

When several hooks match an event they run in parallel and their answers are combined: blocks are joined, `deny` beats `ask`
beats `allow`, the first `updatedInput` and first `stopReason` win, and added context is joined (at most 10,000 characters).
A rewritten input that no longer fits the tool's schema is refused with "A hook changed the input of Bash into something
invalid: …".

### Hooks and the permission rules

For each tool call, in this order:

1. The permission engine decides first: **deny rules**, plan mode's refusal, **ask rules**, allow rules and the mode. A
   deny rule (or plan mode's refusal) ends it there; no hook can allow what a deny rule blocks, and the hooks don't run.
2. `PreToolUse` hooks run. A block ends the call with the hook's reason.
3. If a hook rewrote the input, the rules judge the new input too, so a deny rule still catches it.
4. A hook's **allow** skips the prompt the mode would have raised, and Auto mode's review. It does not skip an **ask rule**
   or the warning for a dangerous command, which still go to Auto's reviewer or to you, one call at a time.
5. A hook's **ask** forces the prompt ("A PreToolUse hook asks for your approval.") and skips Auto's review.
6. With no hook opinion, the engine's decision stands: allowed, asked, or reviewed.

Hooks themselves run outside the permission system: they are commands you wrote, and nothing reviews them.

### Worked examples

The examples use `jq` and a POSIX shell; on Windows, hooks run in PowerShell and need to be written for it. Put the
scripts in `.atelier/hooks/` of the project.

**Never push (`PreToolUse` on `Bash`).** Exit code 2 and a message on standard error:

```sh
#!/bin/sh
# .atelier/hooks/no-push.sh
if jq -e '.tool_input.command | test("git push")' >/dev/null; then
  echo "Pushing is done by a person. Ask them to push." >&2
  exit 2
fi
```

The model sees `A PreToolUse hook blocked this call: Pushing is done by a person. Ask them to push.` The test is a text
match, so it catches the usual spelling and not every way of writing a push. For a rule that has to hold, add a deny rule
such as `Bash(git push *)` under **Settings › Admin › Code › Deny rules**: rules also look inside `git -C dir push`,
`sudo` and `xargs`, and no hook can allow what a deny rule blocks.

**Let plain read-only git run unasked (`PreToolUse` on `Bash`).** JSON on standard output. The pattern rejects anything with
shell syntax in it, because a hook's allow is as safe as its test:

```sh
#!/bin/sh
# .atelier/hooks/safe-git.sh
if jq -e '.tool_input.command | test("^git (status|diff|log)( [A-Za-z0-9_./@~^-]+)*$")' >/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"read-only git"}}'
fi
```

**Format what the model writes (`PostToolUse` on `Edit|Write`).**

```sh
#!/bin/sh
# .atelier/hooks/format.sh
file=$(jq -r '.tool_input.file_path')
case "$file" in
  *.ts|*.tsx|*.js|*.json|*.md) npx --no-install prettier --write "$file" >/dev/null 2>&1 ;;
esac
exit 0
```

**Keep a key out of the model (`UserPromptSubmit`).** Your message is stopped before the model or the provider sees it:

```sh
#!/bin/sh
# .atelier/hooks/no-keys.sh
if jq -e '.prompt | test("sk-[A-Za-z0-9]{20,}")' >/dev/null; then
  echo "That looks like an API key. Remove it and send the message again." >&2
  exit 2
fi
```

**Do not stop with failing tests (`Stop`).** `stop_hook_active` keeps the hook from insisting forever:

```sh
#!/bin/sh
# .atelier/hooks/check-tests.sh
if jq -e '.stop_hook_active' >/dev/null; then exit 0; fi
if ! npm test --silent >/dev/null 2>&1; then
  echo "The tests fail. Run them, fix the failures, then finish." >&2
  exit 2
fi
```

**Tell the model where things stand (`SessionStart`).** Plain output becomes context; no script is needed:

```json
{ "type": "command", "command": "git log --oneline -5" }
```

All of them wired together in `.atelier/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.atelier/hooks/no-push.sh\"", "timeout": 10 },
          { "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.atelier/hooks/safe-git.sh\"", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.atelier/hooks/format.sh\"", "timeout": 60 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.atelier/hooks/no-keys.sh\"" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.atelier/hooks/check-tests.sh\"", "timeout": 300 }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "git log --oneline -5" }] }
    ]
  }
}
```

### Where Atelier differs from Claude Code

:::caution
Hooks in Atelier follow Claude Code's format, with these differences.

- **Five events only:** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart` and `Stop`. `SubagentStop`, `Notification`,
  `PreCompact`, `SessionEnd` and others are kept in the file but never fire; **Settings › Admin › Code** says "{Event} hooks
  don’t run in Atelier."
- **Only `command` hooks run.** `http`, `prompt` and `agent` hooks parse but never run; the Hooks row says "“http” hooks
  under PreToolUse don’t run in Atelier; only “command” hooks do."
- **Matchers cover tool names only** and are ignored for events that have no tool. Tool names are Atelier's own (`Agent`,
  not `Task`; no `MultiEdit` or `NotebookEdit`).
- **No `transcript_path`** in the event, and `continue: false` stops a turn only from `UserPromptSubmit`.
- **A hook's `allow` does not answer calls an ask rule holds back**, nor a deny rule or the dangerous-command warning.
- **Failures are logged, not shown.**
:::

### Safety

A hook is a program you or a project's author chose to run, as you, with your files and network, unreviewed. A project's
`.atelier/settings.json` or `.claude/settings.json` can contain hooks, and they run as soon as a session works in that
folder. The **Trust this workspace?** question is the only gate; it is asked when you add a folder on this computer, on
an SSH host or a codespace. The backend keeps the answer: the hooks of a folder you haven't trusted don't run, whichever
client added it. Read the settings files of a downloaded project before you open it. Turning **Claude Code
compatibility** off (**Settings › Admin › Code › Compatibility**) makes Atelier ignore the `.claude` settings files,
but not `.atelier/settings.json`. Hooks from plugins and from the admin's **Hooks** row run on the backend's own machine
for everyone's sessions there. See [Security](/security/) and [Permissions](/permissions/).

## Plugins

A plugin is a folder that bundles any of these, usually with a `.claude-plugin/plugin.json` manifest (Atelier works without
one, with the default folder names):

| Part | Where | What it becomes |
|---|---|---|
| Skills | `skills/<name>/SKILL.md` | `/plugin:name` and the model's skill list as `plugin:name` |
| Commands | `commands/*.md` | `/plugin:command` |
| Sub-agents | `agents/*.md` | The `Agent` tool's type `plugin:agent` |
| Hooks | `hooks/hooks.json` (or inline in the manifest) | Hooks, as above; `${CLAUDE_PLUGIN_ROOT}` in a command becomes the plugin's folder |

A plugin cannot bring connectors: MCP servers in a plugin are not read (add them under [Connectors](/connectors/)). See
[Customize](/customize/) for the file formats.

```text
team-tools/
├── .claude-plugin/plugin.json
├── skills/changelog/SKILL.md
├── commands/ship.md
├── agents/reviewer.md
└── hooks/hooks.json
```

`plugin.json` needs little:

```json
{
  "name": "team-tools",
  "description": "Our review and release routines",
  "version": "1.0.0"
}
```

and `hooks/hooks.json` has the same shape as the `hooks` object above, wrapped in `"hooks"`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/format.sh\"", "timeout": 30 }] }
    ]
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` is replaced with the plugin's folder before the command runs, as plain text, so put it in quotes.

`skills`, `commands` and `agents` in the manifest can name other folders than the defaults (one path or a list); `hooks` can
name another file or hold the hooks object inline. A plugin's names are prefixed with the plugin's name so they can't
collide with yours: the skill `changelog` of `team-tools` is `team-tools:changelog`, and `/team-tools:ship` runs its
`ship.md` command.

### Install a plugin

<!-- screenshot: Settings › Admin › Plugins after Browse, listing a marketplace's plugins with Install buttons -->
Admins manage plugins in **Settings › Admin › Plugins** or on **Customize › Plugins**.

1. In **Add from a marketplace**, enter the marketplace's GitHub repository (`owner/repo` or a `github.com` URL) and choose
   **Browse**. Marketplaces you installed from before appear as **Added before:** buttons.
2. The page lists the plugins in it with their versions and descriptions. Choose **Install** on one. Atelier downloads the
   repository at its current commit and copies the plugin into its own folder (`plugins/cache` in the config folder).
3. The plugin appears under **Installed plugins**, on. Its skills, commands and agents are available to sessions at once.

A marketplace is a GitHub repository with `.claude-plugin/marketplace.json`:

```json
{
  "name": "acme-tools",
  "plugins": [
    { "name": "team-tools", "description": "Our review and release routines", "version": "1.0.0", "source": "./plugins/team-tools" },
    { "name": "lint-helper", "source": { "source": "github", "repo": "acme/lint-helper", "ref": "v2" } }
  ]
}
```

A plugin's `source` is either a path inside the marketplace repository or a GitHub repository (with optional `ref` and
`path`). Marketplace and plugin names are one plain word each (letters, digits, `.`, `_`, `+`, `-`, up to 64
characters). Plugins from other kinds of source are listed with "Plugins from “{kind}” sources can't be installed yet."
Only public GitHub repositories work.

| Message | Meaning |
|---|---|
| `Use owner/repo or a github.com URL for the marketplace.` | The text isn't a GitHub repository. |
| `That repository has no valid .claude-plugin/marketplace.json.` | Missing or malformed. |
| `owner/repo wasn't found (or is private).` | Public repositories only. |
| `acme-tools has no plugin named “x”.` | The plugin was removed from the marketplace. |
| `team-tools's source points outside its marketplace.` | A relative `source` that climbs out of the repository. |

### Turn on, off, remove, update

- **Enable {name}** turns a plugin on or off for everyone; off takes what it brings out of every session. The state is
  kept in the global settings as `enabledPlugins`, keyed `plugin@marketplace`.
- **Uninstall {name}** deletes a plugin Atelier installed.
- There is no update button: an installed plugin shows **Installed** in its marketplace. To take a newer version,
  uninstall it and install it again.
- **Settings › Admin › Developer › Reload connectors and extensions** reads skills, commands, agents and plugins again.

On the desktop app, plugins installed with Claude Code (`~/.claude/plugins/installed_plugins.json`) are used too, while
**Claude Code compatibility** is on. They carry a **Claude Code** badge and can only be switched on and off; turning one off
in Atelier never touches Claude Code's own settings. If the same plugin id is installed in both, Atelier's copy is used.

Everyone can see the installed plugins and what they bring (skills, commands and agents; **Customize › Plugins**
is read-only for non-admins). A plugin's hooks run but are not listed in the interface: open the plugin's folder to
read them.

### Trust

:::caution
A plugin is third-party code and instructions with no sandbox. Its hooks run shell commands as you; its skills, commands and
agents tell the model what to do, and a skill can ship scripts the model then runs. Atelier checks a marketplace's format and
refuses archives that unpack above 100 MB or write outside their folder, but it does not review what a plugin does. Install
only plugins from authors you trust, read their hooks first, and prefer a repository you control for anything that runs
commands.
:::

## Admin controls

| Control | Where | Effect |
|---|---|---|
| **Hooks** | **Settings › Admin › Code › Automation** | The system hooks, in Claude Code's JSON format. |
| **Claude Code compatibility** | **Settings › Admin › Code › Compatibility** | Reads `.claude` settings, plugins installed by Claude Code, `CLAUDE.md` and more; see [Claude Code compatibility](/claude-code-compatibility/). |
| **Installed plugins**, **Add from a marketplace** | **Settings › Admin › Plugins** | Install, enable, disable and uninstall plugins. |
| Connectors | **Settings › Admin › Connectors** | See [Connectors](/connectors/). |
| Allow, ask and deny rules | **Settings › Admin › Code** | A deny rule always wins over a hook; see [Permissions](/permissions/). |
