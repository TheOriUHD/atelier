---
title: Data and files
description: Every folder and file Atelier reads or writes on a computer or a server, how settings files are laid out, and how to move, back up, export and delete your data.
---

Atelier keeps its state in the places listed on this page. Outside them it writes only what you ask for (an export you
save, the update disk image a Mac offers to download), the launch-at-login entry, and the files the agent itself creates in
the folders you open.

## Where things live

| What | Desktop app, **Run on this computer** | Server (Docker image) |
|---|---|---|
| Config folder (settings, skills, prompts overrides) | `~/.atelier` | `/data` (same as the data folder) |
| Data folder (database, attachments, scratch folders) | `~/.atelier/data` | `/data` |
| The app's own profile (sign-in, window and browser caches) | Electron's user data folder, see [below](#the-desktop-apps-profile) | none |
| Secrets key | your OS's secure storage (Keychain, Credential Manager, Secret Service) | `/data/secret.key`, or `ATELIER_SECRET_KEY` |
| Per-project files | `.atelier/` and instruction files inside each folder you open | the same, inside the folder or codespace where it lives |

On Windows `~` is your user profile (`C:\Users\you`), so the data folder is `C:\Users\you\.atelier\data`.

**Settings › System › Data folder** (desktop app only) shows the path and has a **Show in Finder** button (**Show in
Explorer** on Windows, **Show in folder** on Linux). In the desktop app connected to a server, that row shows the
app's own profile folder instead, because the server holds the data.

When you run the server from source without `ATELIER_DATA_DIR`, it uses a folder named `.atelier-data` in the directory
you started it from. The image sets `ATELIER_DATA_DIR=/data` and runs as an unprivileged user (`atelier`).

## The config folder

The config folder holds what you could write by hand. Atelier watches it, so edits take effect without a restart.

| Entry | What it is |
|---|---|
| `settings.json` | System settings, written by admins in Settings. See [Settings files](#settings-files). |
| `AGENTS.md` | The **System AGENTS.md** (**Settings › Admin › Code**): instructions every Code session and Cowork task follows, for every account. |
| `ATELIER.md` | On the desktop, your own personal instruction file for Code and Cowork. On a server, a system-level file read like `AGENTS.md`. |
| `skills/`, `commands/`, `agents/` | Skills, slash commands and sub-agent definitions that belong to Atelier. See [Customize](/customize/). On the desktop, skills you install go to `~/.agents/skills` instead (see below). |
| `skills-lock.json` | Which GitHub skills were installed from where (Settings › Skills › Install from GitHub). |
| `plugins/cache/`, `plugins/installed.json` | Plugins Atelier installed, and the list of them. See [Hooks and plugins](/hooks-and-plugins/). |
| `prompts/` | Your overrides of Atelier's built-in prompts: a file named like the template (`chat.full.md`, `notes/date.md`) replaces it. Empty files are ignored. See [Prompts](/prompts/). |
| `skills-cache/` | Created by the runner in every home folder where it runs (this computer, SSH hosts, codespaces) for downloaded skill files. The only part of `~/.atelier` a session's file tools can reach by default. |
| `data/` | The data folder (desktop only; on a server it is the config folder itself). |

On the desktop, Atelier also reads and writes folders it shares with other agents:

| Path | What |
|---|---|
| `~/.agents/skills/` | Where skills you install from Settings are put (the layout `npx skills -g` uses). |
| `~/.claude/skills/`, `~/.claude/commands/`, `~/.claude/agents/` | Read when Claude Code compatibility is on (**Settings › Admin › Code › Claude Code compatibility**, on by default). With compatibility on, installing a skill also links it from `~/.claude/skills`. |
| `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.claude/plugins/` | Read with compatibility on: your personal instructions, permission rules and hooks, and the plugins Claude Code installed. Atelier never writes to them. |

## The data folder

| Entry | What it is |
|---|---|
| `atelier.db` | The SQLite database: accounts, sign-in sessions (as hashes), conversations and every message, projects, artifact versions, memory, per-person preferences, usage records, workspaces and devices, passkeys, and the encrypted secrets. While Atelier runs you will also see `atelier.db-wal` and `atelier.db-shm`: they belong to the database and are part of any copy. |
| `blobs/` | Attachments, images, generated files and other large content, each stored once under its SHA-256 name (`blobs/ab/cd/abcd…`). The database says what refers to what. |
| `secret.key` | Server only: the 32-byte key that encrypts stored secrets, base64, mode 0600. Absent when `ATELIER_SECRET_KEY` is set. |
| `screen-lock.json` | Desktop, **Run on this computer** only: the optional screen lock (a scrypt hash, auto-lock minutes, failed-attempt count). Deleting it removes the lock. See [Security](/security/#screen-lock-on-this-computer). |
| `scratch-workspaces/<account id>/scratch-<date>-<hex>/` | The empty folders (`<account id>` is an internal id, not a username) Code and Cowork sessions get when you choose **No folder**. They stay on disk when the session is deleted. |
| `chat-sandboxes/<account id>/chat-<date>-<hex>/` | Desktop only: the folder of a chat's sandbox (the model's Bash and Read in Chat). On a server the sandbox is in its own container instead. |
| `ssh/` | Desktop only: a small askpass helper Atelier writes to answer `ssh` prompts for saved connections, and short-lived `askpass-*.log` files that record the questions `ssh` asked (never your answers). |
| `sandbox/id_ed25519` | Server only: the key the server uses to log in to the sandbox container. Its public half is published to the `sandbox-keys` volume. |
| `sandbox/slots.json` | Server only: which account has which Unix user in the sandbox container (`sbx000`, `sbx001`, …). Back it up with the rest: the users own the accounts' chat folders in `sandbox-home`. The sandbox refuses a user the server gives to another account than before, so a lost file does not hand one account another's folders. |
| `home/` | Server image only: `HOME` is `/data/home`, so whatever the GitHub CLI, Git or SSH keep in the home folder survives container recreation. |

Atelier keeps no application log; see [Troubleshooting](/troubleshooting/#reading-logs).

### What is encrypted and what is not

- **Encrypted:** provider API keys, connector tokens, sign-ins for ChatGPT Plan and GitHub Copilot, saved SSH
  passwords, and OAuth tokens. On a server they use AES-256-GCM with `secret.key`; in the desktop app they are encrypted
  with Electron's `safeStorage`, which keeps its key in your OS account's secure storage.
- **Not encrypted:** conversations, memory, files and settings. Anyone who can read the data folder can read them. The
  screen lock hides the app; it does not encrypt anything. Use your disk's encryption (FileVault, BitLocker, LUKS) for
  that.

Because the desktop's encryption key belongs to your OS account, **a copy of the data folder on another computer or
under another OS account cannot decrypt the stored keys**. Chats and files come across; you add the provider keys again.

## The desktop app's profile

The desktop app keeps a few small files of its own in Electron's user data folder:

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/Atelier` |
| Windows | `%APPDATA%\Atelier` |
| Linux | `~/.config/Atelier` |

| File | What it is |
|---|---|
| `connection.json` | Your choice at first run: `{"mode":"local"}` or `{"mode":"server","serverUrl":"…"}`. Deleting it brings the first-run choice back (**Log out** and **Change setup…** do the same). |
| `session.bin` | Your sign-in token for the chosen server, encrypted with the OS's secure storage. It is bound to the server address it was issued for. |
| `device.json` | A random id that names this computer as one of your devices. |
| `trusted-folders.json` | The folders you trusted here, as a JSON list of absolute paths. A server you are signed in to can start work only inside these. |
| `updates.json` | The update channel and whether Atelier checks by itself: `{"channel":"stable","automatic":true}`. `channel` is `stable` or `beta`; `automatic` is **Settings › System › Check for updates automatically**. A missing or unreadable file means stable and automatic. |
| `update-staging/` | macOS only: a downloaded update waiting for you to quit Atelier. |
| `Partitions/atelier-browser`, `Partitions/atelier-chatgpt-chat` | The Code Browser pane's cookies and storage, and the ChatGPT Chat provider's browser session. The second holds your chatgpt.com sign-in, so it is as sensitive as a browser profile. |
| the rest | Chromium's own profile (caches, local storage, preferences). |

Uninstalling Atelier removes the app only. Your `~/.atelier` folder and this profile stay.

## Settings files

There are two kinds of settings, stored differently:

- **System settings** (what admins change under **Settings › Admin**) are one JSON file, `settings.json` in the config
  folder. They apply to everyone on that backend.
- **Personal preferences** (theme, default model, memory switches, privacy, your instructions) belong to your account
  and live in the database, not in a file. They follow you to every device you sign in on.

Every setting, with its label and Settings page, is listed in the [Settings reference](/reference/settings/).

### Reading and editing `settings.json`

- Settings writes exactly the key you changed and keeps keys it does not know.
- You can edit the file by hand. Atelier picks the change up as soon as the file is saved.
- A top-level key that does not validate is left out (the rest of the file still applies), and admins see a notice at the top
  of Settings: "The settings file has settings that don’t apply until it is fixed", followed by what is wrong. A file that is not valid JSON is ignored entirely, and Settings refuses to write until you
  fix it, so it never overwrites your edit.
- Strings may refer to secrets and environment variables instead of holding them: `${secret:my-key}` is a stored secret,
  `${NAME}` an environment variable of the backend's process, `${NAME:-fallback}` the same with a default. Settings cannot
  refer to a person's own secrets (their GitHub token, saved SSH passwords).

### The shape of `settings.json`

Every key is optional. This is the complete list with the default used when a key is absent:

| Key | Default | Notes |
|---|---|---|
| `providers` | `[]` | One object per provider: `id`, `type` (`ollama`, `llamacpp`, `anthropic`, `openai`, `openai-compatible`, `chatgpt`, `chatgpt-chat`, `copilot`), `name`, `baseUrl`, `apiKey` (usually `${secret:…}`), `headers`, `enabled` (`true`), and optional `parallelRequests` (1 to 64), `vramGiB`, `modelsAtOnce` (1 to 16) and, for ChatGPT Chat, `temporaryChat`. |
| `models.defaults` | `{}` | `chat`, `work`, `code`, `small`: model references like `ollama/qwen3`. **Default model for everyone** is stored as `chat`; Cowork and Code follow it until a default of their own is set. |
| `models.aliases` | `{}` | What `opus`, `sonnet`, `haiku` and `fable` stand for. |
| `models.overrides` | `{}` | Per model: `hidden`, `displayName`, `favorite`, `order`, `contextLength`, `maxOutputTokens`, `temperature` (0 to 2), `toolCalling` (`native`, `prompted`, `none`), `vision`, `promptTier`, `manual`. |
| `capabilities.webSearch` | `enabled: true`, `provider: "auto"` | `provider` is `auto`, `searxng`, `brave` or `tavily`; `url` for SearXNG, `apiKey` for Brave and Tavily. |
| `capabilities.webFetch` | `true` | Lets models read pages by URL. |
| `capabilities.webFetchPrivateNetworks` | `false` | File-only: lets WebFetch reach LAN and VPN addresses. Loopback and link-local addresses stay blocked. See [Security](/security/#web-fetch-and-private-networks). |
| `pricing` | `{}` | Dollars per million tokens per model (`input`, `output`, optional cache and long-context prices). |
| `context.autoCompactAt` | `0.85` | How full the context window gets before Atelier summarizes (0.5 to 0.98). |
| `ultracode.enabled` | `true` | Whether the Ultracode effort stop exists. |
| `checkpoints.retentionDays` | `30` | How long Rewind keeps file versions (1 to 3650). |
| `server.signup` | `"invite"` | `invite` or `open`. See [Accounts](/accounts/). |
| `permissions` | `defaultMode: "auto"`, empty lists | `defaultMode` is `auto`, `default`, `acceptEdits`, `plan` or `bypassPermissions`; `allow`, `ask`, `deny` take rules in Claude Code syntax; `additionalDirectories` are folders sessions may use besides their own. See [Permissions](/permissions/). |
| `hooks` | `{}` | System hooks in Claude Code's format (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`). They run only for folders on the machine the backend itself runs on. |
| `cloud.github.clientId` | unset | Client id of a GitHub OAuth app with device flow, for Codespaces sign-in. |
| `enabledPlugins`, `extraKnownMarketplaces` | `{}` | Plugin switches and the marketplaces plugins came from, in Claude Code's shape. |
| `compat.claudeCode` | `true` | Whether Claude Code's files are read too. See [Claude Code compatibility](/claude-code-compatibility/). |
| `mcpServers` | `{}` | Connectors, in Claude Code's `mcpServers` shape (`type`, `command`, `args`, `env`, `url`, `headers`, `enabled`, `disabledTools`, `auth`, and Atelier's own `preset`). |
| `prompts.organizationInstructions` | `""` | **Instructions for every conversation** (up to 20,000 characters). |
| `safeguards` | `enabled: false`, `categories` (`sexual: true`, `hate: true`, `harassment: false`, `selfHarm: false`), `profile: "adult"`, `crisisResources: ""` | The optional content safeguards. |
| `memory.manualEditing` | `false` | **Let people edit memory by hand.** |
| `developer.inspector` | `false` | **Record provider requests.** |

:::note
Only the global `settings.json` is read as system settings. A project's `.atelier/settings.json` contributes permission
rules and hooks only, as described next.
:::

## Files inside your projects

Atelier writes into a project only when you ask it to, with two exceptions it tells you about. What it reads:

| Path in the project | Used for |
|---|---|
| `ATELIER.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` | Instructions, from the folder you open and every folder above it. `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/**.md` (in the folder you open) are read only with Claude Code compatibility on. `@path` imports are followed four levels deep, and a file is cut at 60,000 characters. |
| `.atelier/settings.json`, `.atelier/settings.local.json` | **Permission rules** (`permissions.allow`, `ask`, `deny`) and **hooks**, for sessions in this folder. Nothing else in these files is used. |
| `.claude/settings.json`, `.claude/settings.local.json` | The same two things, with compatibility on. |
| `.atelier/skills/`, `.agents/skills/`, `.claude/skills/` | Project skills. |
| `.atelier/commands/`, `.claude/commands/` | Project slash commands. |
| `.atelier/agents/`, `.claude/agents/` | Project sub-agents. |

The two exceptions: choosing **Always allow in this project** on a permission prompt adds the rule to
`.atelier/settings.local.json` (your own layer for this checkout) and lists that file in the repository's
`.git/info/exclude`, never in the project's `.gitignore`; and a Code session without a folder works in a scratch folder
in the data folder.

Hooks in these files run commands as you on the machine that holds the folder. Opening a folder is the trust decision
(**Trust this workspace?**), so open only folders you trust.

## Moving the data folder

Settings shows the data folder but has no control to move it. To move it:

1. Quit Atelier.
2. Move the folder (`~/.atelier/data` on the desktop) to its new place.
3. Tell Atelier where it is, either of these:
   - Create a symbolic link at the old path that points to the new folder. This works for apps started from the Dock or
     Start menu, which do not see your shell's environment.
   - Set `ATELIER_DATA_DIR` to the new path for the process that starts Atelier (a shell, a launcher, or `launchctl
     setenv` / a user environment variable on Windows), then start Atelier. `ATELIER_CONFIG_DIR` moves the config folder
     the same way, and the data folder follows it unless `ATELIER_DATA_DIR` is also set.
4. Start Atelier and check that **Settings › System › Data folder** shows the new place.

On a server, change the volume, not the variable: mount a different volume or a host folder at `/data`.

The folder must be on a local disk. SQLite does not work reliably over network file systems.

## Exporting your data

**Settings › Privacy › Your data › Export** builds a zip of everything that is yours and saves it where you choose:

| In the zip | What |
|---|---|
| `conversations.json` | Every conversation with its full message tree (all branches, tool calls, usage), with title, mode, project, model and timestamps. |
| `conversations/<title>-<id>.md` | The active branch of each conversation as readable Markdown. |
| `artifacts/<title>-<id>-v<n>.<ext>` | Every version of every artifact (`html`, `jsx`, `svg`, `mmd`, `md` or `txt`). |
| `projects.json` | Projects with their descriptions and instructions. |
| `memory.json` | Your memory entries. |
| `files/<id>-<name>` | Files you uploaded or that were generated for you. |

Temporary chats are never in an export. An export covers your account only and is a copy for you to keep or move, not a
backup of the server: it does not hold settings, accounts, provider keys or other people's data.

## Backing up and restoring

### The desktop app

1. Quit Atelier, so the database is not being written.
2. Copy the whole `~/.atelier` folder (settings, skills, data). Copy the profile folder too if you want to stay signed in
   to a server without signing in again.
3. To restore, quit Atelier, put the folders back, and start it.

Stored provider keys do not survive a restore onto a different computer or OS account (see
[above](#what-is-encrypted-and-what-is-not)).

### A server

Stop the server first so the database and its write-ahead files are consistent, copy the volume, start it again:

```bash
docker compose stop atelier
docker volume ls                       # find the volume, e.g. atelier_atelier-data
docker run --rm -v atelier_atelier-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/atelier-data.tgz -C /data .
docker compose start atelier
```

To restore, create an empty volume, unpack the archive into it, and start the server against it. Two details matter:

- **The key.** Without `ATELIER_SECRET_KEY`, the key is `secret.key` inside the volume, so the archive contains both the
  encrypted secrets and the key to read them. Treat the archive as sensitive, or set `ATELIER_SECRET_KEY` yourself (see
  [Run a server](/self-hosting/#the-secrets-key)) and keep that value in your password manager rather than in the backup.
  Restoring with a different key leaves stored secrets unreadable; you re-enter them.
- **The other volumes.** `caddy-data` holds your TLS certificates (losing it only means they are issued again).
  `sandbox-home` holds the chats' working folders, owned by the accounts' Unix users that `sandbox/slots.json` (in the data volume)
  assigns; keep the two together. `sandbox-keys` and `updater-secret` are recreated by the server.

## Deleting data

| To delete | Do |
|---|---|
| All your conversations | **Settings › Privacy › Your data › Delete all…**, then type `DELETE`. Every chat, Code session and Cowork task goes with its messages, files and artifacts. Projects, memory, settings and your account stay. Folders on disk are untouched. |
| Old conversations automatically | **Settings › Privacy › History › Keep conversations**: 30, 90 or 365 days. Every 24 hours while the backend runs (the first time 24 hours after it started), conversations you have not touched for longer (pinned ones excepted) are deleted, then attachments nothing refers to any more. |
| One conversation | Its title menu › **Delete**. |
| Temporary chats | They delete themselves when you leave them. A sweep removes any left behind after a day. |
| A person | **Settings › Admin › Users › Delete…** removes their account with their chats, projects, files, memory, devices and passkeys. Usage records stay, no longer tied to a name. |
| Rewind history | Older than **Keep checkpoints for** (**Settings › Admin › Code**, 30 days by default) is pruned in the same 24-hour run. |
| Everything on a computer | Quit Atelier and delete `~/.atelier`, the profile folder, and any scratch folders you made. Also delete the macOS Keychain item or equivalent if you want the encryption key gone. |
| Everything on a server | `docker compose down -v` removes the containers and **all** volumes, including the data. There is no undo. |

Scratch and sandbox folders are never deleted when their session is, because they may hold work you want; delete them by
hand if you do not.

## What the runner leaves behind

The runner is the small program Atelier starts to read, write and run things in a folder. Besides the folder itself it
creates:

- `~/.atelier/skills-cache/` (mode 0700) in the home folder of the machine it runs on.
- On an SSH host or in a codespace: the runner itself at `~/.atelier/runner/<version>/atelier-runner`, uploaded the first
  time and checked against a checksum, plus `~/.atelier/scratch-workspaces/` for sessions without a folder.
- A temporary folder named `atelier-runner-…` in the system's temp folder for as long as it runs.

Its file tools can reach the folder you opened, any additional directories you allowed, and `skills-cache`. They cannot
reach the rest of `~/.atelier`, which on the desktop holds the database. Commands a session runs are different: they run
as you and can read what you can, which is what [permissions](/permissions/) guard.
