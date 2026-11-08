---
title: Atelier CLI
description: "Atelier in the terminal: a coding agent on your own models, with an Atelier server or on this computer alone. Install, set up, keys, commands, print mode and the background service."
---

Atelier CLI is a Code session in the terminal: the same agent, tools, permissions and models as the app's Code view,
laid out the way terminal coding agents are. It runs on its own, but it is best connected to an
[Atelier server](/self-hosting/): the server keeps the models, keys and sessions, and the terminal lends it the folder
you work in.

## Install

On macOS and Linux:

```sh
curl -fsSL https://updates.atelierhq.dev/cli | sh
```

On Windows (PowerShell):

```powershell
irm https://updates.atelierhq.dev/cli.ps1 | iex
```

It installs for you alone, no administrator rights needed:

| System | Where | The command |
|---|---|---|
| macOS, Linux | `~/.local/share/atelier/versions/<version>` | `~/.local/bin/atelier`, a link to the newest version |
| Windows | `%LOCALAPPDATA%\Atelier\cli\versions\<version>` | `%LOCALAPPDATA%\Atelier\cli\bin\atelier.cmd`, added to your PATH |

Each version brings its own Node.js and runner, so nothing else needs to be installed; git is used when it is there. A
package is about 40 MB. The script checks the download against the checksum written into it at release; to read it
first, download it, compare its sha256 with the one on the [release page](https://github.com/TheOriUHD/atelier/releases),
then run it.

`atelier update` updates it (`--beta` for the beta channel). Each update is checked against the release key's
signature before it is unpacked, as the desktop app's are. Connected to a server that mirrors releases
(`ATELIER_UPDATES_REPO`), it updates through the server. Once a day an installed copy looks whether a newer version is
out and says so under the tip.

To remove it, delete the versions folder and the command, and `~/.atelier/cli` for its settings and data.

## The first start

`atelier` in a project folder starts the setup the first time:

1. **How it should look:** matching the terminal, dark, light, or no colour.
2. **Where Atelier runs:**
   - **An Atelier server (recommended).** Models and keys are set up once, on the server. Sessions show up in the browser,
     the desktop app and on your phone. This computer lends the folders you open, through the background service
     (below). Servers on your network are found by themselves; another one is typed in (`https://` is tried first,
     `http://` only for addresses on your own network).
   - **Only this computer.** Atelier runs here with your own models and keys, kept in `~/.atelier/cli`. Sessions stay
     in the terminal. Ollama, LM Studio and llama.cpp running here are offered; ChatGPT plans and GitHub Copilot sign in
     with a code; Anthropic, OpenAI, Mistral, Mistral Vibe and OpenAI-compatible services take an API key.
3. **Signing in to the server:**
   - **In the browser** (servers from 0.6.0): the terminal shows a code, a link and a QR code. You approve it on the
     server's page where you are signed in, so passwords, passkeys and single sign-on all work, and so does a terminal
     with no browser (an SSH session: open the link on your phone).
   - **Username and password**, or **an invite code**, which makes your account.
   - A server that has no account yet asks for its setup token, and you make the first admin.
4. **What this computer lends the server:** new empty folders for sessions started without one, and your skills and
   instructions from `~/.claude` and `~/.atelier`.
5. **The model** new sessions start with, and **how much it asks** (Auto, Ask or Accept edits).
6. **Your terminal:** where Shift+Enter needs a setting (VS Code, Cursor, Windows Terminal), it can add it.

Each part can be run again: `atelier setup`, `atelier login`, `atelier connect <address>` (or `--local`).

The first time Atelier works in a folder it asks first. With a server, that answer lets the server's sessions run
commands as you in that folder, as a desktop app's trusted folder does ([Security](/security/)).

## In a session

- **Header:** Pip, the version, the model and effort, where it runs and the folder.
- **Transcript:**
  - Your messages follow `❯`, replies `◆`.
  - Each step is a line: `● Read src/app.ts · 84 lines`. The dot is green when the step worked, red when it failed,
    and the paint dab while it runs.
  - Edits show their changed lines, commands their last lines of output, and the task list stays above the message box
    while it is open.
- **The line while it works** says what it is doing and for how long, how many tokens so far, and what it waits on (a
  local model loading, a retry, a place in line).
- **Footer:** the mode, how full the context is, the connection, the model and effort.

| Key | What it does |
|---|---|
| Enter | Send. While a reply runs, the message waits its turn (↑ takes it back). |
| Ctrl+S | Send into the reply that is running. |
| Shift+Enter, Alt+Enter, Ctrl+J, `\` then Enter | A new line. |
| Esc | Stop the reply. Twice on an empty box: go back to an earlier message. |
| Shift+Tab | Auto → Ask → Accept edits → Plan. |
| Tab | Take the suggested next message. |
| Ctrl+O | Show thinking, then every step in full (the transcript is printed again). |
| Ctrl+T | Show or hide the task list. |
| Ctrl+R | Open another session. |
| Ctrl+G | Write the message in your editor (`$VISUAL`, `$EDITOR`). |
| Ctrl+V | Paste an image from the clipboard (or drop an image file's path). |
| `@` | A file in this folder. |
| `!` | Run a command here; its output goes with your next message. |
| Ctrl+C twice, Ctrl+D | Leave. A reply that is running goes on; `atelier -c` picks the session up. |

`/` opens the commands: the terminal's own (below) and the skills and commands of this folder and your account, which
run as they do in the app. [The CLI reference](/reference/cli/) lists all commands, keys and options.

- **Sessions:** `/clear`, `/resume`, `/fork`, `/rewind`, `/btw`, `/loop`, `/export`, `/copy`.
- **Model and context:** `/model`, `/effort`, `/mode`, `/compact`, `/context`, `/cost`.
- **Where you are:** `/status`, and `/open`, which opens the session in the browser (with a server).
- **Setting things up:** `/permissions`, `/mcp`, `/skills`, `/config`, `/statusline` (a command whose output is the
  status line, as in Claude Code; `/statusline import` takes yours), `/terminal-setup`.
- **Help:** `/init` (writes AGENTS.md), `/review`, `/doctor`, `/help`.

Sessions are the backend's: with a server, `/resume` lists the ones you started in the browser or the desktop app as
well, and the terminal's show up there.

## Print mode

`atelier -p "…"` answers one prompt and exits, for scripts and CI. Text piped in is added to the prompt.

```sh
git diff | atelier -p "write a commit message for this" --output-format text
atelier -p "fix the failing test" --allow "Bash(npm test *)" --allow Edit --output-format json
```

| Option | |
|---|---|
| `--output-format text` | The reply's text (the default). |
| `--output-format json` | One JSON object: `result`, `is_error`, `session_id`, `usage`, `cost_usd`, `model`, `duration_ms`. |
| `--output-format stream-json` | A JSON line per run event, then the result. |
| `--allow <rule>` | Allow calls like this without asking. Rules are written as in [Permissions](/permissions/). |

Nobody is there to answer a prompt: a call that would ask is denied, and the model is told how to allow it. Questions
are skipped and a plan is not approved. Exit codes: 0 done, 1 failed, 2 a usage limit was reached, 3 sign-in needed.

On a CI machine, `ATELIER_SERVER` and `ATELIER_TOKEN` connect without setup. The token is a terminal's sign-in:
`atelier token` prints the one this terminal uses. Anyone with it works as you, so keep it in the CI's secrets; it lasts
as long as it is used at least every 30 days, and signing that terminal out (Settings › Account › Sessions) ends it.

## The background service

One `atelier daemon` runs per person in the background, started by the first terminal that needs it:

- **On this computer only**, it runs the backend. All your terminals share one database, and a reply goes on when its
  terminal closes.
- **With a server**, it holds the connection that lends this computer's folders to the server (the device link), so a
  session's tools reach your files while any terminal is open.

It leaves 10 minutes after the last terminal closed with nothing running. `atelier daemon status` says how it stands,
`atelier daemon stop` ends it. `atelier daemon keep` starts it at login (launchd on macOS, systemd's user manager on
Linux, Task Scheduler on Windows), so a session you start in the browser or on your phone can work in this computer's
folders with no terminal open; `atelier daemon unkeep` takes that back.

Terminals reach it through a socket only you can open (a named pipe on Windows), and each must show the token in
`~/.atelier/cli/run/daemon.token`, which only you can read.

## Files

Everything is in `~/.atelier/cli` (`ATELIER_CLI_DIR` moves it):

| File | What it holds |
|---|---|
| `config.json` | Where it connects, the look, notifications, the default model and mode, the status line. |
| `device.json` | This computer's id and name on the server. |
| `trusted-folders.json` | The folders you let a server's sessions work in. |
| `lending.json` | What else this computer lends each server. |
| `history.jsonl` | What you sent, per folder (↑ and Ctrl+R). |
| `data/` | Only this computer: the backend's database, files and new empty folders. |
| `logs/daemon.log` | The background service's log. |

Your sign-in to a server, and the key that encrypts API keys kept on this computer, are in the system's own store: the
macOS keychain, the Secret Service on Linux (GNOME Keyring, KWallet) or DPAPI on Windows. Without one,
`credentials.json`, readable by you only. Your skills, commands, agents and instructions in `~/.claude` and
`~/.atelier` are found as in the desktop app ([Claude Code compatibility](/claude-code-compatibility/)).

## When something is wrong

`atelier doctor` checks the install, the server, the sign-in, the background service, the colours and Shift+Enter, and
says what to do. `/bug` copies the versions and where the logs are (no messages, no keys).

- **"macOS asks before Atelier reaches your network":** macOS asks each program before it reaches devices on your local
  network, and a server at home (or a domain that leads there) is one. The installed app asks as **atelier**, once:
  choose Allow. If you said no, turn "atelier" on under System Settings › Privacy & Security › Local Network (the setup
  can open that pane); your terminal app's switch doesn't cover it. The network search for servers needs the same.
- **"This server signs terminals in with a password only":** the server is older than 0.6.0. Update it, or sign in with
  your password (an account made by single sign-on sets one in Settings › Account).
- **Shift+Enter sends the message:** the terminal can't tell it from Enter. Use Alt+Enter or Ctrl+J, or `/terminal-setup`.
- **The colours are off:** `/theme`, or `--plain` for none.
