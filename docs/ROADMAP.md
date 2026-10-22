# Atelier — Roadmap

Milestones, definition of done and verification. Architecture lives in `ARCHITECTURE.md`.

## 16. Design tokens (M0)

Design values live in `design/tokens/tokens.json` (with a JSON Schema) and component specs in `design/components.md`; `pnpm build:theme` generates `packages/ui/theme/*` from them. Values only: no third-party CSS, fonts, logos or asset files are copied.

## 17. Milestones

The **Definition of Done** for every milestone:
- desktop packages build for macOS (local), plus Windows and Linux (CI matrix)
- the web build passes; from M5 the Docker image also builds, **in CI** (Docker isn't installed locally)
- `pnpm typecheck && pnpm lint && pnpm test && go test ./...` all pass
- `CHANGELOG.md` has an entry
- a git tag `vM.0.0-mN`

A nav entry appears only when its page works.

### M0 — Design tokens
**Tasks:**
- repo scaffold
- `tokens.json` and its schema
- theme generator
- `components.md`

**Acceptance:**
- `tokens.json` validates.
- `pnpm build:theme` regenerates the theme deterministically.

### M1 — Foundation
**Tasks:**
1. **Monorepo:**
   - pnpm workspaces, strict TS, ESLint/Prettier, Vitest, Playwright
   - CI (lint, typecheck, test on ubuntu per push; package matrix on tags)
   - `APP` constant
2. **protocol:**
   - parts and messages
   - RPC contract
   - settings zod schema and JSON Schema emit
3. **core base:**
   - `WorkspaceFs` (Node impl)
   - settings layers, writer and watcher
   - SecretStore (desktop safeStorage bridge; server AES)
   - Drizzle store and migrations, blobs
   - `createBackend`, RPC server with `$/cancel`
   - RunManager with the subscribe/snapshot/seq reconnect contract and interrupted-on-restart handling
   - the **agent loop** (tool execution, without the permission engine, which arrives in M2)
   - the **prompt builder** with the chat (full + compact), compaction and title templates
4. **Desktop:**
   - Electron main, preload, utilityProcess
   - `app://` and `atelier-blob://` protocols
   - window chrome, menus
   - Cmd/Ctrl+N, K, `,`, B shortcuts
   - electron-builder config (dmg, nsis, AppImage, deb)
5. **Server skeleton:** Hono + WS serving the UI. It **binds to loopback only until M5** adds auth, and exists so the web build and QA work.
6. **UI shell:**
   - generated theme
   - AppShell, collapsible Sidebar, ModeSwitcher (Code and Work entries hidden until they work)
   - Recents grouped by date with rename/pin/delete
   - CommandPalette
   - light, dark and system themes
7. **Settings shell:**
   - overlay with deep links (`/settings/:page`) and Esc to close
   - nav with search index (labels and descriptions jump to the row and highlight it)
   - SettingRow primitives
   - Project badge and reset
   - pages: General, Personalization, Account (local profile), Providers (wizard, test, discovery, auto-detect `localhost:11434` / `:8080` / `:1234`, and env `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` offered as one-click suggestions), Models (table, overrides, defaults per mode, small-model slot, aliases, Probe tools)
8. **Providers:**
   - Ollama, OpenAI-compatible (incl. llama.cpp basics), Anthropic, OpenAI (Responses)
   - prompted-tools wrapper
   - capability detection
   - usage events
9. **Chat:**
   - Transcript and streaming markdown (Shiki, KaTeX, Mermaid)
   - thinking blocks
   - attachments (drag and drop, paste, PDF/text/images; capability-aware)
   - ModelPicker with badges, EffortToggle
   - Stop, retry/edit/branch
   - title generation
   - ContextMeter, `/compact`, auto-compaction
   - error states with fix links
10. **Artifacts:**
    - Artifact tool
    - panel with preview/code toggle, versions and download
    - sandboxed runtime (HTML, React, SVG, Mermaid, Markdown)
11. **Projects:** CRUD, instructions, files injected within a budget (with a warning past it), project chats.
12. **Onboarding:** detect, then add provider, then first chat in under a minute.

**Acceptance:**
- A fresh install on macOS goes from auto-detected Ollama to a streamed reply in under 60s.
- Anthropic, OpenAI and an OpenAI-compatible endpoint stream text, thinking and images, verified by live smoke tests behind env keys and by recorded fixtures in CI.
- Ollama requests always carry `num_ctx`.
- An artifact renders in the sandbox and cannot read `parent`, cookies, storage or the network. A test verifies this on the desktop and web builds.
- Closing and reopening the window mid-stream resumes the live stream with no lost or duplicated text.
- Settings search jumps to and highlights rows.
- Visual QA passes for the M1 screens.

The brief's M2 is about twice the size of M1, so it ships as two tagged halves.

### M1.5 — Accounts and devices (added 2026-10-13, see ARCHITECTURE §21)
**Tasks:**
1. **Core:**
   - `users`, `auth_sessions`, `invites`, `user_prefs`, `devices` tables; `user_id` on sessions, projects, files and usage, with existing single-user data migrated to the first admin.
   - Password hashing (scrypt).
   - RPC connection identity, `user`/`admin` procedure guards and per-user data scoping.
   - System settings vs user preferences, with effective-value resolution.
2. **Server:**
   - Setup (first admin with the log-printed token), login and logout, invite acceptance, change password.
   - Cookie sessions and authenticated WebSocket.
   - Origin check, login rate limiting, `Secure` cookies.
   - Opt-in non-loopback binding (`ATELIER_HOST`) once auth is on.
3. **Desktop:**
   - First-run choice between "Connect to a server" (URL + login, token in `safeStorage`) and "Run on this computer" (built-in backend, create the owner account).
   - Server mode relays the authenticated WebSocket from the utility process.
   - Device registration.
4. **UI:**
   - Login, setup and invite pages.
   - Settings › Account: profile, instructions, password, sessions, devices, log out of all devices.
   - Settings › Admin, for admins only: Providers, Models, Users (create, invite, approve, role, reset password, disable, delete), Server (sign-up policy, default role).
   - Personal preferences move off the system settings.

**Acceptance:**
- Two users on one server see only their own chats and projects.
- A regular user cannot read or change providers, models or users: the UI hides them and the RPC refuses them.
- An invite link creates a working account. With open sign-up, new users stay pending until approved.
- The desktop app works against a remote server and in "This computer" mode, with the same login and the same Admin pages.
- Existing data survives the migration under the first admin.

### M2a — Code core: runner, tools, permissions, Code view
**Tasks:**
1. **Go runner:** all §5 methods, Windows ConPTY and Git Bash detection, native grep/glob, cross-compiled ×6 with a checksum manifest.
2. **Workspaces:**
   - WorkspaceManager, Local driver (runner spawned on this computer, or relayed through the user's desktop device in server mode), trusted folders (Settings › Local)
   - the runner `WorkspaceFs` impl, which brings project and local settings layers online
3. **Tools:** Read, Write, Edit, Glob, Grep, Bash/BashOutput/KillShell, TodoWrite, AskUser, Agent (one built-in `general-purpose` agent), WebFetch, WebSearch (SearXNG, Brave, Tavily), ExitPlanMode.
4. **Permissions:** engine, modes, inline prompts, always-allow scopes, dangerous-command detector, and the Claude Code settings compat layer (Q3).
5. **Instructions:** CLAUDE.md/AGENTS.md loading via `fs.readAncestors`.
6. **Code view:**
   - WorkspaceHeader
   - side pane with Files, Diff (view), Terminal (pty) and Tasks (todos)
   - PlanModeToggle, PermissionPrompt
   - `@`-file mentions, slash menu (built-ins: `/compact`, `/clear`, `/model`)
   - context meter
7. **Prompts:** code and subagent templates (full + compact) and the env block.
8. **Settings:**
   - Code: permission mode, rules, global AGENTS.md editor, and the appearance rows (interface font, code font, syntax themes with diff preview, default transcript view)
   - Capabilities

**Acceptance:**
- In a Local workspace, an Anthropic model and a local Ollama model (compact tier) each complete a scripted edit-and-test task end to end.
- Deny rules block the call. Ask prompts survive a window reload.
- The terminal works on macOS, Windows (CI) and Linux.
- The runner conformance suite passes on all 3 OSes in CI.
- Visual QA passes for the Code screens.

### M2b — Code core: hooks, checkpoints, git, evals
**Tasks:**
1. **Hooks:** the five events, with host/workspace execution as in §8.
2. **Checkpoints:** storage, Rewind (including subagent edits), and per-hunk Reject in the Diff pane.
3. **Git:** status, branch, stage, commit, push, PR.
4. **Evals:** harness plus `edit-file`, `fix-failing-test`, `ask-clarifying-question`, `create-artifact` and `respect-permissions`.
5. **Settings:**
   - Code: hooks editor, checkpoint retention, git identity
   - System prompts: editor, diff, preview, Run evals
6. Slash command `/rewind`.

**Acceptance:**
- All five M2b evals pass with an Anthropic model, and with your best local model at the compact tier (threshold agreed at the time).
- Rewind restores files byte-identically.
- A PreToolUse hook can block and rewrite input.
- A commit and push from the GitBar lands on a test branch.

### M3 — Extensibility
**Tasks:**
- skills (discovery, hot reload, Skill tool, `/name`, install from GitHub or zip, remote sync)
- plugins and marketplaces (install, enable, per-item toggles, read Claude Code installs)
- slash commands
- subagent definitions
- hooks from plugins
- MCP client (§9-B):
  - SDK v2 with auto version negotiation; stdio, Streamable HTTP and legacy SSE fallback
  - key, bearer and header auth first, OAuth second
  - elicitation cards
  - per-tool toggles, per-project overrides, per-session toggles
  - Claude Code import from `~/.claude.json` and `.mcp.json`
- preset catalog (§9-B): Cloudflare, GitHub, Notion, Linear, Brave Search, Home Assistant, Custom
- Settings: Skills, Connectors, Plugins, Commands and agents, Keys and secrets, Developer (inspector, MCP logs, reload)

**Acceptance:**
- `npx skills add <repo> -g` makes a skill appear within 2s with no restart.
- An existing Claude Code plugin's skills, commands and agents work.
- The `use-skill` and `call-mcp-tool` evals pass.
- A Cloudflare connector works with a pasted API token.
- Each secret shows where it's used and when it was last used, and can be rotated.

### M4 — Work and SSH
**Tasks:**
- Work mode: folder picker (trusted folders, default folder), TaskProgressList beside the transcript, file outputs as cards with preview, long runs that survive window close, OS notification on finish, work prompt templates, document/spreadsheet skills supported via skill scripts
- SSH driver: bootstrap, upload, checksum, reconnect, health
- Settings: SSH (import from `~/.ssh/config`, test, runner version and update), Usage (tokens by provider/model/day, cost from the price table, tokens/sec), Privacy (retention, export all as zip, delete all)

**Acceptance:**
- A Work task in a local folder produces a .docx or .xlsx via a skill and shows a preview card.
- An SSH workspace on a Linux machine runs Code mode end to end, including the terminal.
- Killing the SSH connection reconnects automatically.
- Usage numbers match provider-reported usage.

### M5 — Web and Cloud
**Tasks:**
- server auth hardening on top of M1.5: passkeys (WebAuthn), CSRF double-submit token on mutating HTTP routes
- trusted proxy and base URL
- Docker image, built in CI:
  - multi-arch, non-root, `/data` volume, healthcheck
  - bundled `gh` + `openssh-client` + linux runners
  - `HOME=/data/home` so `gh`'s SSH keys survive restarts
- Caddy example config
- web surface rules: hide This computer, Local and SSH; **Work and Code on web run on Codespaces**, as the brief specifies; web skill and plugin install by URL or zip
- GitHub connection (device flow + fine-grained PAT)
- Codespaces: list, create (repo, branch, machine), start, stop, delete, idle-timeout display, runner bootstrap
- Settings: Cloud

**Acceptance:**
- `docker run` behind Caddy over Tailscale lets you log in with password and with a passkey.
- From the browser, you create a codespace for a repo and run a Code session with a terminal and a commit/push.
- Restarting the container keeps all state.

### M6 — Polish and ship
**Tasks:**
- prompt tuning via evals against your local models (Qwen/GLM-class on a 32 GB GPU) and frontier models
- llama.cpp polish: jinja detection, reasoning format, `/props` context, slot timings
- full visual QA pass at 1440 and 390
- packaging and updates via electron-updater:
  - generic feed mirrored by the Atelier server from the repository's releases
  - Win/Linux silent update
  - macOS shows "update available, download" (unsigned, per Q4)
- Settings › System: launch at login, update channel, data folder move, shortcut editor
- accessibility pass
- docs: user guide, self-hosting, connectors

**Acceptance:**
- All evals pass at an agreed threshold per model class.
- Installers work on all 3 OSes.
- Auto-update works where signing allows.
- Visual QA passes for every screen.

**Later:** Docker-sandbox workspaces (server spawns one container per session over the runner's WS mode), desktop↔server sync.

## 18. Working process

Changes land in small commits with conventional messages and a changelog entry, and each milestone is tagged. Tests, lint and type checks run in CI on every push (see `.github/workflows/ci.yml`).

## 19. Verification

- **Unit and contract tests** (Vitest):
  - each provider adapter against recorded SSE/NDJSON fixtures (text, thinking, tool calls, usage, errors)
  - prompted-tool parser and repair
  - permission matcher (a table of Claude Code examples)
  - settings layering and writer
  - hook I/O
  - skill, plugin and marketplace parsing against real-world samples (anthropics/skills, `~/.claude/plugins` shapes)
  - MCP against a local mock server for stdio and HTTP
- **Runner:** `go test` plus the TS conformance suite against the built binary on the macOS, Windows and Linux CI runners.
- **E2E:** Playwright drives the web build and the Electron app (`_electron.launch`) with a scripted mock provider (a test-only adapter) for deterministic streams. Flows: onboarding, chat with artifact, Code edit plus diff reject plus rewind, permission prompt, settings search.
- **Live smoke tests** (opt-in env): real Anthropic, OpenAI, your Ollama and llama.cpp, a real SSH host, a real codespace.
- **Evals:** `pnpm eval` per milestone from M2 on, with reports committed.

