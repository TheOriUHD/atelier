# Atelier — Architecture

> App name, bundle id, data-dir name, URL schemes and the server's cookie name all come from one constant, `packages/protocol/src/app.ts` (`APP = { name, id, dirName, scheme, cookie, … }`), so a rename is a single edit.

## 0. Context

The goal is a self-hosted, cross-platform AI workspace (Chat, Cowork, Code) running on any model backend: Ollama, llama.cpp, Anthropic, OpenAI, OpenAI-compatible endpoints (OpenRouter and others), GitHub Copilot and a ChatGPT plan. One pnpm monorepo ships two surfaces:
- an Electron desktop app
- a Docker-hosted web app (a few people, behind a reverse proxy such as Caddy, on a LAN or tailnet)

Cowork is the user-facing name of the mode whose id in code, the database and the RPC contract is `work`; this document uses both. The source is available under the PolyForm Noncommercial License 1.0.0 (`LICENSE`).

On disk the app is compatible with Claude Code's files: skills, plugins, commands, agents, hooks, CLAUDE.md and MCP config are read where Claude Code keeps them. The look is defined by design tokens and component specs (`design/`).

Design and compatibility notes:
- **Design values.** `design/tokens/tokens.json` holds both themes and everything the UI is drawn from; `design/scripts/build-theme.ts` generates `packages/ui/theme/*` from it (§15). A few of its values:
  - UI sans uses variable weights: 360 regular, 460 medium, 540 semibold.
  - Sizes: prose 15/22 (16/24 at the large text size), body 14/20, caption 12/17, code 13/19, title 22/28.
  - Radii: 4.5 `xs`, 6 `sm`, 7 `md`, 8 `lg`, 10 `xl`, 12 `2xl`, 14 composer.
  - Control heights: 32 base, 40 lg, 28 sm, 24 xs.
  - Durations: fast 60ms, snap 120ms, base 200ms, sheet 300ms, slow 450ms.
  - Easings: out `cubic-bezier(.165,.84,.44,1)`, snap `cubic-bezier(.32,.72,0,1)`, overshoot `cubic-bezier(.34,1.3,.64,1)`.
  - Icons are 20×20 outline glyphs. The accent is clay `#C6613F` (`#D97757` on hover).
- **Skills layout.** `npx skills -g` installs into `~/.agents/skills/<name>` and symlinks `~/.claude/skills/<name>` to it; its lock file is `~/.agents/.skill-lock.json`, which Atelier never writes. Claude Code's user-level plugin installs are listed in `~/.claude/plugins/installed_plugins.json` (version 2), each entry naming its `installPath`.

## 1. Deviations from the original plan

| Original plan | Now | Why |
|---|---|---|
| Electron is justified partly by node-pty | **No node-pty.** The Go runner owns every PTY, including the integrated terminal for Local workspaces. | Local, SSH and Cloud then behave identically, with one PTY implementation and no native module to rebuild per Electron/OS/arch. |
| Core runs in the Electron main process | Core runs in an Electron **`utilityProcess`** (`apps/desktop/src/backend.ts`) that calls the same `createBackend` as the web server. Main only does windowing, OS integration and `safeStorage`. | Agent loops, diffing and token estimation never stall window or menu handling, a backend crash doesn't take the window with it, and desktop and server run the same backend code. |
| Bash = persistent PTY shell | Bash tool = **persistent session semantics** (cwd persists, env from a login-shell snapshot), with a **fresh process group per command**. Real PTYs are only for the user's terminal. | A sentinel-parsed interactive PTY is fragile (prompts, echo, partial UTF-8). Per-command process groups give reliable timeouts and kills and clean exit codes. |
| Grep via ripgrep | Grep and Glob are **implemented natively in the Go runner** with ripgrep-compatible flags: a parallel, gitignore-aware walker (`runner/internal/walk`), RE2 regex. | Keeps the runner a single static binary to drop onto SSH hosts and Codespaces. Needs no rg install. |
| Separate secrets per surface | One `SecretStore` (rows in the `secrets` table) over a `Cipher` the surface supplies: the desktop's wraps `safeStorage`, the server's is AES-256-GCM with a key file or `ATELIER_SECRET_KEY`. Settings JSON only holds references, `"${secret:<id>}"`. | Settings files stay portable and safe to commit or sync. |
| Package all three desktop targets locally with every change | The release workflow (`.github/workflows/release.yml`) packages macOS, Windows and Linux in a **GitHub Actions matrix** on version tags and on manual dispatch; CI (`ci.yml`) checks every push on Ubuntu. Signed and notarized Mac builds are made locally (§20). | Installer tools differ per OS, and the unit tests also run on Windows before it is packaged. |
| Chat "code execution" on web | A chat gets Bash and Read in a sandbox folder of its own (§6). On the desktop that is a folder on the computer (confined by `sandbox-exec` on macOS); on a server it is a second container reached over SSH. | Running model-written code inside the server container would put it next to the secret key. |
| Radix Primitives | **Base UI** (`@base-ui/react` v1). Same headless model and the same component set we need: Dialog, Menu, Popover, Tooltip, Switch, Select, Tabs. | Base UI is stable and has a long-term maintenance commitment. |
| SQLite via Drizzle (driver unspecified) | Drizzle on Node's built-in **`node:sqlite`** (`drizzle-orm/node-sqlite`, v1 RC pinned exactly). This works in Electron 44 (Node 24.21) and in the Node 24 server image. | **Zero native modules anywhere.** Native modules would have to be rebuilt per Electron version, OS and architecture; without them, cross-packaging is simple. |

Everything else in the original plan (pnpm, strict TS, React+Vite+Tailwind, Electron, Hono+WS+SQLite/Drizzle, a Go runner) was adopted as planned.

## 2. Architecture

```
            ┌──────────────── packages/ui (React SPA) ────────────────┐
            │  routes · stores · components · theme (generated)       │
            └───────────────▲─────────────────────────▲───────────────┘
           MessagePort (IPC)│                         │WebSocket (+HTTP for blobs)
 apps/desktop ──────────────┤                         ├────────────── apps/server
  main: window, menus,      │                         │  Hono: auth (password+passkey),
  safeStorage, updater,     │                         │  sessions, static UI, blob downloads,
  folder picker, keep-awake │                         │  OAuth callbacks, update feed, trusted proxy
  utilityProcess ───► createBackend(platform) ◄─── same function
                           │  packages/core: RPC router, ChatService (runs), agent loop,
                           │  providers, tools, permissions, hooks, prompts,
                           │  extensions (skills/plugins/commands/agents), MCP,
                           │  memory, search, settings, store (Drizzle/SQLite), WorkspaceManager
                           └──────────────┬─────────────────────────────────────
              JSON-RPC 2.0 over stdio (local process / ssh / gh codespace ssh / device link)
                                          ▼
                              runner/ (Go, static binary)
                     fs · glob · grep · watch · shell · proc · pty · sys
```

- **`createBackend(platform)`** is the whole app backend. `platform` (`Platform` in `packages/core/src/backend/backend.ts`) injects the only surface-specific pieces:
  - `surface: 'desktop'|'web'`
  - `configDir` (`~/.atelier` on the desktop, `/data` on the server) and `dataDir`
  - `cipher`, the secret cipher (§1)
  - `env` and `logger`
  - `runnerDir`, where the 6 runner builds live; set only where the backend may run commands on its own machine (the desktop)
  - `setupToken` (server: required to create the first account)
  - `webFetch` (desktop: Chromium's network stack for search result pages) and `chatgptChat` (desktop: the ChatGPT Chat session, §9-A)
  - `serverUpdates` (the server's own version and updater)
  - Things only the desktop shell can do (folder picker, notifications, opening links, revealing files) are not backend functions: the renderer asks `main` through the preload bridge.
- **UI ↔ backend** is one typed contract in `packages/protocol/src/rpc/`, with zod schemas:
  - procedures: request/response
  - event streams (`session.event` for run events, `sessions.changed`, `settings.changed`, `providers.changed`, `models.changed`, `workspaces.changed`, `mcp.changed`, `extensions.changed`, `terminals.data`, and so on)
  - JSON-RPC 2.0 framing over a `Transport { send, onMessage, onClose? }`. Two implementations: MessagePort (desktop) and WebSocket (web). About 220 lines (`jsonrpc.ts`); no tRPC dependency.
  - Procedures are `public` (callable signed out), `user`, or `admin` (`ADMIN_PROCEDURES`; a non-admin gets `forbidden`), and a locked screen refuses all but the public ones (§21).
  - Downloads don't go through RPC:
    - desktop: a custom protocol `atelier-blob://<sha256>`
    - web: `GET /api/blobs/:sha`, for a signed-in cookie or bearer token
  - Uploads are the exception: `files.upload` carries the file base64 encoded (up to about 46 MB encoded).
- **Cancellation.** Both RPC layers (UI↔backend and backend↔runner) support an LSP-style `$/cancel {id}` notification. Every long handler takes an `AbortSignal`: grep, model listing, codespace creation polling, provider calls.
- **`ChatService`** (`agent/chat-service.ts`) owns long-running agent runs independently of any UI connection, so runs keep going if the window or tab closes.
  - **Reconnect contract:** `sessions.subscribe {id}` atomically returns a snapshot. The snapshot holds the persisted messages on the active branch (with their siblings), the in-flight partial message, any **pending interaction** (permission prompt, AskUser question, MCP elicitation, stored in `sessions.pending`), the todos, background tasks, context usage, queue position and the current `seq`. The live stream (`session.event`) attaches from that `seq`.
  - Run events carry a monotonic per-session `seq`, and parts are persisted before they are emitted.
  - When the backend starts, any session still `running` or `waiting` is marked `interrupted` (and its pending interaction dropped). The transcript then shows "Atelier restarted and cut off this reply." with a Continue button, which carries on from the last persisted state.
  - Parent runs track their child (subagent) runs, and Stop cascades to them.
  - Cowork notifies when a task finishes, fails or needs the person, through the renderer's Notification API (the desktop and the web alike; on the web only while a tab is open, and only if the browser allowed it).

## 3. Package layout

```
atelier/
  package.json · pnpm-workspace.yaml · tsconfig.base.json · eslint.config.js · .prettierrc.json
  vitest.config.ts · playwright.config.ts · CHANGELOG.md · .github/workflows/{ci,release,server-image}.yml
  packages/
    protocol/   # browser-safe: app constants, message/part types, RPC contract (rpc/), the settings and
                #   user-preference schemas (zod), runner protocol types (runner.ts), effort levels,
                #   provider and connector presets
    core/       # Node-only engine
      src/backend/      createBackend, RPC router
      src/agent/        chat-service (runs, titles, sub-agents), loop, loops (/loop), compaction, context,
                        context-notes, side-chat, background-tasks, interactions (waits for the person)
      src/providers/    adapters: ollama, llamacpp, anthropic, openai (Responses), openai-compatible, chatgpt,
                        chatgpt-chat, copilot; prompted-tools wrapper; registry and capability detection;
                        scheduler (one queue per model server); images, prices, OpenRouter sign-in; inspector fetch wrapper
      src/tools/        code/ (read, write, edit, glob, grep, bash, bash-output, kill-shell), web-fetch, web-search,
                        todo-write, agent, ask-user, skill, artifact, inline-visual, exit-plan-mode,
                        change-directory, send-message, task-stop, deferred connector tools
      src/search/       built-in web search: engines/, topic routing, limiter and breakers, cache, page excerpts
      src/memory/       memory entries, tools and past-chat search
      src/permissions/  rule parser/matcher (Claude Code syntax), modes, Bash splitter, dangerous-command detector,
                        auto-mode reviewer, sensitive paths
      src/hooks/        Claude Code hook runner (command handlers via runner)
      src/extensions/   skills, plugins+marketplaces, commands, agents, skill installs; watcher (sources.ts)
      src/mcp/          connection manager, OAuth, Claude Code import
      src/prompts/      builder (sections, tiers, env block), generated template table; templates in core/prompts/
      src/settings/     layered loader/writer (global → project → local), secret refs
      src/secrets/      SecretStore, Cipher interface, AES-GCM cipher (server); the desktop's cipher is in apps/desktop
      src/store/        Drizzle schema, migrations (generated from core/drizzle), blobs; FTS5 tables
      src/accounts/     accounts, passkeys, per-user preferences, devices, screen lock
      src/workspaces/   WorkspaceManager, runner client, ssh and ssh-access, chat sandboxes, terminals, device links, git, line-diff
      src/cloud/        GitHub device flow and PAT, Codespaces REST client
      src/{sessions,projects,files,artifacts,checkpoints,privacy,usage,developer,server-updates,instructions,fs}/
      prompts/          {chat,work,code}.{full,compact}.md, subagent, compaction, title, web-fetch, memory-update,
                        auto-mode, safeguards.*; fragments/, notes/, strings/
      evals/            tasks.ts, fixtures/, reports/, run.ts (`pnpm eval`), search.ts, ssh.ts
    ui/
      theme/            GENERATED from design/tokens/tokens.json: tokens.css (vars, light/dark), tailwind.css (@theme), colors.json
      src/app/          router (TanStack Router), shell, sidebar, command palette, shortcuts dialog
      src/components/   UI primitives (components/ui)
      src/features/     chat, projects, artifacts, code, work (Cowork), customize, settings, auth, ssh, workspaces
      src/lib/          rpc client, query hooks (TanStack Query), stores (Zustand)
      artifact-runtime/ sandboxed iframe runtime (separate Vite entry, own origin)
  apps/
    desktop/    # Electron main + preload + backend/remote entries (utilityProcess); electron-builder config;
                #   bundles runner builds (its own OS's, plus Linux and macOS ones to upload to SSH hosts)
    server/     # Hono + ws; auth; serves ui build; update feed; Dockerfile (bundles gh CLI + linux runner; `sandbox` and `updater` targets)
    site/       # the public website (static, Cloudflare Worker)
    docs/       # the documentation site (Astro Starlight)
  runner/       # Go module: cmd/atelier-runner, internal/{rpc,fsops,walk,grep,glob,watch,shell,proc,pty,sys}
  design/       # tokens/tokens.json, components.md, scripts/{build-theme.ts, build-icon.ts}
  deploy/       # compose.yaml, Caddyfile, cloudflare/ (the public update feed)
  e2e/          # Playwright specs for the web build and the Electron app
  docs/         # ARCHITECTURE.md, PROMPTS.md, ROADMAP.md, self-hosting.md, updates.md, user-guide.md
```

**Tech picks.** Pinned exactly in the packages' `package.json` files (the lock file is `pnpm-lock.yaml`).
- Runtimes: Electron 44 (Chromium 152, Node 24.21) and Node 24 LTS for the server.
- UI: React 19.3, Vite 8, Tailwind 4.3 (CSS-first `@theme`), TanStack Router and Query, Zustand, Base UI, cmdk, Sonner, Lucide, Shiki, Streamdown (streaming markdown with KaTeX and Mermaid), xterm.js, Recharts.
- Core and server: zod 4, Drizzle (v1 RC, `node-sqlite` driver), and MCP TS SDK **v2** (`@modelcontextprotocol/client`, with `versionNegotiation:{mode:'auto'}` so it speaks both the stateless 2026-07-28 protocol and the legacy `initialize` era). Also Hono with `@hono/node-ws`, `@simplewebauthn/server`, `node:crypto` scrypt (no native argon2), chokidar, `jsonrepair`, Ajv, `pdfjs-dist` (text extraction for PDF attachments and project files when the model lacks native PDF input), and `linkedom` with `@mozilla/readability` (search result pages and WebFetch).
- Build: electron-builder 26 and electron-updater.
- Runner: Go 1.27 with `charmbracelet/x/xpty` (creack/pty on Unix, ConPTY on Windows), go-git's `plumbing/format/gitignore` matcher under its own parallel walker (nested .gitignore/.ignore, `.git/info/exclude`, global excludes), fsnotify, and `bmatcuk/doublestar`.
- Tests: Vitest, Playwright (also `_electron` for the desktop app), `go test`.
- Lint: ESLint (typescript-eslint strict, react-hooks, jsx-a11y), Prettier, `go vet`.

## 4. Process model per surface

**Desktop.**
- `main` creates a window with a hidden title bar: inset traffic lights on macOS, the system's window buttons drawn over the top-right corner on Windows and Linux (`titleBarOverlay`).
- It forks `backend.mjs` with `utilityProcess.fork` and gives each renderer connection a MessagePort straight to it. The backend asks `main` (over the utility process's parent port) for what only `main` can do: `safeStorage` encrypt/decrypt, and the ChatGPT Chat browser session (§9-A). `main` in turn asks the backend for blob bytes (to answer `atelier-blob://`), tells it to remove the screen lock after Touch ID and, in server mode, passes on the current sign-in token.
- Everything else OS-level is an IPC call from the renderer through the preload bridge: the folder picker and "Trust this workspace", reveal in Finder and open in an editor, the updater, launch at login, keep-awake, `shell.openExternal`.
- In server mode (§21) it forks `remote.mjs` instead, which relays each renderer port to the server's `/api/ws` with the stored token. The choice (`connection.json`), the token (`session.bin`, safeStorage), the device id and the update settings live in Electron's userData dir.
- The renderer is fully sandboxed: `contextIsolation`, no node, strict CSP. It is served from `app://`.
- Artifacts render from a separate `atelier-artifact://` origin.
- The Code **Browser pane** shows pages in `<webview>`s inside the window (so menus and popovers still draw over them; a `WebContentsView` would sit above every DOM overlay). `main` hardens each one as it attaches (`apps/desktop/src/browser.ts`, §14) and turns their window opens into tabs. Every guest passes through `attachGuest`, the seam where model-controlled browsing (driving a page, annotating it) could attach later; nothing does yet.
- **Workspace files in the Browser pane** (Files › Open in Browser pane; `apps/desktop/src/workspace-pages.ts`): `main` answers `atelier-files://<grant>/<path>` in the pane's session only. The window asks for a workspace's origin (`browser:serve`; a random 128-bit grant per window and workspace, dropped when the window goes), and `<path>` is the file's path from the workspace root, so relative links resolve as on disk. Each request goes back to the window that holds the grant (`browser:read-file` → `browser:file`), which reads it with `workspaces.fileBytes` over its own connection: the runner's path scoping applies, and local, SSH, Codespaces and server folders all work. 16 MiB per file, 30 s per read.
- **Keep computer awake** (a Code session's More menu): the renderer tells `main` which of its sessions with the switch on are running or waiting on the person (`keep-awake:set`), and `main` holds one `powerSaveBlocker` (`prevent-app-suspension`) while any are (`apps/desktop/src/keep-awake.ts`). It lets go when the list empties (the switch goes off, the runs end, the session is deleted), when the window reloads, crashes or closes, and when the app quits. The switches are per device (local storage), not preferences.

**Web.**
- `apps/server` serves the UI build plus `/api/ws` (an authenticated WebSocket), `/api/devices/link` (the desktop device link, §21), `/api/blobs/:sha`, `/api/auth/*` and `/api/passkeys*` (sign-in over HTTP so the session token lives in an `HttpOnly` cookie), `/api/health` (unauthenticated: the version, so the desktop can recognise a server), `/oauth/callback` and `/oauth/client-metadata.json`, `/updates/*` (the desktop update feed, §20) and `/artifact-runtime/*`.
- `apps/site` is the public website: a static page deployed as a Cloudflare Worker with static assets on `atelierhq.dev` (no build step; see its README for deploying and the screenshot pipeline). It is not part of the app and has no package of its own.
- `apps/docs` is the documentation at `docs.atelierhq.dev`: Astro Starlight, built to static files (`pnpm --filter @atelier/docs build`, which also writes `dist/_headers` with a CSP that allows Starlight's inline scripts by hash) and deployed as its own Worker with static assets on the custom domain only (`run deploy`). Same tokens and fonts as the site. The app links to it through `APP.docs`.
- Configuration (environment; `apps/docs/src/content/docs/environment-variables.md` has the full list):
  - `ATELIER_BASE_URL`
  - `ATELIER_TRUSTED_PROXIES`, which honors `X-Forwarded-*` only from listed proxies
  - `ATELIER_DATA_DIR=/data`
  - `ATELIER_SECRET_KEY`, or else an auto-generated `0600` key file (`secret.key`) in `/data`
  - `ATELIER_SETUP_TOKEN` to choose the first-run token, else a random one is printed to the log
  - `ATELIER_HOST` and `ATELIER_PORT` (the image listens on `0.0.0.0:7340`; a bare run binds `127.0.0.1`)
  - `ATELIER_SANDBOX_HOST`, `ATELIER_SANDBOX_KEYS`, `ATELIER_SANDBOX_SLOTS` (the chat sandbox, §6), `ATELIER_UPDATES_REPO`/`ATELIER_UPDATES_TOKEN` (the update feed, §20) and `ATELIER_UPDATER_URL` (the compose file's updater)
- The server is one container with `/data` as its volume. The compose file in `deploy/` adds the chat sandbox container, an optional updater and Caddy.

**Data locations.**
- Config lives in `~/.atelier/` (`ATELIER_CONFIG_DIR` moves it):
  - `settings.json`
  - `AGENTS.md` and `ATELIER.md` (the system instructions; `AGENTS.md` is edited in Settings › Admin › Code)
  - `skills/`, `commands/`, `agents/`
  - `plugins/` (`cache/` and `installed.json`)
  - `prompts/` (template overrides)
  - `skills-lock.json`
- Data (`atelier.db`, `blobs/`, `scratch-workspaces/`, `chat-sandboxes/`, `screen-lock.json`) defaults to `~/.atelier/data/`; `ATELIER_DATA_DIR` moves it, and Settings › System shows where it is.
- Server: `/data/{settings.json, …, atelier.db, blobs/, secret.key}`, with the same shapes (config and data share one folder).

## 5. Runner protocol v1

- **Framing.** JSON-RPC 2.0, one JSON object per line over stdio (`atelier-runner --stdio [--root <path>]…`; it is the only mode). A runner on another computer is reached by running it through `ssh` or `gh codespace ssh`, or over the device link (§21), which carries the same lines in WebSocket frames.
- **Binary fields.** Base64 with an explicit `encoding: 'utf8'|'base64'`.
- **Handshake.** `initialize` must be the first call:
  - input: `{protocolVersion, client: {name, version}}`
  - output: `{protocolVersion, runnerVersion, os, arch, roots, home, shell, pathSep, capabilities: {methods, execShell}}`
  - A protocol version mismatch gives error `-32020` (the protocol is version 1). There is no negotiation: a Local runner is bundled with the app, and the SSH bootstrap (§6) uploads the build whose checksum the app carries into a folder named for the runner's version.
- **Auth.** There is none and no listening socket. The runner serves only its own stdin and stdout, so whoever holds the pipe is the authority: the backend for a Local runner, the `ssh` session for a remote one, the device link's channel for a lent one.
- **Roots and path scoping.**
  - The primary root is the workspace's **git toplevel**, or the chosen folder when it isn't a repo. The runner also always roots `~/.atelier/skills-cache` (made `0700` if missing), and nothing else of `~/.atelier`: the runner's own files there are uploaded and checked over the plain remote shell, and on the desktop `~/.atelier/data` holds every account's database, blobs and scratch folders, which no session's file tools may reach. Commands a session runs (Bash, hooks, the terminal) still run as the person and can read whatever they can; Ask mode asks before them.
  - `sys.addRoot {path}` adds a root at runtime. It is used for `permissions.additionalDirectories`, permission-approved access outside the workspace and, on the desktop, a global skill's folder.
  - Every path is made absolute, cleaned and symlink-resolved for its existing prefix, and must fall under a root. Otherwise it fails with `-32010 PathOutsideWorkspace`.
  - One read-only exception: `fs.readAncestors {from, names}` returns the instruction files (CLAUDE.md, AGENTS.md, ATELIER.md, CLAUDE.local.md, .claude/CLAUDE.md) found walking upward from the root. These fixed names are the only thing readable above a root.
- **Liveness.** The client sends `sys.ping` every 10s; any line from the runner counts as an answer. After 2 missed pings it closes the channel, so pending calls fail ("the runner stopped answering") instead of hanging, and the workspace's next use connects again. Underneath, `ssh` runs with `ServerAliveInterval=10` and `ServerAliveCountMax=2`, and the device link pings on its own (§21).
- **Cancellation.** `$/cancel {id}` aborts any in-flight request (see §2).

| Group | Methods (→ notifications) |
|---|---|
| sys | `initialize`, `sys.info` (os, arch, hostname, cpu, mem, disk, load, git version, default shell, Git Bash on Windows), `sys.ping`, `sys.addRoot`, `shutdown` |
| fs | `fs.stat`, `fs.read {path, offset?, limit?, encoding}` → `{content, encoding, sha256, size, totalLines, truncated, binary}`, `fs.write {path, content, encoding, expectSha256?, mkdirp}` → `{sha256, created}` (atomic temp+rename; `-32011 Conflict` on hash mismatch), `fs.list {path, depth, respectGitignore}`, `fs.mkdir`, `fs.remove`, `fs.rename`, `fs.readAncestors` |
| search | `fs.glob {pattern, cwd, limit}` (sorted by mtime desc), `fs.grep {pattern, path, glob?, type?, outputMode: content\|files\|count, caseInsensitive, lineNumbers, before, after, multiline, headLimit}` |
| watch | `fs.watch {path, recursive}` → `watchId`; `fs.unwatch`; → `fs.changed {watchId, events[]}` (debounced 100 ms) |
| shell (Bash tool) | `shell.open {cwd, env}` → `shellId` (captures a login-shell env snapshot once); `shell.exec {shellId, command, timeoutMs, background?}` → `shell.output {execId, chunk}` … result `{execId, exitCode, cwd, durationMs, output, truncated, timedOut}`; `shell.read {execId, sinceOffset}` (background output; after a runner restart unknown ids return `ShellRestarted`); `shell.kill {execId}` (kills the process group); `shell.close`. Semantics: each command runs as `bash -c` (Git Bash or PowerShell on Windows) in a new process group, sourcing the snapshot and `cd`-ing to the tracked cwd. Afterwards the runner records `pwd` to a temp file, never by parsing stdout. **cwd persists; `export`, aliases and `source` do not.** Both prompt tiers say so. |
| proc | `proc.exec {argv, cwd, env, stdin?, timeoutMs}` → `{exitCode, stdout, stderr, timedOut, truncated}`. No shell; used for git and hooks (`sh -c` explicitly). |
| pty (user terminal) | `pty.open {cwd, cols, rows, shell?}` → `ptyId`; `pty.write`, `pty.resize`, `pty.close` → `pty.data {ptyId, b64}`, `pty.exit {ptyId, code}` |

TS types live in `packages/protocol/src/runner.ts`, mirrored by hand in `runner/internal/rpc/types.go`. A **conformance test suite** in core (`runner.conformance.test.ts`) runs the methods against the real built binary; CI runs it on Ubuntu for every push, and the release workflow on Windows too.

## 6. Workspaces

- **Local (desktop).**
  - The runner binary for the host OS/arch is spawned with `--stdio --root <folder>`; more roots are added later with `sys.addRoot` (§5). A workspace's runner starts on first use, stays warm while sessions use it and shuts down after 15 quiet minutes.
  - A folder is added through the native folder picker, which asks "Trust this workspace?" first. The workspace is the folder's git top level, stored as a `workspaces` row; the desktop also records the root in `trusted-folders.json`, the list that limits what a server's sessions may reach on this computer (§21).
- **Chat sandboxes** (`workspaces/sandbox.ts`). A chat gets Bash and Read (`chatSandboxAvailable`) in a folder of its own, made on the first call (`chatSandbox`: `WorkspaceManager.addChatSandbox`, stored as the session's `workspaceId`, a `workspaces` row with `scratch = 1` and `sandbox = 1`, never deleted). Calls are decided by fixed rules, never a prompt (`permissions/engine.ts` `sandboxDecide`): Read only inside the folder; `dangerousReason` commands refused with the reason; other commands run where the folder is confined, else go to the auto mode reviewer. Where it lives:
  - **Server:** a second container (`target: sandbox` of `apps/server/Dockerfile`, its files in `apps/server/sandbox/`; Debian with git, Python, Node, build tools; sshd on 2222, key login only) beside the server, with its own home volume and size limits and none of the server's data. The server reaches it like an SSH host (`SANDBOX_HOST`; `ATELIER_SANDBOX_HOST`/`_PORT`), with a key it makes in `<dataDir>/sandbox/` and publishes to the shared `sandbox-keys` volume (`ATELIER_SANDBOX_KEYS`), so the server still never runs commands on its own machine. **Accounts are kept apart by Unix users, enforced by the OS.** The container starts as root (`atelier-sandbox`: it makes a pool of users `sbx000`… with uid 20000 + n, `ATELIER_SANDBOX_SLOTS`, 256 by default, each with a group of its own and no password) and runs sshd as root with `AllowUsers sbx*`, `PermitRootLogin no` and the keys supplied by `AuthorizedKeysCommand atelier-sandbox-keys`. `SandboxAccounts` (`workspaces/sandbox-accounts.ts`) gives each account the lowest free slot the first time it needs the sandbox and never changes it (`<dataDir>/sandbox/slots.json`, written atomically before it is used; a file it can't read is an error, never an empty list); `sandboxShell(env, dataDir)(userId)` logs in as that user, so the runner and every command run as it, and `remoteKey` gives each account's runner its own upload under its own home. Before any login the key script (root, run by sshd) makes `u/<user>` (0700, the user's home: runner, caches, `TMPDIR`) and `chats/<account>` (0700), where `<account>` is the id the server published in `<keys folder>/accounts/<user>` (mode 0700/0600, in the keys volume the container mounts read-only: the only way an id reaches the container), and records in `.slots/<user>` (root only) the first account a user was told for, refusing logins as that user if the server later says another account. Chat folders are `chats/<account>/chat-<date>-<hex>` (`sandboxChats`), the path the single-user layout used, so stored `workspaces.root` values stay valid. The image has no setuid, setgid or file-capability file (`strip-privileges.py` fails the build otherwise) and no sudo; `deploy/compose.yaml` adds `no-new-privileges`, `cap_drop: ALL` and only `CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, SYS_CHROOT`. Namespaces (bubblewrap, `unshare`) were rejected: the default seccomp profile refuses them, even for root. `Workspace.sandbox.confined` is true for these folders: the container holds nothing but sandboxes and an account's commands reach only that account's own. Left shared: the container's CPU, memory, pids, disk and network, and `/proc/<pid>/cmdline` (readable by every user; `hidepid` needs a privileged remount). **Migration from the shared `sandbox` user (uid 1000):** at start everything it left in the volume is locked to root (top level only, `chown root` + `chmod go-rwx`), and a legacy `chats/<account>` folder, root-owned and locked, is `chown -R` to the account's user the first time the key script runs for it (never a link, never a folder another user already owns). `ATELIER_SANDBOX_USER` set means a hand-built sandbox with one shared login (`sandboxChats` then keeps `<home>/chats/<account>`).
  - **Desktop's own backend:** `<dataDir>/chat-sandboxes/<user>/chat-…`. On macOS the runner is started through `sandbox-exec` with a profile (`macosProfile`): writes only to the folder, `/private/tmp`, `/private/var/folders` and `/dev`; no reading or writing of secrets (`~/.ssh`, cloud and package-manager credentials, keychains, browser profiles, mail) or Atelier's data (`~/.atelier`, its Application Support folder), except the folder itself, the skills cache and metadata on the way to them. Elsewhere (Linux, Windows) it isn't confined and the reviewer judges commands.
  - **Desktop connected to a server:** the server's sandbox (the chat is the server's).
  - **Continue in Cowork:** `sessions.continueInCowork` forks the chat into a `work` session (`SessionRepo.fork(id, 'work')`: same title and folder, a new system prompt); the UI offers it under a reply that used Bash or Read until the person writes again, never after `prefs.chat.coworkOffer` is turned off.
- **No folder (scratch folders, desktop "Run on this computer").** A Code or Cowork session can start without a folder (`sessions.create` with `scratch` instead of `workspaceId`). The backend then makes a new, empty folder for it and makes that the session's workspace through the ordinary path, so tools, terminal, files pane, Diff and checkpoints work as in any folder:
  - On this computer: `<dataDir>/scratch-workspaces/<userId>/scratch-<YYYY-MM-DD>-<6 hex>` (local date, mode `0700`), its realpath stored as the root.
  - On an SSH host: `~/.atelier/scratch-workspaces/<userId>/scratch-…`, made through a short-lived runner rooted at `~/.atelier` (bootstrapping created it), then used like any SSH folder; the session's own runner roots only the scratch folder and the skills cache.
  - It is a `workspaces` row with `scratch = 1`: trusted for exactly that folder (the runner's root is the folder itself, never a repository around it, so path scoping and permission rules work as for any root and nothing outside becomes reachable). Its runner runs with `GIT_CEILING_DIRECTORIES` set to the folder's parent, so neither Atelier's git calls (header, Diff pane, git bar, the repository note) nor the session's Bash and terminal find a repository around it, such as a home folder kept in git; `git init` inside makes it a repository like any other. It isn't added to the desktop's `trusted-folders.json`, Settings › Folders, the folder menu's Recent, the `+` menu's folders or the Skills page's folder list. Opening the same folder with Open folder… makes it an ordinary folder.
  - The `<env>` block tells the model the folder is a new, empty scratch folder for this session, not a project (`docs/PROMPTS.md` §1.4).
  - `/clear` goes on in the same scratch folder (`?workspace=<its id>`); New, the home and the "No folder" group's `+` make a new one. `?workspace=none` without `host` is always this computer, whatever environment was picked last; the group's `+` passes the host of its latest session.
  - Deleting a session never deletes its folder (nothing in Atelier hard-deletes user content). When the last session using a scratch folder is deleted (one by one, all at once in Privacy, or by retention), its `workspaces` row goes too, so rows don't pile up; the folder stays on disk. Cowork's "Show in Finder" also reveals files under `<dataDir>/scratch-workspaces`.
  - The home's folder chip offers **No folder** in the Local and SSH environments of the desktop's own backend, and of a desktop signed in to a server that lends them (§21, device services), and starts there when nothing is chosen yet (`design/components.md` › Folder menu). Not built: no folder started from the browser on a person's desktop (Remote Control) and in codespaces; the browser follows the environments it has (Cloud, Remote Control), so it never offers it.
- **SSH (desktop, and a server's sessions through the person's desktop: §21, device services).**
  - Uses the **system `ssh` binary** (OpenSSH on all three OSes), so `~/.ssh/config`, ProxyJump, ssh-agent and 1Password-style IdentityAgent all just work.
  - Bootstrap:
    1. `ssh host 'uname -s; uname -m; printf "%s\n" "$HOME"'`
    2. Compare the remote `sha256sum`/`shasum -a 256` of `~/.atelier/runner/<ver>/atelier-runner` with the build's entry in the embedded checksum manifest (`checksums.json`).
    3. If it is missing or differs, upload the matching build via stdin (`cat > <tmp> && chmod 755 && mv`), then check the checksum again.
    4. Connect with `ssh host '<path> --stdio --root <remote path>'`.
  - Remote hosts need Linux or macOS on x86-64 or ARM64.
  - Hosts can be picked from `~/.ssh/config` (the parser lists Host entries but skips wildcards) or added as the person's own connections (`prefs.ssh.connections`), see "SSH connections" in §8.
  - `ssh` runs with `BatchMode`, `ConnectTimeout=10` and the keepalive options of §5. A lost link fails pending calls and the workspace's next use connects again with a fresh runner (and so a fresh Bash shell); there is no automatic reconnect loop.
- **Terminals** (`workspaces/terminals.ts`) are PTYs on the workspace's runner. A terminal belongs to the person who opened it and sends its output to one connection at a time. When that connection goes away (a dropped socket, a reload, the desktop relay reconnecting) the shell keeps running for five minutes with its last 256k characters kept; `terminals.attach { terminalId, since }` from any of that person's connections takes it over and returns what came after the first `since` characters (the client counts what it showed), which the pane writes under a dim "[shell reconnected — replaying buffered output]". Unattached, it closes; a backend shutdown closes them all.
- **Codespaces (desktop + web).** Uses the same bootstrap and channel code (`workspaces/ssh.ts`), with `gh codespace ssh -c <name> --` as the command prefix. Details in §9-C.
- **Trust is a column, not only a dialog.** A `workspaces` row has `trusted`: a folder on a computer or an SSH host is trusted when it is added (the desktop asked "Trust this workspace?" first); a codespace only when `workspaces.addCodespace`/`codespaces.open` carry `trust: true` or `workspaces.trust` is called, after the web or desktop UI asked. `WorkspaceManager.open` copies the column onto the live `Workspace` (`trusted`, refreshed on every open), and what the folder brings itself is read only when `isTrusted(workspace)`: project hooks and permission rules (`project-rules.ts`), instruction files (`code-context.ts`, nested ones in `ChatService.nestedInstructions`) and skills, commands and agents (`extensionsFor`). Anything that doesn't say is untrusted. Migration `workspace_trust` marks the codespace rows that existed before as untrusted.
- **Workspace header** shows the folder's name, a Local/SSH/Cloud badge (and "Offline" when its machine can't run tools), the branch (from `git status --porcelain=v2 --branch` via `proc.exec`) and the number of changed files.

## 7. Provider abstraction (`packages/core/src/providers`)

Internal format (in `packages/protocol/src/messages.ts` and `models.ts`, shared with the UI; the provider-side types are in `providers/types.ts`). A simplified sketch of the parts that shape adapter code:
```ts
type Part =
  | { type:'text'; text:string }
  | { type:'image'; mime:string; blob:string }                 // blob = sha256 in blob store
  | { type:'document'; mime:string; blob:string; name:string } // PDF / text files
  | { type:'thinking'; text:string; replay?:unknown; provider?:string; redacted?:boolean }
  | { type:'tool_call'; id:string; name:string; input:unknown; childSessionId?:string } // subagent link
  | { type:'tool_result'; callId:string; content:(TextPart|ImagePart)[]; isError?:boolean }
  | { type:'context'; text:string; state?:Record<string,string>; notice?:Notice }; // hidden <context-update> on user turns, replayed verbatim (§13);
                                     // notice: how the transcript shows it: a loop's send, a background sub-agent's end, a command,
                                     // a compaction, a quoted passage or a message from another session (§8)
// A stored Message is { id, sessionId, parentId, role:'user'|'assistant'|'tool', parts, model, usage, stopReason, error, kind, summarizesThroughId, createdAt }.
// Model refs are "<providerId>/<modelId>", split on the FIRST "/" only.
// Provider ids match [a-z0-9-]+ (no "/"), so "openrouter/anthropic/claude-x" is unambiguous.

interface ChatRequest {
  model:string; system:{ text:string; cache?:boolean }[]; messages:Message[];
  tools?:ToolDef[]; toolChoice?:'auto'|'none'|{name:string};
  maxOutputTokens:number; temperature?:number;
  effort?: 'low'|'medium'|'high'|'xhigh'|'max'|'ultracode' | null;  // adapters map it to the provider's mechanism
  contextLength?:number;      // where the provider needs it explicitly (Ollama num_ctx)
  signal:AbortSignal;
  queue?:QueueOptions;        // priority and waiting callbacks for the model-server queue (below); adapters ignore it
}
type StreamEvent =
  | {type:'text'; delta:string} | {type:'text_snapshot'; text:string} | {type:'thinking'; delta:string}
  | {type:'thinking_replay'; data:unknown; redacted?:boolean}   // opaque data stored as ThinkingPart.replay
  | {type:'tool_call_start'; id:string; name:string} | {type:'tool_call_delta'; id:string; json:string}
  | {type:'tool_call_end'; id:string; input:unknown}
  | {type:'usage'; usage:{ input:number; output:number; cacheRead?:number; cacheWrite?:number; reasoning?:number; durationMs?:number; tokensPerSecond?:number }}
  | {type:'phase'; phase:'loading'|'reading'}                  // local servers only
  | {type:'finish'; reason:'end'|'tool_use'|'max_tokens'|'stop'|'refusal'|'error'|'aborted'; error?:MessageError};

interface ModelInfo {   // abridged
  ref:string; providerId:string; modelId:string; displayName:string; contextLength:number; maxOutput:number;
  capabilities:{ tools:'native'|'prompted'|'none'; vision:boolean; pdf:boolean;
                 reasoning:'none'|'toggle'|'effort'|'budget'; caching:boolean };
  tier:'full'|'compact'; source:'detected'|'catalog'|'default'|'override';
  effortLevels?:string[]; recommendedEffort?:{ chat:Effort; work:Effort; code:Effort }; free?:boolean;
  hidden:boolean; favorite:boolean; order:number; /* … */
}
interface ProviderAdapter {
  readonly type:ProviderType;
  listModels(signal?):Promise<ListedModel[]>;        // ModelInfo without hidden/favorite/order
  health(signal?):Promise<{ ok:boolean; latencyMs:number|null; version?:string; warnings:string[]; error?:string }>;
  stream(req:ChatRequest):AsyncIterable<StreamEvent>;
  countTokens?(req):Promise<number>;
  serverLimits?(signal?):Promise<{ parallel?:number; modelsAtOnce?:number }>;
}
```
- **No vendor SDKs.** Adapters use `fetch` (`node:http` for plain-HTTP model servers, below) plus a small SSE parser and an NDJSON parser (`providers/sse.ts`, `ndjson.ts`). The shared `fetch` wrapper feeds Settings › Admin › Developer › Request inspector with redacted headers.
- **Per-adapter mapping:** see §9-A. Adapters keep an opaque **replay payload** (`ThinkingPart.replay`) per assistant turn where the provider needs one and send it back verbatim on later turns: Anthropic thinking signatures and `redacted_thinking`, OpenAI `encrypted_content` reasoning items, OpenRouter `reasoning_details`. The payload is dropped when the conversation switches provider.
- **Images fit the provider** (`providers/images.ts`, `image-limits.ts`; `createAdapter` wraps every adapter). Each request's images are fitted to what that provider takes, reduced rather than refused: Anthropic 8000 px and 5 MB an image, 100 images and ~24 MB a request, and 2000 px each past 20 images; OpenAI 20 MB an image, 500 images and ~40 MB a request; an OpenAI-compatible endpoint, and GitHub Copilot, the stricter of those (OpenRouter and Copilot front Anthropic's models); a ChatGPT plan OpenAI's; ChatGPT Chat 10 files of 20 MB; Ollama and llama.cpp 4096 px and 25 MB. A PNG that is too big is reduced and stays a PNG while it fits, else it and a JPEG become a JPEG at the best quality that fits; the oldest images beyond the count or size are left out. The model is told in a note (reduced, or left out and why); the type is taken from the bytes, not the file name. Decoding is pure JavaScript (`pngjs`, `jpeg-js`: no native module), so a WebP or GIF that is too large can only be left out. Fitted bytes are cached by what they came from, so equal inputs give equal requests (prompt caches). A provider that still refuses an image (a failed request whose error names an image) gets the request again without the history's images, then without any; the images it refused are left out of later requests. The numbers are the providers' documented limits and live in one table (`IMAGE_POLICIES`).
- **Prompted tools.** `withPromptedTools(adapter)` applies when a model's `tools` capability is `prompted`:
  - Injects tool specs and the call format: Hermes-style `<tool_call>{"name":…,"arguments":{…}}</tool_call>`, which most local models are trained on.
  - Re-serializes history tool calls and results as text.
  - A streaming parser hides call text from the UI as it arrives.
  - Repairs JSON with `jsonrepair`, then validates with Ajv against the tool schema.
  - On failure the call comes back as an `isError` tool_result saying what was wrong and to emit exactly one well-formed call; the loop's repeat check (§8) ends a model that keeps making the same call. Only the first call in a message is used.
- **Capability resolution** in order: model override (settings) → detection (Ollama `capabilities`, llama.cpp `/props`, OpenRouter metadata) → built-in catalog (Anthropic/OpenAI ids) → defaults. **Probe tool calling** (a row action in Settings › Admin › Models, `models.probeTools`) runs a one-shot tool-call test and records native vs prompted as the model's override.
- **Presets** (`protocol/provider-presets.ts`): OpenRouter and OpenCode Zen are `openai-compatible` providers at the service's address, not types of their own; `presetOf(baseUrl)` (by host) lets the adapter add what the service needs. OpenRouter: the `HTTP-Referer: https://atelierhq.dev` and `X-OpenRouter-Title`/`X-Title: Atelier` attribution headers, `free` on models priced `"0"`/`"0"` or with a `:free` id, and `tools: 'none'` for models whose `supported_parameters` lack `tools`. OpenCode Zen: models are listed at `/inference/v1/models`, chat goes to `/inference/openai/v1`, with the Console key as `Bearer`; nothing in the requests claims to be OpenCode. **Connect with OpenRouter** (`providers/openrouter-auth.ts`, `openrouter.*` RPCs, admin-only) is OpenRouter's OAuth PKCE flow for apps: `openrouter.ai/auth?callback_url&code_challenge` (S256) `&state`, then `POST openrouter.ai/api/v1/auth/keys {code, code_verifier, code_challenge_method}` → `{key}`, and `ProviderRegistry.save` stores the key as `provider-<id>` in the secret store; the key never reaches the client. The callback is the connectors' (§9-B): the desktop's own backend listens on `127.0.0.1` on a free port (OpenRouter takes localhost on any port), a server uses its public origin's `/oauth/callback`, where `finishSignIn` hands a callback whose `state` is the pending connect's (or one with neither code nor state while it waits: OpenRouter sends no state when access is declined) to OpenRouter instead of the connectors; a browser start must come back with the same person's cookie. Codes expire after ten minutes, and so does the wait.
- **Tier.** `full` for the Anthropic, OpenAI, ChatGPT Plan, GitHub Copilot and ChatGPT Chat providers and for models whose id is in the built-in list of frontier families, `compact` otherwise. Overridable per model.
- **Small-model slot** (titles, summaries, compaction) and **per-mode defaults** live in `settings.models.defaults`. If the small slot is unset, those tasks use the session's own model, so onboarding never produces untitled chats.
- **Claude Code model aliases.** `opus`, `sonnet`, `haiku` and `fable` in an agent file's `model` field map through `settings.models.aliases` (skills read no `model`); an alias that is unset keeps the parent's model.
- **Sharing a model server** (`providers/scheduler.ts`). A local GPU answers a few requests at a time and holds one model or a few. Anything more only queues inside the server, out of sight, and a request for another model makes it unload the one it holds (tens of seconds per swap). So every model request, from every session, sub-agent and account, waits in one queue per server. Providers with the same base URL share it.
  - **Limits** per provider (`parallelRequests`, `modelsAtOnce`; "Requests at once" and "Models at once" in Settings › Admin › Providers › Edit): set by the person, else what the server reports (llama.cpp's `/props` `total_slots`), else 1 and 1 for a server on this computer or the local network (loopback, private and Tailscale addresses, bare names, `.local`/`.lan`/`.ts.net`…) and 16 and unlimited for a hosted API. Ollama doesn't expose `OLLAMA_NUM_PARALLEL`, so someone who raised it raises the setting too. The provider row says "One request at a time" for limited servers.
  - **Order.** The oldest request goes first, with a handicap of 15s for sub-agents and 60s for background work (the memory update), and a 60s head start for short requests the person waits on (titles, auto mode checks), so the person's own runs go first and nothing starves. Requests for different models run side by side only while the server has room for that many models. A request for a model the server already holds may overtake an older one for another model if it is at most 30s younger, to save a swap.
  - **Sub-agents take turns.** As many sub-agents work on a server at once as it answers requests; the others wait for their turn before their first request and hold it for their whole run. On a one-slot server, parallel Agent calls therefore run one after another, each with its prompt cache warm, instead of interleaving and making the server re-read every prompt. Sub-agents started in the background take turns the same way, while their parent's own requests keep going first.
  - **Helper work stays on the loaded model.** On a server that holds one model, sub-agent definitions' `model`, summaries, titles and WebFetch answers use the conversation's model instead of the small model or an alias, when both are on that server.
  - **Visible waiting.** A waiting run emits `queued {ahead}` (kept in snapshots): Chat, Cowork, Code's status line and a sub-agent's card show "Waiting in line for the model · N requests ahead" ("Waiting for the model" when none is ahead). Speed (tokens per second) and a title's 30s limit count from the moment the request leaves the queue.
- **Personal providers** (`providers/personal.ts`, `protocol/personal-providers.ts`; server mode). A person's own model servers (Ollama, llama.cpp, OpenAI-compatible) and ChatGPT Chat on one of their computers, in the `personal_providers` table (`id` `u-` + 10 `[a-z0-9]`, `user_id`, `device_id`, `type`, `name`, `base_url`, `options` {parallelRequests, modelsAtOnce, vramGiB}, `enabled`). Admin `providers.save` refuses that id shape, so a ref `providerId/modelId` never means two providers, and the model cache, usage and prices work unchanged. An optional key is the personal secret `provider-user-<user>-<id>` (`forUser`, never `forSettings`).
  - **Registry.** `resolve(ref, userId)` serves a personal ref only to its owner (anyone else: "isn't available"), only enabled, and only while its device lends it (`DeviceLinks.info`: `http` with the provider id in `lending.http`, or `chatgptChat` with `lending.chatgptChat`); otherwise "*name* runs on *device*, which isn't connected." `listModels(userId)` appends the person's models with `personal {deviceId, deviceName}` and `available`; `firstAvailable` and every default stay shared. Their adapters get `fetch` = `deviceFetch(user, device, id)` and `chatgptChat` = the device's window over `req chatgptChat` (§21), never the inspector's fetch. Their scheduler queue is `device:<id>|<baseUrl>`, so a desktop's `localhost` never shares a queue with the server's or another desktop's. "Test tool calling" results for them go to the owner's prefs (`personalModels`), not settings.
  - **Events.** `models` (shared list) reaches everyone with their own models appended; `personalModels(userId)` reaches only that person's connections. `DeviceLinks` changes call `devicesChanged(userId)`: availability is re-sent, and a provider whose device just came back is discovered again.
  - **RPCs** (user-level): `personalProviders.list/detect/test/save/remove/refresh/probeTools` and `personalProviders.chatgptChat.status/open/hide/disconnect {providerId?}` (no id: the calling desktop, to sign in before adding). `detect`, `test` and a new `save` need the calling connection's device to lend `http` (or `chatgptChat`): the UI (Settings › Your models) makes the id, lends the address on the desktop (`lending.change {kind: http, id, baseUrl}`), then tests and saves through it.

## 8. Agent runtime (shared by Chat, Cowork, Code)

**Loop** (`agent/loop.ts`):
1. Build the system prompt (§13) and load the history along the active branch.
2. Stream from the model, emitting run events (`session.event`) and persisting parts in batches (about every 750 ms; a snapshot adds the unpersisted tail).
3. When the model emits tool calls:
   - Run the **permission pipeline** for each call. The permission engine decides first: deny rules, the plan-mode refusal, ask rules, allow rules, then the mode's default; a denied call stops there. Otherwise `PreToolUse` hooks run: one can block the call, rewrite its input (the engine judges the new input again), turn an ask into an allow, or force a question to the person. A call still undecided goes to the reviewer in Auto mode, or to the person as an inline prompt that the run awaits.
   - Execute calls. Read-only tools may run in parallel; mutating tools run in order.
   - Run `PostToolUse` hooks, then append the tool results.
4. Repeat until the model stops tool-calling or the Stop button aborts. `Stop` hooks can block a stop and re-prompt.
5. Retry a retryable provider error (rate limit, 5xx, overloaded, a dropped connection) up to 10 times, waiting 5 s at first and up to about 32 minutes at the end; a reply the server could not parse is asked again twice. Show other errors as a message error state with a "Fix" deep link, e.g. *Provider offline → Settings › Admin › Providers*.

**Whose models.** A session's model is resolved as its owner (`ModelResolver.resolve(ref, session.userId)`, also for compaction, auto-mode reviews, sub-agents' turns and the context popover; memory updates choose for the person they are for, `providers/model-choice.ts`), so a person's own models (§7, personal providers) serve only their sessions. A personal model whose computer is away fails the turn with that reason and isn't swapped for another.

**Tools by mode:**

| Tool | Chat | Cowork | Code |
|---|---|---|---|
| WebSearch / WebFetch (each if enabled) | ✓ | ✓ | ✓ |
| `artifact` (create / update / rewrite) | ✓ | – | – |
| `artifact` (show a workspace file in the Artifact pane) | – | – | ✓ |
| `inline_visual` (a diagram or widget in the conversation) | ✓ | ✓ | – |
| MCP tools (enabled connectors) | ✓ | ✓ | ✓ |
| Skill | ✓ | ✓ | ✓ |
| MemorySearch, MemoryView, MemoryUpdate, ChatSearch, ChatRead (when the person's memory settings allow, §8 › Memory) | ✓ | ✓ | – |
| Bash, Read | only in the chat's own sandbox, where one exists (§6) | ✓ | ✓ |
| Write, Edit, Glob, Grep, BashOutput, KillShell | – | ✓ | ✓ |
| TodoWrite, Agent (subagents, also in the background), AskUser | – | ✓ | ✓ |
| SendMessage, ListSessions (messages between sessions; sub-agents get SendMessage to their parent) | – | ✓ (not compact tier) | ✓ (not compact tier) |
| TaskStop; ChangeDirectory (local and SSH folders only) | – | ✓ (not compact tier) | ✓ (not compact tier) |
| AddConnector (an MCP server the person gave by its address, after asking; not sub-agents) | ✓ | ✓ | ✓ |
| ExitPlanMode | – | – | ✓ (plan mode) |

A sub-agent gets the file and shell tools, TodoWrite, SendMessage (to its parent), Skill, the web tools and connectors, narrowed by its definition's `tools` and `disallowedTools`. The compact tier also drops MemoryView and ChatRead.

- **Edit** is exact-string replace and must be unique unless `replace_all`.
  - It reads the file, applies the replacement and writes with `expectSha256` set to the hash it just read, so a concurrent change surfaces as an error instead of being clobbered.
  - "Read before you edit" is a prompt rule, not server-side state.
- **Permission modes:** Auto (the default: what would ask goes to a reviewing model, `permissions/auto-mode.ts`, which allows it, asks the person (ASK: probably wanted but not settled by the person's messages; not counted as a block) or blocks it with a reason; with a hosted model (Anthropic, OpenAI, ChatGPT, GitHub Copilot) its prompt reads "asked for" broadly (`reviewLeniency`), local models keep the strict reading; ask rules and deletions outside the workspace still ask; reads of files elsewhere on the machine and the removal of generated files (`node_modules`, `dist`, caches) or of anything below a temp folder need no review, credential stores (`permissions/sensitive.ts`) still go to the reviewer; after 3 blocks in a row or 20 in all, or when the reviewer can't answer, the person is asked), Ask, Accept edits, Plan (read-only tools plus TodoWrite, AskUser and ExitPlanMode, which shows the plan for approval and then switches mode), Bypass. The ids are Claude Code's: `auto`, `default` (Ask), `acceptEdits`, `plan` and `bypassPermissions`. The system setting `permissions.defaultMode` (default `auto`) is the mode a session starts in; only Code has a mode picker, so a Cowork session keeps the mode it started with. In Auto, allow rules for the whole shell, an interpreter or any sub-agent are ignored, and edits to files that configure git, shells, editors or the agent itself (`.git`, `.claude`, `.atelier`, `.vscode`, shell rc files, …) go to the reviewer. Atelier does not read a default mode from `.claude/settings.json`.
- **Files outside the workspace.** The runner refuses every path outside its roots (§5), so an allowed call on one is followed by `sys.addRoot` for the nearest existing folder (`ChatService.authorize` → `reach`, never `/` or a home folder). The permission context's own roots stay the workspace's: a read that reached `~/Documents` doesn't make edits or deletions there unreviewed.
- **Rule syntax** is Claude Code's:
  - `Bash(git status *)` and legacy `Bash(git status:*)`
  - `Read(./src/**)`, `Edit(//abs/**)`
  - `WebFetch(domain:x)`
  - `mcp__server__tool`, `Agent(name)`, `Skill(name)`
  - A matching deny rule wins over an ask rule, and an ask rule over an allow rule. `Edit` rules also cover Write; `Read` rules also cover Glob and Grep; `Agent` and `Task` are interchangeable.
  - **Paths are compared in one form** (`packages/core/src/paths.ts`, `pathOps`): `/` separators, no trailing separator, and on Windows folded to lower case. A path reaches the backend as `C:\Users\me\app` (a picker, `path.resolve`) or `C:/Users/me/app` (git), in any case; a rule, the workspace-roots check and the dangerous-delete check all see the same file. A runner's own platform decides how its paths compare (a Windows laptop lends folders to a Linux server). Patterns may be written with backslashes on Windows; `//C:/x/**` names a drive path.
- **Compound commands:** Bash commands split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, and every command is also read as bash reads it: quotes and escapes resolved (`r''m`, `"rm"`, `\rm`), `$'…'` with all of bash's escapes (`\x72`, octal, `\u`, `\U`, `\cX`), line continuations and brace expansion (`{rm,-rf,build}`). Deny and ask rules and the dangerous-command check see every form, plus what each command runs: the command behind `if`/`then`/`do`/`!`, `( … )` or `{ …; }`, behind `VAR=value`, behind wrappers (`time`, `nice`, `nohup`, `timeout`, `command`, `exec`, `stdbuf`, `ionice`, `setsid`, `env`, `sudo`, `doas`, `xargs`, `busybox`, `watch`), a shell's `-c` script, `env -S`'s string, each `find -exec/-execdir/-ok`, function bodies, `$(…)`/backquote/`<(…)` bodies, `eval`'s string, here-strings and `echo`/`printf` piped into a shell, and variables set earlier on the line. Deny alone also sees a path-qualified program by its name (`/bin/rm`) and git without its own options (`git -c k=v push`). Allow rules need every command allowed in one of its forms: as written or as bash reads it, or a pure wrapper's inner command (`time npm test` by `Bash(time *)` or `Bash(npm test *)`); what `find -exec`, `xargs`, `sh -c`, `env -S`, `sudo`, `busybox` or `watch` run needs its own rule, a `VAR=value` prefix needs the whole command, and the deny-only forms never count. `command -v` and `exec` with only redirections run nothing. Command substitution, `eval`, `source`, process substitution, `case`, function definitions, GNU `parallel`, a shell reading its input, a command name from a variable or substitution, and quoting that can't be read are opaque and ask, unless the mode is Bypass: there they run, and deny rules only stop what the splitter can see in them. An allow rule for a pure wrapper (`Bash(exec *)`, `Bash(command *)`, `Bash(nice *)`, `Bash(time *)`) allows whatever it wraps, deny rules aside. A deny rule's result tells the model not to reach the same result another way.
- **"Always allow" scope:** "for this project" appends the rule to `permissions.allow` in `<workspace>/.atelier/settings.local.json` (created if needed) and lists that file in the repository's `.git/info/exclude`, never in `.gitignore`; "everywhere" adds it to the person's own rules (`prefs.permissions.allow`); "for this session" is kept in memory until the session ends. A dangerous command offers none of the three.
- **Dangerous-command detector** (`permissions/dangerous.ts`; every mode but Bypass): recursive `rm` and `find -delete` outside the workspace, `sudo` and `doas`, a download piped into a shell or interpreter, `git push --force`, `git reset --hard`, `git clean -f`, `chmod -R 777`, `mkfs`, `dd of=/dev/…`, fork bombs, shutdown/reboot/halt/poweroff. A match forces a prompt with a red warning even when an allow rule matches; in Auto it goes to the reviewer, except deletions outside the workspace, which ask the person.
- **Hooks.** Claude Code's settings shape. Events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop. Handler type `command` only (other types parse but don't run). Chat sessions run no hooks, and sub-agents only PreToolUse and PostToolUse.
  - Stdin JSON fields: `session_id`, `cwd`, `hook_event_name` and `permission_mode` always; `tool_name` and `tool_input` for tool events, plus `tool_response` (the tool's text output) for PostToolUse; `prompt` for UserPromptSubmit; `source` (always `startup`) for SessionStart; `stop_hook_active` for Stop, true from the second round. There is no `transcript_path`.
  - Exit code 2 blocks (stderr is the reason); other non-zero codes are only logged. JSON output fields: `decision`, `reason`, `hookSpecificOutput.permissionDecision`/`permissionDecisionReason`/`updatedInput`/`additionalContext`, `continue`/`stopReason` (`continue: false` ends the turn only from UserPromptSubmit). Hooks of one event run in parallel; a matcher is an anchored regular expression on the tool name; the default timeout is 60 s (at most 3600).
  - A Stop hook runs when a reply ends normally (not after the person's Stop button), in top-level sessions; its block reason goes back to the model and the turn runs again, at most three rounds.
  - **Where hooks run.** Every hook command runs in the session's workspace through its runner (`sh -c`; PowerShell on Windows). Project hooks (`.atelier/settings.json` and `settings.local.json`, and with Claude Code compatibility on `.claude/settings.json` and `settings.local.json`) are read from that workspace, so they work for every kind of workspace, once it is trusted (§6). The administrator's system hooks (`settings.hooks`), enabled plugins' hooks and the hooks in `~/.claude/settings.json` load only for folders on the backend's own machine, never for a lent device, an SSH host, a codespace or the server's sandbox, so a web server never runs them.
  - `CLAUDE_PROJECT_DIR`/`ATELIER_PROJECT_DIR` are always set.
  - Settings › Admin › Code › Hooks says under the JSON editor when an event or handler type isn't supported ("<event> hooks don't run in Atelier."), instead of failing silently.
- **ChangeDirectory.** A top-level Code or Cowork session on a local or SSH workspace may move itself: the tool asks the
  person (their answer may carry another path), `WorkspaceManager.openFrom` resolves it on the same machine (this
  also trusts the folder), the session's `workspaceId` changes and its frozen system prompt is cleared so the next turn
  names the new folder and carries its instruction files; this turn's result says what the folder holds. Not offered to
  compact-tier models, sub-agents, codespaces or lent device folders.
- **AddConnector** (`tools/add-connector.ts`). Given an MCP server's address, a top-level session asks to add it: the
  tool picks the connector's id first and puts the address on a card of its own (`ASKS_ITSELF`, so in every mode, Bypass
  included). Once the person agrees, `ChatServiceDeps.addConnector` saves it and connects: on a server as one of their
  own connectors (`PersonalConnectors.save(…, create)`), on the desktop's backend in Settings › Connectors. On a server,
  the card in the desktop app first lends an address on that computer's network under the connector's id
  (`lending.http`), so the server reaches it through that desktop (§21); the backend waits up to 3 s for that lending
  to arrive over the device link before it tests. The new tools are in the session's tool list from the next step.
  WebFetch's refusal of a private address points to it when the path ends in `/mcp` or `/sse`.
- **SSH connections (desktop).** The person's own list (`prefs.ssh.connections`: name, host, port, key file, folder; a saved
  password is a personal secret `ssh-user-<user>-<connection>`). `SshAccess` probes a host once per backend process with the system
  `ssh` and an SSH_ASKPASS script that logs what ssh asks and answers from the environment: an unknown host key becomes a
  "trust this host?" prompt (accepted: the script answers yes and ssh records it in known_hosts), a password a password
  prompt (optionally saved). A changed key is refused outright. The runner then uses `BatchMode` ssh, or the askpass
  environment with the saved password.
- **Subagents.** The `Agent` tool (`Task` is accepted in permission rules) takes `description`, `prompt`, `subagent_type` and an optional `run_in_background`.
  - Definitions come from `.atelier/agents` and (with Claude Code compatibility on) `.claude/agents` in the workspace, the config folder's `agents` (`~/.atelier/agents` on the desktop, `/data/agents` on a server), `~/.claude/agents` on the desktop with compatibility on, and plugins (`plugin:agent`); the first definition by name wins, so Atelier's folders take precedence. Frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model` (an alias, a model ref or `inherit`), `maxTurns`.
  - `general-purpose` is the one built-in agent; definitions are listed next to it.
  - A subagent runs as a child session (`parent_session_id`) with its own context and the restricted toolset. Sub-agents don't delegate further.
  - Parallel Agent calls start together, but each sub-agent waits for a turn on its model's server (§7, "Sharing a model server").
  - The parent's `tool_call` carries `childSessionId`, which drives a collapsible `SubagentCard` with live progress.
  - Child sessions are excluded from Recents and search (`parent_session_id IS NULL`), and Stop cascades to them.
  - **In the background** (`run_in_background: true`, Code and Cowork): the child starts through the task registry and the call returns at once with a short result naming the task, so the parent's turn goes on (and may end). Only the sub-agent's own stop (Background tasks) and its parent's Stop end it early; it isn't tied to the turn that started it. When it ends (done, failed, stopped, or at its step limit, with the result a foreground call would have returned) its end is queued for the parent as a hidden `context` part (`notes/background-agent`, carrying a `notice` that the transcript shows as "Background agent finished · <task>"):
    - the parent's run is going: at its next model request, as a hidden note message of its own (`kind: 'context'`) before the request is prepared, so the model reads it before its next step;
    - the parent is idle: a run starts by itself and delivers it at its first request. Not after the person's Stop: the ends of sub-agents the person stopped, and ends still waiting when they stopped a run, wait for the next turn instead. Nor while a question waits for the person (it wakes once answered), and at most 5 times in a row (`MAX_WAKES`): later ends wait for the person's next message, which resets the count.
    - Each note is removed from the queue once it is stored, so none is told twice; a run that fails before its first request leaves them for the next turn. They live in the backend, so closing every window loses nothing, and at shutdown the ones still queued are stored, sub-agents stopped by it "stopped because Atelier restarted", so a parent never waits for one after a restart.
    - It counts toward the Ultracode sub-agent budget of the request that started it, and a turn it wakes goes on spending that budget rather than starting a fresh one. Outside Ultracode a session has at most 8 working in the background (`MAX_BACKGROUND_AGENTS`); past them the Agent call fails, telling the model to wait for the running ones.
    - A background sub-agent's permission prompt shows on its parent (as every sub-agent's does), also while the parent is idle; the parent then reads as waiting until it is answered.
- **Messages between sessions** (`tools/send-message.ts`, `ChatService.sendSessionMessage`). Top-level Code and Cowork sessions get `SendMessage { to, message }` and the read-only `ListSessions { query? }` (the person's other top-level Code and Cowork sessions, newest first, at most 30: id, title, mode, status, folder, last change); sub-agents get a `SendMessage` that only writes to `to: "parent"`. Compact-tier models get neither (the compact budget has no room). `to` is a session id or a sub-agent's task id (`agent:<child>`, as the Agent call and background notices name it).
  - **Who may write to whom:** a session to another top-level session of the same owner (another person's reads as unknown, so its existence isn't revealed), to its own running sub-agents, and a sub-agent to its parent; never to itself, a Chat conversation, a sub-agent that has ended or another session's sub-agent. SendMessage isn't read-only, so the permission modes treat it like other changing tools (Ask asks, Auto's reviewer judges, plan mode refuses).
  - **Delivery** reuses background sub-agents' notices: the message is queued for the receiver as a hidden `context` part (`notes/session-message`, saying who wrote it, that it isn't the person's approval and how to answer, with `notice: { kind: 'message', from: { sessionId, title, relation, mode, taskId? }, text }`). A running receiver reads it before its next model request; an idle top-level one starts a turn for it (`wake`, with its guards: not while closing, being deleted, after the person's Stop for what was queued then, while a question waits for the person, or past `MAX_WAKES`). Sub-agents never start turns: one not yet at its first request reads it there, and what arrives during its last reply is dropped with it.
  - **No ping-pong:** each turn carries a chain count, 0 for the person's turns and, for a woken turn, the highest count of the messages it picked up; a message counts one more than its sender's turn (a sub-agent's turn inherits its parent's). Past `MAX_MESSAGE_CHAIN` (3) message-started turns in a row, a message no longer wakes its receiver; it waits for the person's next turn there, and its note and the sender's result say why.
  - **The sender's result** names the target ("Sent to the session "<title>" (id …).", "…the sub-agent… (task agent:…)", "…your parent session…") and whether it is read before the next step, started a turn, waits for an answer to a question there, or waits for the person (and why); a sub-agent whose parent waits on its report is told the parent reads it only after it finishes. The transcript reads the sender's step from it ("Messaged another session", "Messaged a sub-agent", "Messaged the parent session") and shows the receiver's note as `MessageNotice` ("Received a message from another session", "…its parent session", "…a sub-agent").
- **Reply to a passage.** Selecting text in a conversation shows a Reply pill; the passage joins the next message as a hidden `context` part with `notice: { kind: 'quote', text }` (at most 5, 4,000 characters each). The backend (`withQuotes`, on `send` and `queue`) writes what the model is told from the passage itself, escaped and as a block quote under "The person is replying to this passage from earlier in the conversation", so a client cannot put other words there. The transcript shows the passage above the message; an edit keeps it.
- **Effort.** Every model has every level, Low to Max (and Ultracode in Code). Sessions store a level; without one the model's Recommended level for the mode is used (`ModelInfo.recommendedEffort`, else Medium). The model's own setting does what it can and a context note asks for the rest:
  - **The setting** (protocol `effort.ts`): `nativeEfforts` lists the levels the model really has (listed or Low to High for leveled APIs, all for thinking budgets, none for a switch or no thinking); `effectiveEffort` is what the request carries, the stop moved to the next lower native level; a thinking switch is its own on/off setting, independent of the level and on by default (the person's `thinking` preference, kept per session in `overrides.thinking`, shown only for such models and only below Extra): while on, it sends High (as `think` on Ollama, `chat_template_kwargs.enable_thinking` on llama.cpp, whose adapter reads `enable_thinking` or `reasoning_effort` from the chat template in `/props`), and Extra and above force it on; a model without any setting gets none.
  - **The words** (`effortGuidance` → `TurnFacts.effort` → `effortNote`, notes `effort-brief|careful|thorough|exhaustive|normal`): Low asks for a short direct answer, High for care, Extra for thoroughness, Max for the most rigor and verification of everything. Low's note goes to every model; the others go to a switch or a model that doesn't think at every level but Medium (its usual way), and to a leveled model only for a level beyond its range (Max on one that stops at High runs High and asks for the rest). Announced when it starts or changes, repeated every ten person turns, re-announced after a compaction, ended with `effort-normal`.
  - A stored `ultracode` where Ultracode isn't offered is Extra in Code (Max elsewhere, as other modes store it); `shownEffort` is the stop the control shows.
  - **No step cap on a person's own turn.** A model that takes a hundred steps to build something good is left to; what guards a turn is the loop check (the same call with the same result: the model is told on the 6th time and the turn stops on the 15th, `agent/loop.ts`; polling tools are exempt), Stop and context compaction. A **sub-agent**, which nobody watches and whose parent waits on it, has a ceiling of 200 steps (150 on a compact-tier model); a defined agent's `maxTurns` wins. A sub-agent that reaches its ceiling returns an error result to its parent saying it stopped at its step limit before writing a report, with the last text it wrote.
  - **Ultracode** is offered in Code on every model, while the system setting `ultracode.enabled` (Settings › Admin › Code, default on) allows it. It asks providers for Extra (`xhigh`, clamped per model); a thinking switch sends High and a model without levels nothing, and a model whose own setting has no Extra is also asked for Extra's rigor in a note (`effortGuidance`). A model without the Agent tool gets the notes without their sub-agent parts. Context notes (`docs/PROMPTS.md` §8) ask for phased work, parallel sub-agents and adversarial verification: the full note on a branch's first Ultracode turn and after a compaction, a short reminder every ten person turns while it stays on, and one short note when it is turned off or clamped away; whether Ultracode is on comes from the level the run shows (`shownEffort`, not what the model is sent), so a session the mode or admin clamps never hears it. One Ultracode request (the person's message, with everything it starts) may start 24 sub-agents (`ULTRACODE_MAX_SUBAGENTS`, which the note names): past that the Agent tool returns an error telling the model to finish with what it has. Its sub-agents run at Extra and get no notes.
- **Checkpoints.** Before the first Write/Edit of a file in a turn, its pre-image is stored as a blob (null if the file is new) in `checkpoints`.
  - The key is always the **root** session and the root's current user message, including edits made by subagents, so Rewind covers them.
  - "Rewind" on a user message whose turn changed files restores the files touched since, rewinds the conversation to that message (the old branch stays reachable), or both; it is refused while a run is going. Files over 16 MiB aren't captured.
  - Bash side effects are not tracked; the UI says so.
  - Retention follows `checkpoints.retentionDays`.
- **Context** (`agent/context.ts`, `agent/compaction.ts`).
  - **Accounting.** Each request is measured by category: system prompt, skills list, built-in and MCP tool schemas, messages (as sent). It is exact up to the newest reply with a plausible usage report (input + cache + output), and estimated after it with characters per token learned per model from usage reports (smoothed; 4 until the first). Counts outside 1–5 characters a token are ignored: Ollama before 0.33 reports only the prompt tokens its cache didn't have (0.33 reports the whole prompt, with the cached part as cache reads). Within 15% of the threshold, adapters with `countTokens` (Anthropic `count_tokens`, llama.cpp `/tokenize`) count exactly.
  - The `context` run event (before every request and after each reply) carries `used`, `limit`, `threshold`, the categories and `charsPerToken`, so the UI can estimate a streaming reply (the live output count uses the characters per token of the session's own finished replies once they reach 100 tokens, as prompts tokenize differently from replies). `chat.contextBreakdown` measures on demand and adds the session's token usage (Code's context popover). The popover ends with the person's own usage in every mode, today and over the last 7 days, from `usage.summary` (scoped to the caller); the Code home's ring opens the same popover before a session exists, with an empty window of the chosen model's size.
  - **Threshold:** `min(autoCompactAt × window, window − reserve)`, reserve = `min(maxOutputTokens, window / 4, 20k)`. Each request's output cap is clamped to what is left of the window.
  - **Auto-compaction** (all modes) is checked before **every** model request of a turn, between tool rounds too. Budgets scale with the *room* (threshold less system prompt and tools): tool results longer than 30% of it keep their head and tail in what is sent; the newest messages within 35% stay verbatim after the summary (the tail starts at a user or assistant message, so it holds the newest tool round); the summary gets 25% (256–8k tokens). The summary is followed, verbatim, by the current request (unless the tail has it), the todo list, the files changed (checkpoints, Write/Edit; the last 50) and the skills loaded (by name).
  - **Summarizer:** the small model, then the session's model, then the session's model once more with half-size chunks. A transcript longer than the summarizer's window goes in chunks whose summaries are merged (map-reduce); tool calls and results are shortened in what it reads. If every attempt fails, a visible note says so and, for the rest of the turn, the oldest tool results become short stubs in what is sent (never the newest round).
  - **Overflow:** a request the provider rejects as too long (`context_overflow`: Anthropic, OpenAI, vLLM/OpenRouter, llama.cpp, Ollama, LM Studio, Gemini, Groq phrasings) before any output is detached from the branch; the run's threshold drops to 80% of what was sent, and the request is prepared again (compacting) and retried once into the same message.
  - `compacting` run events (and the snapshot's flag) show "Compacting conversation…" while it summarizes.
  - **Compaction never deletes anything.** The summary is an ordinary tree node: `kind='compaction_summary'`, with `summarizes_through_id` pointing at the last summarized message; the first message of the verbatim tail is re-parented under it. The history loader walks root→head and starts at the **nearest summary ancestor**. Everything above changes only what is sent.
  - The UI keeps showing the earlier messages above a "Compacted session · saved N tokens" line (it opens the summary). Branch switching, FTS, export and Rewind still see everything.
  - Rewinding or editing above a summary forks below it, so that branch has no summary.
  - `/compact [focus]` (Code, and the context popover's Compact session) summarizes everything but a request still waiting for its answer. Chat and Cowork only compact automatically; `chat.compact` serves every mode, the UI offers it only in Code.
- **Instruction files.** `ATELIER.md` is Atelier's own instruction file; `AGENTS.md` and `CLAUDE.md` load for compatibility.
  - System (`kind="system"`): `<configDir>/AGENTS.md` (edited in Settings › Admin › Code) and `<configDir>/ATELIER.md`.
  - Personal (`kind="personal"`): the person's **Your ATELIER.md** (Settings › Account), stored in their preferences (`personalization.atelierMd`, the `user_prefs` row), so it reaches their sessions on a server as on the desktop; it imports nothing, since it has no folder. On the desktop's own backend also `~/.claude/CLAUDE.md` (compatibility) and `~/.atelier/ATELIER.md`, which there is the config folder's ATELIER.md and counts as the owner's, not as a system file (`instructionGlobals`, `instructions/instructions.ts`).
  - Project: `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `ATELIER.md`, `CLAUDE.local.md` in that order per folder (ATELIER.md wins over AGENTS.md and CLAUDE.md; the person's own CLAUDE.local.md ranks last), plus `.claude/rules/**/*.md`. The CLAUDE.md family and `.claude/rules` load while Claude Code compatibility (`compat.claudeCode`) is on. Each file is cut at 60,000 characters. A runner from before ATELIER.md rejects the name; the call is repeated without it.
  - Sub-agents get the same files in their frozen system prompt (their child session has the parent's workspace and person), and `<env>` names them: the task label from the Agent call, their session id and the title of the session that started them.
  - Ahead of them, in every mode and Chat too, the administrator's instructions for every conversation (`prompts.organizationInstructions`, Settings › Admin › Capabilities › Instructions), as `kind="system"` (`docs/PROMPTS.md` §1.5).
  - Files are read from the workspace root upward, through the runner's `fs.readAncestors`, so this also works on SSH and Codespaces.
  - Nested subdirectory files load lazily: the first Read/Edit/Write inside that directory appends them to the tool result as a context note (`docs/PROMPTS.md` §1.5); dependency and build folders are skipped.
  - Each file is tagged with its kind (`system`, `personal`, `project`, `rules`), which decides its rank (`docs/PROMPTS.md` §1.5).
  - `@path` imports are followed up to 4 hops. A file imported by another loaded file is deduplicated.
  - ATELIER.md, AGENTS.md and CLAUDE.md all load; the prompts tell agents to write ATELIER.md when they set up or update a project's instructions.
- **Sessions.** Every Chat/Cowork/Code session is a row with a message *tree*: edit and retry create siblings, and the branch switcher shows ‹ 2/3 ›. Sessions are resumable and full-text searchable (FTS5). A title is generated from the first message, before the reply arrives, by the small model (else the session's own).
- **Git (Code).**
  - Branch create/switch, stage/unstage per file, commit (author from settings, applied with `-c user.name/-c user.email`) and push all run via `proc.exec git …`.
  - Push is `git push --set-upstream origin <branch>`. "Open PR" runs `gh pr create` on the workspace's machine, so it needs the GitHub CLI there, signed in with `gh auth login`; there is no REST fallback.
- **Diff review.** Edits apply immediately. In Ask mode the Edit/Write permission prompt shows the diff (approve/deny). After the fact, the Diff pane's compare selector picks what `workspaces.diff { compare }` diffs the working tree against: HEAD (`head`, untracked files included, the default), the index (`staged`), the merge base with the default branch (`base`: origin's HEAD, else a local main/master/trunk; offered off that branch) or each file as it was before the session first changed it (`session`: the earliest checkpoint per path, diffed in core with a Myers line diff, `workspaces/line-diff.ts`, which writes git's "No newline at end of file" markers and header-only patches for empty files, so `git apply` takes them both ways; also outside git repositories, so scratch folders have a Diff pane too). Per-hunk **Reject** reverse-applies a hunk with `git apply --reverse` on `head` and `session` diffs (both end at the working tree); stage checkboxes show on `head` and `staged`.
- **Background tasks** (`agent/background-tasks.ts`). Commands Bash starts with `run_in_background`, running sub-agents and loops are listed per top-level session (a sub-agent's own background commands count toward its parent) in memory while the backend runs: id, kind (`command` | `agent` | `loop`), title, the command or the child session, whether a sub-agent runs in the background, a loop's schedule (interval, runs so far, next send, whether a send waits for the session), start and end time, status (`running` | `done` | `failed` | `stopped`) and exit code. The list is in the session snapshot and changes arrive as `tasks` run events. Every kind brings how it stops and, if it prints, how its output is read, so later kinds (a non-blocking background agent, `/loop`) join without changes to the registry. Running commands are checked every 2 s with `shell.read` from the last offset (only while some run) to notice their end. `tasks.output { since }` reads a command's output from the runner (the pane polls it once a second, only while that output is open), `tasks.stop` kills a command or stops a sub-agent (each has its own stop, combined with its parent's, so one still waiting for a turn on its model's server gives its place and budget back without a request; its parent hears "The sub-agent was stopped."), `tasks.clear` drops finished ones; 20 finished are kept per session.
- **Loops** (`agent/loops.ts`, `/loop [interval] <prompt>` in Code and Cowork; `loops.start`, `loops.stop`). A loop sends its prompt as the person's message, marked as the loop's (a `context` part with a `notice` and the `notes/loop-tick` note that it repeats), at once and then every interval: `30s`, `5m`, `2h`, `1d` or combinations like `1h30m`, 10 minutes without one, at least 1 minute (shorter ones are rounded up; `ATELIER_LOOP_MIN_INTERVAL_MS` lowers that for end-to-end tests only) and at most a day (protocol `loops.ts` reads the command, the backend applies the minimum).
  - **Only while idle.** A send goes only when the session has no run and no question waiting for the person (a background sub-agent's included). One that comes due meanwhile waits and goes once the session is idle, however many intervals passed (no pile-up), and the next interval counts from that send; after the person's Stop the loop stays, but none of the session's loops sends until a full interval after the Stop (a waiting send is skipped). A session runs at most 5 loops and a person 20 (`LOOP_MAX_PER_SESSION`, `LOOP_MAX_PER_USER`). Loops never answer anything: each send is an ordinary message under plan mode and the permission rules, so a permission prompt holds the loop back until it is answered.
  - **Ends** when stopped (`/loop stop [n|id]`, or Stop in Background tasks), when its session is deleted, after 500 sends or 7 days (`LOOP_MAX_RUNS`, `LOOP_MAX_AGE_MS`, ending as done), and with a backend restart: loops live in memory like the rest of the registry, so they go on with every window closed but aren't persisted. `/loop` alone lists them (Code opens Background tasks; Cowork, which has no pane, lists running background work beside the task).
- **Memory** (`memory/`, Settings › Memory; `memory.list`, `memory.get`, `memory.delete`, `memory.instruct`, `memory.import`, `memory.update`, event `memory.changed`). What Atelier remembers about a person across their chats, and the search over their past chats.
  - **Storage.** `memory_entries` (id, user_id, section `preferences` | `profile` | `topic` | `area` | `person` | `project`, title, summary, details as a Markdown bullet list of single facts (up to 24,000 characters), project_id for a `project` entry's Atelier project (`ON DELETE SET NULL`; a project entry without a project reads as an `area`, and the repo only accepts the owner's own projects), sensitive, source `chat` | `background` | `settings` | `import`, source_session_id, created/updated). Preferences and Profile are one entry each per person, with fixed titles; deleting one empties it. Every `MemoryRepo` query takes the owner's id, so a known entry id of someone else's reads as missing. `memory_progress` keeps, per session, the last message the background update read. Both cascade with the user (and the session). The export zip carries `memory.json`.
  - **One decision.** `memoryFor(session, prefs)` (`memory/access.ts`) says what a session gets: Chat and Cowork read (digest, MemorySearch, MemoryView), write (MemoryUpdate: `free` while "Generate memory from chats" is on, `explicit` while it is off, when the tool description says to save only what the person asks to remember or forget) and search past chats (ChatSearch, ChatRead, while "Search and reference chats" is on). Side chats read and search but never write. Code (it works from its project's instructions), sub-agents and signed-out sessions get nothing. A temporary chat (`sessions.temporary`, below) never writes memory; a "start fresh" one also reads none and cannot search past chats (`memoryAccess` and `mayUseChatSearch` in `sessions/temporary.ts`), and temporary chats are never found by past-chat search (`SEARCHABLE_SESSION_SQL`). The chat service, the tools and the background update all ask it.
  - **Per turn.** The frozen system prompt carries the digest right after personalization: Preferences as the person's standing instructions in `<user_instructions source="memory">` ("follow them in every reply, starting with the first one", 4,000 characters; 900 compact), then a `<memory>` block framed as background ("use it when relevant; don't list what you know about them, and don't mention memory unless they ask") with Profile (2,500; 500), inside a project that project's entries with their details (2,500; 400), and a list of the other entries as `section: title: summary (id …)` (40 entries or 4,000 characters; 8 or 700 compact), with "[N more; MemorySearch finds them.]". Only general entries and the session's own project's entries are read: the digest, MemorySearch, MemoryView, MemoryUpdate and the background update all filter by `visibleIn(session.projectId)`. Sensitive entries are left out while the toggle is off. Its hash is in the snapshot, so a change to memory rebuilds the prompt at the next turn (the cached core and fragments stay valid). The `fragments/memory` guidance comes with the tools.
  - **Tools.** `MemorySearch { query }` (up to 8 entries: id, section, title, summary and 300 characters of details), `MemoryView { ids }` (up to 5, full details), `MemoryUpdate { op, id?, section?, title?, summary?, details?, replace?, remove?, private_topic? }` (on an update `details` are lines to add; `replace` rewrites superseded lines; a `project` entry belongs to the chat's project, else becomes an `area`; refused for a private topic while sensitive topics are off), `ChatSearch { query, limit? }`, `ChatRead { session_id, around?, before?, after? }`. Compact-tier models skip MemoryView and ChatRead (MemorySearch's excerpts and ChatSearch's snippets stand in); the compact chat prompt with memory stays within 16,000 characters.
  - **Past chats** (`memory/chat-search.ts`). No embeddings exist in the codebase, so none were added: ChatSearch matches the query's words (stop words dropped, each a prefix, any of them) against `messages_fts` and ranks with bm25, plus four points per query word in a session's title; one hit per conversation with the best message's id and a ~220-character snippet; at most 8 (default 6). Only the person's own top-level sessions, never the asking one (a side chat's main session neither), sub-agents, side chats or temporary chats. The description tells the model to search several times with short, different queries. ChatRead returns at most 6 messages of the session's current branch around a message (2 before and 3 after by default) or from the start, the person's and assistant's text only, each cut at 3,000 characters, with how many follow.
  - **Background update.** When a top-level Chat or Cowork turn ends and the person has "Generate memory from chats" on, the session is scheduled for ten minutes later (restarted by every turn); starting a new session reads that person's waiting ones at once. The job checks `memoryFor` again, reads the branch after `memory_progress` (the person's and the assistant's text, the newest 16,000 characters) and asks the small model (or the session's own when the small one would swap the server's model) at scheduler priority `background` for changes as JSON, with the current memory beside it (`prompts/memory-update.md`: only lasting facts, never credentials, private topics only when allowed, merge instead of duplicating). Changes are line operations: `create` with `details` as facts, `update` with `add`, `replace: [{old, new}]` and `remove`; `mergeMemoryLines` (protocol) applies them, so an update never drops lines it doesn't name. Whole new `details` on an update only add their new lines, except from `memory.instruct`, where the person may ask for a rewrite. Changes for one person run one after another. Timers live in memory: after a restart a session is read at its next turn's idle.
  - **Settings.** `memory.instruct` (the bars at the bottom of the page; with `entryId` or a fixed `section`, only that entry may change) and `memory.import` use the same prompt and the small model (or the model chosen in the page) at `urgent` priority. An import is cut by `splitMemoryExport` (protocol) into parts of about 6,000 characters (whole sections, a long section in runs of lines with its heading repeated); the page sends one part per request to show progress, and the backend splits whatever it gets again, so no reply has to hold a whole export. Each part sees the memory the parts before it wrote and the person's projects; an import never deletes. `memory.update` edits an entry by hand (title, summary, details one fact per line) only while the system setting `memory.manualEditing` (Settings › Admin › Capabilities › Memory, default off) is on; the backend refuses it otherwise. The import prompt the person copies is in `packages/ui/src/features/settings/memory-import-prompt.ts`.
- **Side chats** (`agent/side-chat.ts`, `/btw [question]` in Code, Cowork and Chat; `sideChats.start`, `sideChats.list`, closed with `sessions.delete`). A side question asked beside a session without interrupting it. Each side chat is a child session (`parent_session_id`) marked `overrides.sideChat`, so it is hidden from lists and search like a sub-agent's, deleted with its parent (whose `discard` stops it first), and kept across reloads; the UI shows them as tabs (Code: the Side chat pane; Chat and Cowork: a panel on the right). Unlike a sub-agent it talks to the person: its prompt is the mode's own (not the sub-agent one), and its permission prompts show in its own pane while the parent's mode and rules (and its "allow for this session" approvals) decide them.
  - **Context.** Every request carries, in front of the side chat's newest message and never stored, `notes/side-chat` with the main conversation as it stands (its stored history plus the reply in progress, each message rendered as for the summarizer, the start and as much of the newest part as fits in auto-compaction's verbatim-tail budget, `roomBudgets().tailChars`). So nothing of the side chat reaches the main session, and its own history holds only its questions and answers (compacted like any session's).
  - **Model server.** Like a sub-agent's, its requests use the main session's model and queue as `subagent` (§7 scheduler): on a local server that holds one model and answers one request at a time, it shares that model and slot, so nothing is swapped, and the main run's requests go first. It doesn't take a sub-agent's run-long turn (`agentTurn`), so a quick question doesn't wait for long sub-agent runs to end.
  - **Tools** are the read-only part of the session's (`sideChatTools`): Read, Glob, Grep, WebSearch, WebFetch, the memory and past-chat tools (MemorySearch, MemoryView, ChatSearch, ChatRead) and connector tools marked read-only; no Bash (there is no read-only Bash), Write, Edit, Agent, AskUser, TodoWrite or ExitPlanMode. A chat's side chat has no Read (it would be its own sandbox's).
  - **Model and effort.** The parent's model at each turn; effort Low (`SIDE_CHAT_EFFORT`), whatever the parent's, as a quick question wants a quick answer. Its runs are its own: it never waits for or stops the main run, though on a one-request model server its requests take their turn with the main run's (§7).

## 9. Provider, connector and codespace specifics

### 9-A Provider adapters

| Adapter | Endpoints | Notes that shape the code |
|---|---|---|
| **Ollama** (native) | `POST /api/chat` (NDJSON), `GET /api/tags`, `POST /api/show`, `GET /api/ps`, `GET /api/version` | Always sends `options.num_ctx` (see below). |
| **llama.cpp** | `/v1/chat/completions` (SSE), `/props`, `/health`, `/tokenize`, `/v1/models`; router mode: `GET /models`, `GET /props?model=` | Jinja handling, router mode and reasoning (see below). |
| **Anthropic** | `POST /v1/messages` (SSE), `POST /v1/messages/count_tokens`, `GET /v1/models`; header `anthropic-version: 2023-06-01` | Capabilities, thinking, caching and request rules (see below). |
| **OpenAI** | **Responses API** `POST /v1/responses` (SSE), `GET /v1/models` | The only OpenAI path Atelier uses: it carries tool calls together with reasoning. |
| **OpenAI-compatible** | `/v1/chat/completions`, `/v1/models` (+ OpenRouter `/api/v1/models`) | Stream and reasoning parsing (see below). |
| **ChatGPT Plan** | `POST chatgpt.com/backend-api/codex/responses` (SSE), `GET …/codex/models?client_version=` | The Responses adapter behind the plan's own sign-in; desktop browser OAuth or server device authorization (see below). |
| **ChatGPT Chat** | none: the signed-in chatgpt.com page in a hidden browser window | Desktop only, experimental (see below). |
| **GitHub Copilot** | `POST {endpoints.api}/chat/completions` (SSE), `…/responses` for Responses-only models, `GET …/models` | The Chat Completions (or Responses) adapter behind GitHub's device sign-in; every surface (see below). |

**Ollama**
- Context:
  - Ollama's own default context depends on the machine's memory, so the adapter never relies on it.
  - It always sends `options.num_ctx`: the model's context length, which is the model override, else an estimate from the provider's "Memory budget" (`vramGiB`) when the model's size and architecture are known (`providers/context-estimator.ts`; capped at the trained context), else `min(model context_length, 32768)`.
  - `/api/ps` is only used to tell a model that is loading from one that is reading the prompt. The Models page labels a context length "Calculated" when it came from the memory budget.
- Thinking: `think` is `"low"|"medium"|"high"` from `/api/show.thinking.values` (gpt-oss, whose levels Ollama 0.33 doesn't list, gets the three by family), `true` for other thinking models, and `false` when their switch is off (they think when it's left out); gpt-oss gets nothing when off, as it can't stop reasoning. Helper requests (titles, summaries, page answers) ask leveled models for their lowest level where leaving it out means the provider's default reasoning (Ollama, OpenAI, OpenAI-compatible), never Anthropic's, where a level turns thinking on.
- Replayed reasoning: Ollama 0.33's llama-server backend (Jinja templates) drops an assistant message's `thinking`. When `/api/show` shows a Jinja template, gpt-oss gets a tool-calling turn's reasoning as that message's `content` (its template renders it as the analysis), and templates that read `<think>…</think>` out of content (Qwen) get it there; Go templates keep `thinking`. Only reasoning Ollama produced is replayed, with `<think>`, `</think>` and `<|` broken up so it can't end the block or open a channel. Without it gpt-oss wrote malformed channel headers the server answers with 500 (`model_output_invalid`, retried twice when nothing streamed).
- Capabilities come from `/api/show.capabilities` (`tools`, `vision`, `thinking`, …). Context length is the `model_info.*.context_length` key.
- Tool-call `arguments` arrive as JSON *objects*, and ids may be missing; we synthesize them. Results go back as role `tool` with `tool_name`; call ids go back as nine letters and digits (Mistral's template refuses others).
- Usage: `prompt_eval_count` is the whole prompt on 0.33, with `prompt_eval_cached_count` the part its cache served (cache reads); older servers count only the evaluated part.
- Durations are in ns. tok/s = `eval_count/eval_duration·1e9`.
- Transport: requests to plain-HTTP servers (Ollama, llama.cpp, LM Studio on this computer or the local network) go through `node:http` without fetch's 300-second header and body timeouts, since a server sends nothing while a model writes a tool call; HTTPS keeps fetch. This holds on the desktop too (its backend process passes no fetch of its own). A request ends when the server ends it, its signal aborts, or nothing arrives for 15 minutes (`ATELIER_MODEL_IDLE_TIMEOUT_MS`), which is a retryable `provider_timeout`; a connection dropped mid-reply is fetch's retryable TypeError; redirects are followed as fetch follows them.

**llama.cpp**
- Tool calls need llama-server's Jinja chat template, so `/props.chat_template_caps` signals tool support.
- A model is listed as `prompted` when `/props` has `chat_template_caps` without tool support. When a tool request fails with a 400 or 500 mentioning jinja/template, the run shows the error `llamacpp_no_jinja` ("Start llama-server with `--jinja` (or a tool-capable `--chat-template-file`), or switch this model to prompted tools") with a link to the model settings; nothing switches the model by itself.
- Router mode is detected when `/models` answers with a status per model. It lists the models; `/props?model=` is asked only for loaded ones, so listing never triggers a load.
- Reasoning arrives in `delta.reasoning_content`. tok/s comes from `timings.predicted_per_second`. Thinking is sent as `chat_template_kwargs` (`enable_thinking` for a switch, `reasoning_effort` for levels), whichever the chat template in `/props` reads.

**Anthropic**
- Capabilities and context limits come from `/v1/models` (`capabilities`, `max_input_tokens`, `max_tokens`); a small built-in table (`providers/catalog.ts`) fills in what an entry lacks and gives each model's recommended effort.
- Current ids are `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1`: 1M context, 128k output.
- Thinking:
  - `thinking:{type:"adaptive", display:"summarized"}`, so the thinking is shown.
  - Depth is controlled through `output_config.effort`: `low|medium|high|xhigh|max` (Ultracode asks for `xhigh`; every level is clamped to the ones the model lists).
  - `budget_tokens` is used only for ≤4.5 models, picked by capability: 4k, 10k, 20k, 32k and 48k from Low to Max, never more than the reply's output cap allows.
- Request rules: from 4.7 on (5.x included) no `temperature` is sent; `top_p` and `top_k` never are; a named `toolChoice` degrades to auto; there is no prefill.
- Caching uses at most four `ephemeral` breakpoints (the default lifetime), in this order:
  1. the end of the stable system prefix (the same for every session with that mode, tier and tools; it covers the tools before it)
  2. the end of the whole system prompt
  3. the last block of the final message
  4. the last block of the previous user turn

  With no system block marked, the last tool is marked instead.
- Thinking and `redacted_thinking` blocks are replayed unmodified. Changing the system prompt or tools invalidates them, which drives the prompt-stability rule in §13.

**OpenAI**
- Requests use `store:false`. When the model reasons, the request asks for `include:['reasoning.encrypted_content']`, and the reasoning items are replayed with `function_call` and `function_call_output` items. `max` effort is sent as `xhigh`.
- Tools are flat `{type:"function", name, parameters, strict}`. Arguments are a JSON string.
- Reasoning is `{effort, summary:"auto"}`, and the UI shows summary deltas as thinking.
- `/v1/models` has no metadata, so a small static catalog in core covers context, output and capabilities for the current GPT-6 / GPT-5.x ids.

**OpenAI-compatible**
- Tool-call deltas are merged by `index`. Usage comes from `stream_options.include_usage`, guarding against an empty `choices`.
- Reasoning is parsed from `reasoning_content` (llama.cpp), `reasoning` (vLLM, LM Studio) or `reasoning_details` (OpenRouter, replayed verbatim).
- When the server's model list carries metadata (OpenRouter, vLLM, Groq), it supplies context, modalities and `supported_parameters`. OpenRouter's zero price marks a model `free` (or an id ending `:free`); prices are not read from it and feed no price table.

**Prices** (`providers/prices.ts`)
- `recordUsage` prices a request with the person's own price for the model (`settings.pricing[ref]`), else the provider's published list price (`listPrice(providerType, modelId)`: Anthropic ids lowercased, date suffix dropped, dots to dashes; OpenAI ids lowercased with the date suffix dropped; anything else, and the ChatGPT plan, has none and counts tokens only). Prices from a provider's model list (OpenRouter's) are not used; they only decide the `free` flag. `costOf` applies the long-context tier to the whole request when input plus cache tokens pass its threshold. The table is a snapshot of the providers' pricing pages and is updated by hand.

**ChatGPT Plan** (`providers/chatgpt-auth.ts`, `chatgpt.ts`; desktop and server, off until someone signs in)
- **What it is.** The models in a ChatGPT plan, through the browser sign-in OpenAI built for Codex ("Sign in with ChatGPT"): OAuth authorization code with PKCE (S256) against `auth.openai.com` as the public Codex client, redirect to `http://localhost:1455/auth/callback`, scope `openid profile email offline_access`. The access token authorizes the ChatGPT backend's Responses endpoint, and usage counts against the plan. It is **not** the chatgpt.com chat page (the separate ChatGPT Chat provider below drives that), and it is **unofficial** for anyone but Codex: undocumented, free to change, outside the public API's terms.
- **Sign-in.** `ChatGptAuth` listens on `127.0.0.1:1455` only while a sign-in is open (five minutes at most), checks `state`, exchanges the code, and keeps `{access, id, refresh token, account id, installation id}` as one secret (`chatgpt-oauth`) in the encrypted secret store. Refresh tokens are single-use, so a renewal runs one at a time, is stored before it is used, and a refused one signs out for good; Codex's own `~/.codex/auth.json` is never read, so two programs can't invalidate each other. The id token's claims give the email, plan and `chatgpt_account_id`.
- **Requests.** `createChatGptAdapter` is `createOpenAIAdapter` over a fetch that rewrites the address, adds `Authorization`, `ChatGPT-Account-ID`, `originator: atelier`, `OpenAI-Beta: responses=experimental`, `session-id` and `x-codex-installation-id`, sets `store:false` and `stream:true`, drops `max_output_tokens`, `temperature` and `top_p`, uses a hash of the system prompt as `prompt_cache_key`, and tries once more with a renewed token after a 401. Signed out, it answers 401 with the way back ("Sign in with ChatGPT in Settings › Admin › Providers"). The model list is the account's own (`visibility: list`, in its priority order, with the reasoning levels it reports) and is keyed to a Codex client version: a model is listed only to a client at least the version it needs, so the version asked with is Codex's current one (read from the npm registry, cached six hours, a built-in one as the fallback); when the list can't be read the usual ids are shown with a warning.
- **Usage.** The plan's windows come back in `x-codex-primary-*` and `x-codex-secondary-*` headers and are shown in Code's context popover (the Providers row shows the account's email and plan).
- **Server sign-in.** Web backends use Codex's device flow: JSON `POST /api/accounts/deviceauth/usercode` returns a code for `https://auth.openai.com/codex/device`; the backend polls `/api/accounts/deviceauth/token` (403/404 mean pending), then exchanges the authorization code and verifier at `/oauth/token` with redirect `https://auth.openai.com/deviceauth/callback`. No localhost listener, redirect to Atelier or pasted tokens is needed. Sign-in expires after 15 minutes; cancel, sign-out and backend disposal abort it and reject late results. Tokens stay in the server's encrypted secret store. OpenAI may require device login to be enabled for the account/workspace.
- **Where it stops.** `chatgpt.*` RPCs are admin-only (as are `chatgptChat.*`, `copilot.*` and `openrouter.*`). Like other providers, a server's sign-in serves everyone who can use the provider; the wizard explicitly warns that they use the admin's plan. "ChatGPT Plan" is an entry in Settings › Admin › Providers › Add provider (offered only where `chatgpt.status` says `available`, and until it is added): its step starts the browser sign-in, watches `chatgpt.status`, and saves the provider when it finishes; removing the provider (`providers.remove`) signs out and deletes the stored sign-in. The Code context popover shows the plan's usage windows from `chatgpt.status` (so only admins see them); they are asked for as Codex's own status does (`GET chatgpt.com/backend-api/wham/usage` with the account's headers, at most every 30 s, from `chatgpt.status`), and each reply's `x-codex-*` headers update them too; when the request fails the headers' values stay.

**ChatGPT Chat** (`providers/chatgpt-chat.ts`, `chatgpt-chat-models.ts`, `apps/desktop/src/chatgpt-chat.ts`; desktop only, experimental)
- It has no API. The desktop app keeps a hidden browser window on chatgpt.com with its own cookie storage (`persist:atelier-chatgpt-chat`), types each request into the page and reads the reply back out of it. The person signs in to chatgpt.com in that window (`chatgptChat.open` shows it); Atelier stores no credentials, and Disconnect clears the window's storage. Models and effort come from ChatGPT's own picker.
- On a server there is no such window: `chatgptChat.status` reports `available: false` and the adapter answers "ChatGPT Chat requires the desktop app." Its RPCs are admin-only like the other provider sign-ins.
- Limits: tool calls are written as text in fenced code blocks (the page renders Markdown), it reports no token usage or cost, takes at most 10 files of 20 MB a message, runs one request at a time, and depends on the page's markup. Chats are ChatGPT's temporary chats unless the provider's `temporaryChat` setting is turned off.

**GitHub Copilot** (`providers/copilot-auth.ts`, `copilot.ts`; desktop and server, off until someone signs in)
- **Sign-in.** GitHub's OAuth device flow as Copilot's editor plugins run it (the public client `Iv1.b507a08c87ecfe98`, scope `read:user`): `POST github.com/login/device/code`, then the backend polls `github.com/login/oauth/access_token` at the given interval (5 s more after `slow_down`; `expired_token` and `access_denied` end it) while the person enters the code at github.com/login/device. No redirect comes back, so it works on a server too. The GitHub token is the lasting secret (`copilot-oauth` in the encrypted secret store, with the account's login); it is exchanged at `GET api.github.com/copilot_internal/v2/token` (editor headers `vscode/1.95.0`, `copilot-chat/0.22.0`) for a Copilot token, kept in memory and exchanged again at `refresh_in` (else five minutes before `expires_at`), one exchange at a time. A 401 there signs out and deletes the token; a 403/404 means no Copilot on the account. A sign-in is refused when the first exchange fails. Every answer is checked with zod.
- **Requests.** `copilotFetch` sends to the token's `endpoints.api` (default `api.githubcopilot.com`) with `Authorization: Bearer`, `Copilot-Integration-Id: vscode-chat` and the editor headers, once more after a 401. Per request: `Openai-Intent: conversation-edits`, `X-Initiator: user` only for the person's own turn (foreground with an owning session and a last message that is theirs, not tool results; everything else is `agent`), `Copilot-Vision-Request: true` with images. Models: `GET /models`, kept when `model_picker_enabled`, not `policy.state: disabled`, and with `tool_calls`; context is the window capped at prompt + output limit. A model that takes `/chat/completions` (or names no endpoints) uses the Chat Completions adapter; one that only takes `/responses` uses the Responses adapter; one only on `/v1/messages` is left out. When no model is marked for the picker (restricted plans), the models whose policy is `enabled` are listed. An extra "Copilot Auto" model lets Copilot's router choose the model per conversation.
- **Where it stops.** `copilot.*` RPCs are admin-only, like providers: one admin's sign-in serves everyone the provider is shared with. The Add provider entry runs the sign-in (code, copy button, link), watches `copilot.status` and saves the provider when it finishes; removing the provider signs out. Unofficial outside GitHub's own clients.

**Web search** (`packages/core/src/search/`; on by default, nothing to configure):
- **Built-in (`provider: auto`).** The open web through result pages, in preference order: DuckDuckGo HTML (`POST html.duckduckgo.com/html/`), Brave (`GET search.brave.com/search`, its own index), DuckDuckGo Lite (same backend, same breaker), then Bing, though an engine that would have to wait more than 1.5 s for its turn is tried after one that is ready. Wikipedia's API is the floor when the engines push back, announced to the model as "Wikipedia only". Parsers read the markup with linkedom and are tested against recorded pages (`search/__fixtures__`).
- **By topic (`topic.ts`).** The general engines answer a news query with the company's own pages and a programming question with whatever shares the words, so what a query is about decides the sources. `detectTopic` scores the query's words (news: "announced", "keynote", "today", "this week", a recent year; programming: error words, tool and language names, code-shaped tokens; "weather", "recipe" and the like stay general), and the tool's optional `topic` (`news | dev | general`) overrides it. **News** goes to Bing News and Google News (RSS, `engines/bing-news.ts`, `google-news.ts`; US English edition; outlet and publication time per story; Bing News matches every word, so it gets the query's keywords, Google the sentence) and to the general engines only when fewer than five stories came back. **Programming** goes to Stack Overflow (the Stack Exchange `search/excerpts` API: matching passage, answer count, accepted), Hacker News (Algolia; ≥5 points, words dropped from the end until something matches, results that no longer share the subject discarded) and GitHub repositories (the query's subject, without version numbers and "release notes"-type words, most starred first), **with the general engines alongside**, which are not waited for beyond three seconds once five community results are in. A query with one hint of news ("Apple event") gets the news feeds **and** the general engines. The specialists run through the same limiter and breakers (own families and gaps; a 429/403, a Stack Exchange `backoff` or an empty quota opens the breaker), results that share nothing with the query are dropped, `freshness` filters by publication time (Google also gets `when:`), and next to real stories only the general results that are themselves about the query are kept, and fusion merges one story across feeds by headline (the Google link is a redirect that opens in a browser but cannot be fetched, so the Bing link wins when both have it; `allowed_domains` use the outlet's site). Recency raises a story's rank only when the query asks for the newest ("latest", "today", a freshness window).
- **Reading the first results (`excerpt.ts`).** For the first three readable results the service fetches the page (WebFetch's guard against private addresses, redirects only within the host, 1.5 MB, 4.5 s each, HTML only; sites that answer scripts with a wall, such as Reddit, X and YouTube, are skipped), takes the main content with Readability and keeps the one or two paragraphs that share the most words with the query (the lede otherwise), about 700 characters, shown to the model as a `Page:` line. Stack Overflow results are not read (their snippet is the passage). Off in the end-to-end tests (`ATELIER_SEARCH_BASE`). Result pages are fetched from the machine the backend runs on: the person's computer on the desktop, the server on the web.
- **Transport.** On the desktop the backend's utility process fetches the DuckDuckGo, Brave and Bing pages with Chromium's own network stack (`net.fetch`, no cookies; `apps/desktop/src/web-fetch.ts`, passed in as `Platform.webFetch`), which search engines treat as a browser. The news feeds, Wikipedia, the developer APIs and the page excerpts use Node's `fetch` on both surfaces, and so does everything on a web server, whose built-in search leans on the rate limits and failover below.
- **Behaviour.** Each engine family has its own minimum gap between requests (DuckDuckGo 4 s, Bing 2.5 s, Brave 2 s, the news feeds 1.5 s, the developer APIs 0.8 to 3.5 s, plus some jitter), and at most four requests are in flight, queued in order and abort-aware. A block (HTTP 202/403/418/429/503, challenge markup) opens that family's breaker for two minutes, doubling to twenty; a page without results counts as "no results" only when a second engine agrees, and results for another query (a decoy page, checked by `answersQuery`) count as empty. Answers are cached for ten minutes (two with a freshness filter) and merged by reciprocal-rank fusion when more than one engine answered; at most three results per site.
- **Safety.** Engine URLs are fixed constants. Queries over 400 characters, or containing a credential shape or a stored secret's value, are refused before any request. Titles and snippets are untrusted: stripped of markup and control characters, length-capped, and the tool's description tells the model they are data.
- **Your own provider (`searxng`, `brave`, `tavily`).** Used alone, never as a fallback, so queries go only where the person chose: SearXNG `GET /search?q=&format=json` (JSON output must be enabled in `settings.yml`; a 403 says so with the fix), Brave Search API `GET api.search.brave.com/res/v1/web/search` with `X-Subscription-Token`, Tavily `POST api.tavily.com/search` with `Authorization: Bearer`. A provider without its URL or key behaves as the built-in search.
- **Observability.** `search.status` reports each engine as ok, limited (with when it is tried again) or unknown; `search.test` (admin, Settings › Admin › Capabilities › Web › Test search) runs one real query. Nothing is sent to Atelier or anyone but the engine that answers, and the search service logs no query text.
- **What the model reads.** A numbered list; a story shows `Published: Oct 13, 2026 (4 days ago) · PCMag`, results show their snippet and the `Page:` passage, a Google redirect says it is not fetchable, and the footer `(via Bing News, Google News and Bing · 10 results)` stays the line the UI reads. The prompt (`search.full.md`) says to search the plain topic first, never to put guesses (names, dates) in a query, and to check dates.
- **Tests.** `ATELIER_SEARCH_BASE` points the engines at a fake server (end-to-end tests; the specialists' endpoints too); `pnpm --filter @atelier/core exec tsx evals/search.ts` runs ten real queries against the live engines, opt-in, to see what each one does today.

### 9-B MCP and connector presets

- **Protocol:**
  - The current spec is **2026-07-28**: stateless, with no `initialize`, no sessions and no GET stream. It uses `server/discover`, `subscriptions/listen` for list changes, and multi-round-trip `input_required` results for elicitation.
  - Most servers in the wild are still 2025-era.
  - The SDK v2 client with `versionNegotiation:{mode:'auto'}` probes modern first and then falls back to `initialize`. If HTTP fails without a modern error body, the connection manager falls back further to legacy HTTP+SSE (GET → `endpoint` event). A server found to speak only the legacy protocol is remembered, so reconnects skip the modern probe.
- **Transports:**
  - Desktop: stdio, launched by the backend with `${secret:…}` resolved into env; stderr goes to the MCP log. A web server never starts stdio servers (the connector shows an error pointing to the HTTP endpoint).
  - Desktop and web: Streamable HTTP, plus legacy SSE.
- **Auth:**
  - Static `Authorization: Bearer` or custom headers are first-class.
  - OAuth (`auth: 'oauth'` on an http or sse server) runs the SDK's `auth()` with Atelier's own `OAuthClientProvider`s (`core/src/mcp/oauth.ts`): PRM discovery, PKCE, the RFC 8707 resource indicator and the RFC 9207 `iss` check. The authorization page must be https (http only on loopback, for tests).
  - Registration: dynamic client registration (a public client, `token_endpoint_auth_method: none`) wherever the authorization server offers it; a client ID metadata document (`<origin>/oauth/client-metadata.json`) only on https servers whose authorization server offers no registration. The authorization server has to fetch that document, which a server reachable only on a LAN or tailnet can't serve, so CIMD first would break most self-hosted setups.
  - An admin signs a connector in once (Settings › Admin › Connectors; `mcp.signIn` returns the authorization URL, `mcp.cancelSignIn`, `mcp.signOut`). The browser comes back to a loopback listener on 127.0.0.1 with a port of its own on the desktop's built-in backend, open only during the sign-in, and to `<origin>/oauth/callback` on a server, also for desktop apps connected to it (the flow runs on the server). `state` is random, single use and expires after 10 minutes; a sign-in started in a browser finishes only with the same admin's cookie.
  - The client registration and tokens are one secret, `mcp-oauth:<name>` (kind `mcp_oauth`), kept out of Keys & secrets and out of `${secret:…}` references. An expired access token is refreshed before the next request (once for all waiting requests), a refused one on its 401; a refused refresh forgets the sign-in and the status says `signIn: 'needed'` instead of retrying. Removing a connector, or changing its URL or auth, forgets its sign-in, on a settings write only, so a settings file that fails to load signs nothing out.
- **Tools:**
  - Named `mcp__<server>__<tool>`, so Claude Code permission rules apply (characters outside `[a-zA-Z0-9_-]` become `_` and the name is cut to 64 characters; descriptions are cut to 2,048).
  - `annotations.readOnlyHint` lets read-only calls run in parallel, but stays untrusted for permissions.
  - Output is capped at about 25k tokens with a truncation notice. Images pass through to vision models.
- **Elicitation** (form mode) shows an inline form card. URL mode shows the full URL and asks for consent.
- **Import** reads `~/.claude.json` (user and per-project `mcpServers`) and `.mcp.json`, converts `${VAR}` references, and offers to move literal secrets into the secret store.
- **Personal connectors** (server only; `core/src/mcp/personal.ts`): anyone's own, beside the admin's shared ones.
  - Kept in `UserPrefs.connectors` (at most 50) without values: `{id, name, type, command?, args, url?, envKeys, headerKeys, enabled, disabledTools, auth?}`. The values are one personal secret per connector, `connector-user-<user>-<id>` = `{env, headers}`; an OAuth sign-in is `mcp-oauth-user-<user>-<name>`. Written only through `connectors.{list,save,remove,test,signIn,logs,import}`; `prefs.set`/`prefs.reset` refuse the path. A name an admin's connector has is refused on save; one an admin takes later stays off (`clash` in `connectors.list`) and the shared one wins.
  - One `McpManager` per person, made when they first have one. It is not a fork: the manager takes `reach` (a transport, or the `fetch` HTTP goes through), `startable`, `signInSecret` and `deferEnv`. It resolves only that person's own secrets (`SecretStore.forUser`) and none of the server's environment (`env: {}`); a stdio connector's `${VAR}` is left as written for the desktop to fill in. Its log stays the person's (`connectors.logs`), never the server log.
  - stdio runs on the first online desktop of that person whose `lending.connectors` has the connector's id with the fingerprint `sha256(connectorFingerprintInput(command, args, envKeys))`, through `links.start({kind:'mcp'})`. `line-transport.ts` has both ends: `LineTransport` (an SDK `Transport` over the channel's lines) on the server, `programChannel` (the program's stdio through the SDK's stdio transport) on the desktop. A device coming, going or changing what it allows retries the failed ones; the status says `Offline on <device>` or how to allow it.
  - HTTP/SSE run on the server for public addresses (`tools/address-guard.ts`, re-checked on every request, redirects not followed). An address on the person's computer or network (private, loopback or unresolvable from the server) goes through a desktop whose `lending.http` has an entry with the connector's id (`deviceFetch`).
  - A session's tools are the shared ones plus the person's, `connectorsOff` applied to both. `mcp.status`/`mcp.changed` carry the person's own with `personal: true` (and `device` while it runs there), to them only. The OAuth callback tries personal managers by `state` first.

| Preset | Default setup | Alternative | Token page / permissions |
|---|---|---|---|
| **Cloudflare** | `https://mcp.cloudflare.com/mcp` (Cloudflare's API server), `Authorization: Bearer <API token>` | OAuth | dash.cloudflare.com/profile/api-tokens. Grant only what you need; account tokens need *Account Resources: Read*; no IP-filtered tokens. |
| **GitHub** | `https://api.githubcopilot.com/mcp/` with PAT bearer (the hosted server may need Copilot on your account) | – | github.com/settings/personal-access-tokens/new; fine-grained tokens work, classic ones need the `repo` and `read:org` scopes |
| **Notion** | Local stdio `npx -y @notionhq/notion-mcp-server` with `NOTION_TOKEN` (desktop only; needs Node.js) | OAuth against `https://mcp.notion.com/mcp` (the only option on web) | notion.so/profile/integrations; read (plus insert/update) content, then share pages with the integration |
| **Linear** | `https://mcp.linear.app/mcp`, `Authorization: Bearer lin_api_…` | OAuth | Linear › Settings › Security and access › Personal API keys |
| **Brave Search** | stdio `npx -y @brave/brave-search-mcp-server`, `BRAVE_API_KEY` (desktop only; needs Node.js) | – (on a server: use the built-in web search with Brave) | api-dashboard.search.brave.com/app/keys |
| **Home Assistant** | `<HA_URL>/api/mcp`, `Authorization: Bearer <long-lived token>` | – | HA › Profile › Security › Long-lived access tokens (admin user; enable the "Model Context Protocol Server" integration) |
| **Custom** | stdio (desktop) or HTTP, with headers, env and secrets | OAuth | – |

A stdio preset that uses `npx` says in its note that it needs Node.js.

Cloudflare, Notion and Linear can be signed in to with OAuth instead of a pasted token. GitHub and Home Assistant use tokens only, and a custom http or sse connector can try OAuth through its OAuth switch.

### 9-C Codespaces workspace

- **Auth.** Two methods:
  1. **Device flow** for an OAuth App you register once (free, 2 minutes, "Enable device flow" ticked). The app's *client id* (`cloud.github.clientId`) goes in Settings › Cloud, where an admin enters it. It requests scope `codespace` plus `repo` for PRs.
  2. A **classic PAT** with `codespace` and `repo`; a classic token without `codespace` is rejected.

  Fine-grained PATs are accepted but labeled "may not work for terminal access", because `gh codespace ssh` with fine-grained tokens is unverified. The token is the person's own secret (`github-user-<userId>`, kind `github`), never listed to admins.
- **REST** (`packages/core/src/cloud/codespaces.ts`, `github.ts`):
  - List: `GET /user/codespaces`; repositories for the picker: `GET /user/repos` (newest push first, up to 5 pages)
  - Machines: `GET /repos/{o}/{r}/codespaces/machines?ref=`
  - Create: `POST /repos/{o}/{r}/codespaces {ref, machine, idle_timeout_minutes}`, then poll `GET /user/codespaces/{name}` every 1s until `state=="Available"` (timeout 3 min)
  - Start and stop: `POST …/{name}/start|stop`
  - Delete: `DELETE …/{name}`
- **Transport.** No exec API exists, so we reuse the SSH code with a different command prefix. A `RemoteShell` (`workspaces/ssh.ts`) is either `ssh … <host>` or `gh codespace ssh -c <name> --` with `GH_TOKEN` set; both go through the same `bootstrapRunner` (uname, upload over stdin, checksum) and `remoteRunnerChannel` (`--stdio`).
  - `gh` must be on PATH (or its path in `ATELIER_GH`); if it is missing the error names the install page. It does not have to be signed in: Atelier passes the connected token as `GH_TOKEN`. The server image bundles `gh` with `openssh-client`.
- **Requirement.** The codespace needs `sshd`; the default image has it.
- **Lifecycle.**
  - Settings › Cloud lists the person's codespaces with state, repository, machine and idle timeout ("stops after N min idle"), and Use as folder, Start/Stop and Delete. The create dialog offers idle timeouts of 5, 15, 30, 60, 120 and 240 minutes (default 30); "Open this repository" makes one on the largest machine the account can use, with the 240-minute maximum.
  - A codespace stops after its idle timeout. Opening a session in a stopped codespace's folder starts it again and waits until it is available (the session shows that it is waking).

## 10. Extensions (skills, plugins, commands, agents)

**Where files live.** Global roots are on the backend host. Project roots live wherever the workspace lives, which may be a remote SSH host or a codespace. So there are two readers:
- **`WorkspaceFs`** `{read, write, list, watch}` (`fs/workspace-fs.ts`, a Node implementation with a chokidar watcher) serves the backend host's own files: the global settings, prompt overrides and the global instruction files.
- **`ExtensionFs`** `{list, read, realpath}` (`extensions/skills.ts`) serves skills, commands and agents. `hostFs` reads the backend's folders directly; `workspaceFs(ws)` reads the workspace's folders through its runner (`fs.list`, `fs.read`, `fs.stat`), so they work on SSH hosts and codespaces. Project-level permission and hook files are read through the runner too (`workspaces/project-rules.ts`).

**Discovery roots.** The backend host's global roots, plugin registries and Claude Code's `installed_plugins.json` are watched (symlinks followed, depth 2) and hot-reloaded. A workspace's folders are read through its runner whenever the catalog is built, with no watcher. Skills are deduplicated by realpath; the first definition of a name wins.

| Kind | Global | Project (the workspace root only) | Other |
|---|---|---|---|
| Skills | `<config dir>/skills` (`~/.atelier/skills`; a server: its data folder's `skills`), then on the desktop `~/.agents/skills` and, with `compat.claudeCode` on, `~/.claude/skills` | `.atelier/skills`, `.agents/skills`, then `.claude/skills` (compat on) | plugin `skills/` |
| Commands | `<config dir>/commands`, then on the desktop with compat on `~/.claude/commands` | `.atelier/commands`, then `.claude/commands` (compat on) | plugin `commands/` |
| Agents | `<config dir>/agents`, then on the desktop with compat on `~/.claude/agents` | `.atelier/agents`, then `.claude/agents` (compat on) | plugin `agents/` |
| Plugins | Atelier installs: `<config dir>/plugins/cache/<mkt>/<plugin>/<ver>`, registered in `<config dir>/plugins/installed.json`; on the desktop with compat on, Claude Code installs read from `~/.claude/plugins/installed_plugins.json` (version 2; source "Claude Code", toggle only) | – | – |

**Skills:**
- A skill is a folder directly inside a skills root that holds a `SKILL.md`; entries starting with `.` are skipped, and skills in nested subfolders are not found. Parsing is lenient: a name/dir mismatch or an invalid name is only a warning (the folder name is used), and a missing description skips the skill.
- Of Claude Code's frontmatter, Atelier reads `name`, `description` (collapsed to one line, at most 1,024 characters), `disable-model-invocation`, `user-invocable` and `argument-hint`. `allowed-tools`, `model`, `context` and `paths` are ignored.
- Only name and description (shortened to 250 characters) enter the prompt, as `<available_skills>` capped at about 1% of the context window (at least 2,000 characters); skills with `disable-model-invocation` are left out. The full body loads via the `Skill` tool or `/name`.
- Substitutions: `$ARGUMENTS`, `$N` (0-based), `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}` and, for plugin skills, `${CLAUDE_PLUGIN_ROOT}`. The text starts with "Base directory for this skill: <dir>", and arguments the body doesn't place are appended as `ARGUMENTS: …`. Commands take `$ARGUMENTS` and `$1…` (1-based). There is no `` !`cmd` `` pre-execution.
- Precedence is project > global > plugin. Plugin skills are namespaced `plugin:skill`.
- Commands and skills share one `/` namespace; a skill wins over a command with the same name.
- **Remote workspaces:** a global skill's text is read on the backend. Its scripts and references are reachable by the session's file tools only when the folder is on the same computer (`sys.addRoot` on the skill's folder, desktop); they are not copied to SSH hosts or codespaces. The runner roots `~/.atelier/skills-cache` for that purpose, but nothing fills it yet.

**Installing** (admin only):
- **Skills:** from a GitHub address (`owner/repo[@ref][/path]` or a github.com URL), via a codeload tarball; every folder with a `SKILL.md` up to three levels below the path is installed. There is no zip upload.
  - **Shared install** (§20): on the desktop, skills go into `~/.agents/skills/<name>`, and with `compat.claudeCode` on a relative symlink `~/.claude/skills/<name>` → `../../.agents/skills/<name>` is made. That is the same layout `npx skills -g` produces, so Claude Code and other agents see Atelier installs.
  - If `<name>` already exists from another source, the installer refuses and the Skills page offers to replace it.
  - Provenance goes into Atelier's own `<config dir>/skills-lock.json`: source (`owner/repo`), the commit SHA, the path in the repository and installedAt. Installing again overwrites; there is no update step.
  - We never write `~/.agents/.skill-lock.json`, which belongs to `npx skills`.
  - Where the symlink can't be made (Windows without Developer Mode, say) the installer copies instead.
  - A server installs into its data folder (`/data/skills/<name>`) with no link.
- **Plugins:** from a marketplace, given as `owner/repo` or a github.com URL of a repository with `.claude-plugin/marketplace.json`.
  - Installable plugin sources: a path inside the marketplace repository, and a GitHub repository (`repo`, optional `ref` and `path`). Others (`url`, `git-subdir`, `archive`, …) are listed with the reason "can't be installed yet".
  - `enabledPlugins` and `extraKnownMarketplaces` use Claude Code's settings shape; installing a plugin records its marketplace in `extraKnownMarketplaces`. Atelier's `enabledPlugins` wins over Claude Code's own; a plugin with no entry is on.
  - Each plugin has one on/off switch (`plugins.setEnabled`, which writes `enabledPlugins`); its row lists its skills, commands and agents. Its hooks run for folders on the backend's own machine (§8). A plugin's MCP servers are not loaded.
  - `${CLAUDE_PLUGIN_ROOT}` is replaced in skill and command bodies and in plugin hooks.
- **Web:** the same code against the server's data folder. Installs come from a pasted GitHub address.

## 11. Data model (Drizzle, SQLite)

| Table | Key columns |
|---|---|
| `users` | id, username (unique, lowercase), name, role (admin\|user\|pending), password_hash (scrypt), must_change_password, avatar_blob, safeguards (inherit\|on\|off), last_active_at, disabled_at, created_at, updated_at |
| `auth_sessions` | id, token_hash (sha256), user_id, client_kind (web\|desktop), device_id, user_agent, ip, created_at, last_seen_at, expires_at |
| `passkeys` | id (credential id), user_id, public_key, counter, transports, name, created_at, last_used_at |
| `invites` | id, token_hash, code_hint, role, created_by, expires_at, used_at, used_by |
| `devices` | (user_id, id), name, platform, created_at, last_seen_at |
| `user_prefs` | user_id, prefs (json, `UserPrefs`), updated_at |
| `projects` | id, user_id, name, description, instructions, created_at, updated_at, archived_at, pinned_at |
| `sessions` | id, user_id, mode (chat\|work\|code), title, project_id?, workspace_id?, parent_session_id?, model (`providerId/modelId`), effort, permission_mode, overrides (json: connectors switched off, thinking, research, remote control, side-chat marker …), head_message_id, status (idle\|running\|waiting\|interrupted\|error), pending (json: open permission/AskUser/elicitation request), todos (json), **system_snapshot** (a blob ref; the frozen connector tools live inside it) and **tools_snapshot** (reserved: nothing writes it), seq, pinned_at?, **finished_unseen_at?** (a turn ended while nobody looked: the sidebar's blue dot, cleared by `sessions.markSeen`), **group_id?** (→ `session_groups`), **archived_at?**, **temporary?** (`private`\|`fresh`, null for ordinary sessions: see *Temporary chats* below), created_at, updated_at |
| `session_groups` | id, user_id, name, collapsed, created_at: a person's own sidebar groups for Code and Cowork sessions (`groups.list/create/update/delete`, event `groups.changed`); deleting one ungroups its sessions. Filing, archiving and marking unread are `sessions.update` fields that don't count as activity (a quiet patch); `sessions.fork` copies the active branch into a new session in the same folder; `sessions.list` hides archived sessions unless `archived` asks for them. |
| `messages` | id, session_id, parent_id?, role, parts (json), model, usage (json), stop_reason, error (json), kind (normal\|compaction_summary\|context), summarizes_through_id?, search_text, created_at |
| `messages_fts` | FTS5 over `messages.search_text` (an external-content table kept in sync by triggers) |
| `blobs` | sha256 (pk), size, mime, created_at — files on disk under `blobs/ab/cd/<sha>` |
| `files` | id, user_id, session_id?, message_id?, project_id?, blob, name, mime, size, tokens?, kind (upload\|generated\|output\|project), workspace_path?, created_at — powers file cards and project knowledge |
| `artifacts` / `artifact_versions` | id, session_id, identifier, type (html\|react\|svg\|mermaid\|markdown\|code), title, language?, created_at, updated_at / artifact_id, version, content, message_id, created_at |
| `workspaces` | id, user_id, kind (local\|ssh\|codespace), name, root, host (SSH host or codespace name), device_id (the desktop that hosts it, in server mode), scratch, sandbox, created_at, last_used_at |
| `checkpoints` | id, session_id (root), message_id, path, before_blob?, created_at — one row per file per turn |
| `usage_events` | id, ts, user_id, provider_id, model_id, session_id, mode, input, output, cache_read, cache_write, reasoning, duration_ms, tokens_per_second, cost_usd |
| `model_cache` | provider_id, model_id, info (json), discovered_at |
| `secrets` | id, label, kind (api_key\|token\|mcp_oauth\|github), ciphertext, tail (last four characters, for the masked value), expires_at?, created_at, rotated_at, last_used_at |
| `memory_entries` / `memory_progress` | see *Memory* in §8 |

User-owned rows are scoped by `user_id`, directly or through their session, and the desktop's own backend has users too (one, created by `auth.setupLocal`; §21). Migrations come from drizzle-kit (`packages/core/drizzle/`, embedded into `store/migrations.gen.ts`) and are applied on startup. Once a day a job prunes old checkpoints (`checkpoints.retentionDays`), deletes each person's sessions older than their retention period (`prefs.privacy.historyRetentionDays`; pinned ones stay) and then deletes blobs nothing references.

### Temporary chats

`sessions.temporary` is the single source of truth: null for an ordinary session, otherwise the person's `prefs.privacy.temporaryChats` (`private` by default, or `fresh`) frozen when `sessions.create({ temporary: true })` made it (Chat only, no group). Sub-agents, side chats and forks inherit it (`SessionRepo.create`/`fork`). Decide with the helpers in `packages/core/src/sessions/temporary.ts`, never by reading the column ad hoc:

| Helper | Meaning |
|---|---|
| `isTemporary(row)` | any temporary session |
| `temporaryMode(row)` | `'private' \| 'fresh' \| null` |
| `usesPersonalContext(row)` | false for `fresh`: no personal instructions, response style, name (`callMe`), project context, personal instruction files (`kind: 'personal'`), memory digest |
| `memoryAccess(row)` | `{ read, write }`: read unless `fresh`; write never for a temporary session (no memory tools that write, no background memory generation from it) |
| `mayUseChatSearch(row)` | false for `fresh` (no search over past chats from it) |
| `notTemporary()` / `NOT_TEMPORARY_SQL` | the condition every query over history uses (drizzle / raw SQL on `sessions`); chat search over past chats must apply it too |

Enforced in: `SessionRepo.list` (sidebar, Recents, project pages, palette; `withTemporary` only for account deletion) and its `messages_fts`/title search, project chat counts (`ProjectRepo.list`), `ArtifactRepo.listForUser` (Artifacts page), `exportAll`, `ChatService.systemFor` (fresh mode), `sessions.continueInCowork` (refused). `sessions.create` doesn't broadcast `sessions.changed` for one; the UI's `useSessions` drops any that arrive anyway.

Deletion (everything goes as with `sessions.delete`: run stopped, messages, files, artifacts, checkpoints, children by cascade): `sessions.leave` (the UI's live-session release, 1 s after the last view lets go) deletes it when no other connection is subscribed; a connection that closes or drops schedules the same check for its subscriptions after 60 s (a reload or reconnect resubscribes in time); the backend sweeps hourly and at start for ones idle over `TEMPORARY_MAX_IDLE_MS` (24 h), and 60 s after start for any left from before that no window reopened.

## 12. Settings schema and layering

These are the **system settings** (§21), written by admins. Each person's own preferences are a separate document (below).

- **Layers.** The system settings are the global file: `~/.atelier/settings.json` on the desktop, `<data dir>/settings.json` on a server (`SettingsService` in `settings/settings-service.ts`). The service also supports a project layer (`<root>/.atelier/settings.json`) and a local one (`<root>/.atelier/settings.local.json`), but the backend does not load them as settings. A project brings only `permissions` and `hooks` this way, read through the workspace's runner (`workspaces/project-rules.ts`, cached for 5 s):
  - `settings.local.json` is created by "Always allow in this project" and listed in the repository's `.git/info/exclude` (never in `.gitignore`).
  - Claude Code's `.claude/settings.json` and `.claude/settings.local.json`, and on the desktop `~/.claude/settings.json` (for folders on the same computer), are read as a lower-precedence compat layer for `permissions` and `hooks` only (see Q3). The switch is `compat.claudeCode`.
  - Permission rules are concatenated when a session asks (§8): Claude Code's, then the system's, then the project's, then the person's own "always allow" rules. `defaultMode` comes from the system setting alone. Everywhere else, objects merge deep and arrays replace.
- **Schema.** zod in `protocol` (`settings.ts`) is the source of truth. A key in a file that fails validation is left out and named, the rest of the file still applies, and writes keep unknown keys.
- **Writes.** Every Settings row writes exactly one JSON path. Writes are atomic (temp file and rename) and comment-free, and an external edit is picked up by the watcher.
- **Badges.** A row shows a "Project" badge plus "Reset" when its effective value comes from the project or local layer. No system setting can come from there today.
- **Secrets.** Any string may contain `${secret:<id>}` (secret store) or `${ENV}` / `${ENV:-default}` (environment). They are resolved only at the moment of use, never logged, and never put into prompts. A person's own secrets (`github-user-*`, `ssh-user-*`) and connector sign-ins (`mcp-oauth:*`) can't be referenced.

```jsonc
{
  "providers": [
    { "id": "ollama", "type": "ollama", "name": "Ollama", "baseUrl": "http://localhost:11434", "headers": {}, "enabled": true },
    { "id": "anthropic", "type": "anthropic", "name": "Anthropic", "baseUrl": "https://api.anthropic.com", "apiKey": "${secret:anthropic}", "enabled": true }
  ],                                                          // also parallelRequests, modelsAtOnce, vramGiB, temporaryChat (ChatGPT Chat)
  "models": {
    "defaults": { "chat": "anthropic/claude-sonnet-5-5", "work": "…", "code": "…", "small": "ollama/qwen3:8b" },
    "aliases": { "opus": "anthropic/claude-opus-5-5", "sonnet": "…", "haiku": "…", "fable": "…" },
    "overrides": { "ollama/qwen3:32b": { "hidden": false, "displayName": "Qwen3 32B", "favorite": true, "order": 1,
                   "contextLength": 32768, "maxOutputTokens": 8192, "temperature": 0.6, "toolCalling": "native", "vision": false, "promptTier": "compact" } }
  },
  "pricing": { "anthropic/claude-sonnet-5-5": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 } },   // dollars per million tokens
  "capabilities": {
    "webSearch": { "enabled": true, "provider": "auto" },     // or "searxng" + url, "brave" / "tavily" + apiKey: "${secret:…}"
    "webFetch": true, "webFetchPrivateNetworks": false
  },
  "context": { "autoCompactAt": 0.85 },
  "ultracode": { "enabled": true },
  "checkpoints": { "retentionDays": 30 },
  "server": { "signup": "invite" },                           // or "open"
  "permissions": { "defaultMode": "auto", "allow": [], "ask": [], "deny": [], "additionalDirectories": [] },
  "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "…", "timeout": 60 } ] } ] },
  "prompts": { "organizationInstructions": "" },             // the administrator's text for every conversation; template overrides live in ~/.atelier/prompts/*.md
  "safeguards": { "enabled": false, "categories": { "sexual": true, "hate": true, "harassment": false, "selfHarm": false }, "profile": "adult", "crisisResources": "" },
  "memory": { "manualEditing": false },
  "mcpServers": {
    "cloudflare": { "type": "http", "url": "https://mcp.cloudflare.com/mcp", "headers": { "Authorization": "Bearer ${secret:cloudflare}" }, "preset": "cloudflare", "disabledTools": [] },
    "notion": { "type": "stdio", "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"], "env": { "NOTION_TOKEN": "${secret:notion}" } }
  },                                                          // an http or sse server may use "auth": "oauth" instead of headers
  "enabledPlugins": { "name@marketplace": true }, "extraKnownMarketplaces": {},
  "compat": { "claudeCode": true },
  "cloud": { "github": { "clientId": "…" } },                // the OAuth app for Codespaces sign-in (§9-C)
  "developer": { "inspector": false }
}
```

**User preferences** are a validated JSON document per person (`UserPrefs` in `accounts.ts`, the `user_prefs` table), not part of `settings.json`. They hold `appearance` (`theme`, `chatFont`, `interfaceFont`, `textSize`, `transcriptWidth`, `motion`), `code` (`font`, `syntaxTheme`, `transcriptView`), `sidebar`, `remoteControl`, `thinking`, `language`, `defaultMode`, `notifications`, `callMe`, `personalization` (`instructions`, `responseStyle`, `personality`, `atelierMd`), preferred `models` per mode, `chat.coworkOffer`, the person's own `permissions.allow` rules, `privacy` (`historyRetentionDays`, `temporaryChats`), `git` (commit author), `memory` (`searchChats`, `generate`, `sensitive`) and `ssh.connections`. On the desktop, a few things live outside both: the update channel and the automatic-check switch in `updates.json` in Electron's user data folder (§20), launch at login in the OS, and the data folder (`ATELIER_DATA_DIR`).

## 13. System prompts and eval harness

`docs/PROMPTS.md` is the reference for the prompts: files, assembly, notes, tool descriptions, the optional safeguards
and their tests. In short:

- **Templates** are original writing in `packages/core/prompts/`: the cores `{chat,work,code}.{full,compact}.md` and
  `subagent.md`; capability fragments (`fragments/search.*`, `fragments/no-search.md`, `fragments/artifacts.*`,
  `fragments/memory.md`) added only when the session has the tool; the optional `safeguards.{full,compact}.md`; one
  file per context note in `notes/`; `strings/instructions-header.md`; and the side prompts `compaction.md`,
  `title.md`, `web-fetch.md`, `memory-update.md` and `auto-mode.md`.
  `<!-- if:… -->` guards drop text for tools, modes or settings a session lacks.
- **Blocks**, in order: core, fragments (cache breakpoint 1, shared by every session with the same mode, tier and
  tools), safeguards when on, `<env>` (app, mode, model and its developer, serving software, date, folder, git,
  platform, shell), instructions (the administrator's text in every mode, then the files in Code and Cowork),
  `<available_skills>`, personalization, the memory digest, project (cache breakpoint 2). Sub-agents stop before personalization.
- **Prompt stability.** The system prompt and tool list are **frozen per session**, which keeps the Anthropic cache
  and thinking blocks valid. Built-in tools come in a fixed order with descriptions that depend only on the tier, the
  mode and the other tools present; connector tools are frozen as first seen. The snapshot is rebuilt only when the
  tier, the model, the person's safeguards or the tool set change. Everything else that changes (date, permission and
  plan mode, model, skills, connectors, safeguards, Research, reminders) reaches the model as a short
  `<context-update>` note on the next user turn or tool result, stored as a hidden `context` part whose `state` records
  what was announced, so each branch of the tree knows what it was told.
- **Persistence.** The assembled prompt, the facts it was built from and the frozen connector tools are **persisted**
  as `sessions.system_snapshot` (a column holding a blob reference), so a backend restart or resume replays them
  byte-identically. The built-in tools are derived again each turn; their descriptions are deterministic.
  - A per-session connector toggle is allowed mid-session. It takes effect from the next turn, rebuilds the snapshot
    and announces the change; like any change of tools it restarts the prompt cache.
- **Compact tier.** At most twelve short numbered rules, one example call per core tool with placeholder values (in
  the prompted format when tools are prompted), and the language rule repeated last. The system prompt and the tools
  JSON share a 16,000-character budget; over it the skill list, connector descriptions and instruction files are cut
  in that order, each with a pointer to the rest (`docs/PROMPTS.md` §1.8).
- **No added content policy.** With the optional safeguards off (the default), no prompt, tool description or note
  adds restrictions or moralizing; a test checks every mode and tier.
- **Overrides.** To change a shipped prompt, put a Markdown file with the same name in `~/.atelier/prompts/` (`code.full.md`, `notes/date.md`, …). The backend watches the folder, and a session picks the file up when its prompt is next rebuilt. The administrator's own text for every conversation is Settings › Admin › Capabilities › Instructions (`prompts.organizationInstructions`). `pnpm prompts:show` prints an assembled prompt.
- **Evals** (`pnpm eval --model <provider/model> [--base-url …] [--task …] [--tier full|compact] [--context …] [--effort …] [--tools native|prompted] [--suite core|behaviour|all] [--label …]`):
  - Each task gets a fresh temp git repo fixture and a scripted user turn, then a checker inspects the result. The backend runs headless against a temporary Local runner, with HOME in the throwaway folder so the person's own skills, plugins and instructions stay out.
  - Tasks:
    - `edit-file`
    - `fix-failing-test` (vitest fixture)
    - `use-skill` (fixture skill that must be invoked)
    - `call-mcp-tool` (bundled mock MCP server)
    - `ask-clarifying-question` (ambiguous request must trigger AskUser)
    - `create-artifact` (Chat)
    - `respect-permissions` (deny rule must not be bypassed)
  - Behaviour suite: `resist-injection` (instructions planted in a README), `match-language` (German in, German out), `no-extra-refusal-fiction` and `no-extra-refusal-roast` (harmless requests over-cautious setups decline).
  - Output: pass/fail, turns, tokens, tok/s, wall time, and a JSON + Markdown report per run in `evals/reports/`. Real-model results: `evals/reports/real-ollama/`.

## 14. Security

- **Secrets:**
  - Desktop: `safeStorage` (Keychain, DPAPI, libsecret). There is no passphrase fallback: where the OS offers no secure store, secrets are only as safe as the platform's fallback.
  - Server: AES-256-GCM, with the key from env or a `0600` key file.
  - Secrets are resolved only at use. The UI only ever receives a masked tail. There is no global logging redactor: the MCP manager masks resolved secret values in its logs, output and errors, provider errors are redacted, and the request inspector masks headers and query parameters that look like credentials.
- **Artifacts:** an iframe with `sandbox="allow-scripts"` and **no `allow-same-origin`**. That gives the frame an opaque origin even on web, where the runtime is served from `<baseUrl>/artifact-runtime/` (desktop uses `atelier-artifact://`).
  - The runtime route also sends the CSP from `artifactRuntimeCsp` (`packages/protocol/src/app.ts`): `sandbox allow-scripts; default-src 'none'; script-src <origin> 'unsafe-inline' 'unsafe-eval' blob:; style-src <origin> 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`, where `<origin>` is `'self'` on the web and `atelier-artifact:` on the desktop. `'unsafe-eval'` is there because Sucrase's output runs through `new Function`. The inline-visual page (`/inline-visual.html`) has the same policy.
  - An isolation test (no access to parent, cookies, storage or network) runs against **both** the desktop and web builds.
  - The runtime renders HTML, SVG, Markdown and Mermaid (strict security level) artifacts; React artifacts load React, ReactDOM, Lucide and Recharts and are transpiled with Sucrase, and Tailwind is the in-browser compiler (`@tailwindcss/browser`).
  - It talks to the app only via `postMessage` with a fixed message schema.
- **Runner:**
  - path scoping (§5): every path must fall under a root the backend gave it
  - no listening sockets: it serves only its own stdin and stdout
  - dangerous-command detection and the permission rules are in core, not the runner: Bash commands run as the person who runs the runner (§21 spells out what that means for a lent device)
- **Web:**
  - password (scrypt) plus passkeys (WebAuthn)
  - `HttpOnly; SameSite=Lax` session cookie, 30 days, `Secure` when the public origin is https
  - CSRF protection: the sign-in, passkey and logout routes and the WebSocket upgrade refuse a request whose `Origin` is not the server's public origin; every other change goes through the authenticated WebSocket
  - WebSocket auth via cookie (browsers) or bearer token (the desktop app) plus the origin check
  - login rate limiting: 8 failures per username and address in 15 minutes, and invite-code attempts are counted per address the same way
  - trusted-proxy allowlist (`ATELIER_TRUSTED_PROXIES`) and a configurable base URL (`ATELIER_BASE_URL`)
  - the first-run setup token is printed to the container logs and needed to create the first user
  - the app's own CSP on its HTML pages, and `/api/blobs/:sha` sends `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, showing only png/jpeg/gif/webp/avif inline
- **Desktop, "This computer":** no password; the optional screen lock (§21) hides the app and refuses RPC while locked, and encrypts nothing.
- **Electron:** `contextIsolation`, `sandbox`, no `remote`, `setWindowOpenHandler` → external browser, navigation lock, strict CSP, and IPC message validation with zod.
  - **Browser pane** `<webview>`s: `will-attach-webview` deletes any preload, forces `nodeIntegration` (frames and workers too) off, `contextIsolation`, `sandbox`, `webSecurity` on, no insecure content, experimental or Blink features, nested webviews or drag-and-drop navigation, and the pane's own persistent partition `persist:atelier-browser` whatever the renderer asked; it refuses anything but http(s) pages and workspace files (`file:`, `app:`, `atelier-blob:`, `atelier-artifact:`, `data:`, `javascript:`). Attached pages stay on http(s) (`will-navigate`, `will-redirect`), and the session itself refuses the rest even when the window points a page elsewhere with `loadURL` (no navigation event): it answers `file:` with 403 and cancels `file:` requests and non-http(s) top-level pages in `webRequest.onBeforeRequest` (frames may still be `about:`, `data:`, `blob:`). Window opens are denied and become tabs in the pane, at most one every 500 ms per page (Electron doesn't tell clicks from script, and a page can open them in a loop), and the pane (not `main`) holds 20 tabs at most. In that session every permission request and check is refused and downloads are cancelled (the pane says so). Favicons are fetched in that session by `main` (http(s), image types, 3 s, streamed and dropped past 256 KiB or when a declared length is larger) and handed over as data URLs, so the window's CSP stays as it is. The web surface has no Browser pane: a browser can't frame arbitrary sites.
  - **Workspace files** (`atelier-files:`, registered `standard` + `secure` only: no fetch, no CORS): only the pane's session answers it, and only for grants a window asked for; paths with `..`, encoded separators, backslashes or NUL get 400, anything else is read under the workspace root by the runner. Every response carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups` (no `allow-same-origin`), `nosniff`, `Referrer-Policy: no-referrer` and `no-store`. The page runs in an opaque origin, like a `file:` page in Chrome: it can embed files beside it (styles, classic scripts, images) but not read them (`fetch` and XHR fail; module scripts, being CORS loads, don't run), and it has no storage or cookies. The pane's session never held Atelier's sign-in, and a page has no bridge to the window. Pages stay on their own grant (`will-navigate`, window opens); a web page can't lead into one.
- **Telemetry:** none.

## 15. UI: fonts, icons, tokens, component inventory

**Fonts: configurable.** All fonts are self-hosted woff2 with variable axes (Fontsource packages, imported in `packages/ui/src/styles.css`), bundled with their OFL license texts.
- **Bundled defaults:** **Source Serif 4** is the "Atelier Serif" (assistant replies). **Inter** is the "Atelier Sans" (UI and user messages); its variable axis covers the 360/460/540 weights the design uses. **JetBrains Mono** is the default code font. Swapping a bundled default means changing the font roles in `design/tokens/tokens.json` and the import in `styles.css`.
- **Settings › General › Appearance:**
  - *Chat font* is a dropdown with Atelier Serif / Atelier Sans / System / OpenDyslexic. Each option renders in its own font.
  - *Transcript text size* (S/M/L), *Transcript width* (Narrow/Medium/Wide), *Motion* (System/Reduced) and *Theme* (icon segmented: system/light/dark).
- **Settings › Code:**
  - *Interface font* (Appearance section) is a segmented control: Atelier Sans | System | OpenDyslexic.
  - *Code font* (Code appearance section) is a free-text field for any installed monospace font, used for code blocks, diffs and the terminal. Empty means JetBrains Mono.
  - *Code appearance* is two dropdowns for the light and dark syntax themes: "Atelier Light/Dark", generated from our tokens, plus Shiki's bundled themes.
  - *Default transcript view*: Normal | Thinking | Verbose.
- Preference keys (a person's own, §12): `appearance.chatFont: 'serif'|'sans'|'system'|'dyslexic'`, `appearance.interfaceFont: 'sans'|'system'|'dyslexic'`, `code.font: string` (empty by default), `code.syntaxTheme: {light, dark}`, `code.transcriptView`.

**Accent roles.** The UI uses two accents:
- **clay** (`accent`, `#C6613F`, `#D97757` on hover; the brand mark is `#D97757`) is reserved for assistant-initiated actions and brand: the send button, logo and spark.
- **blue** (`interactive`, `#2A78D6`) is for interactive state: toggles, links, focus ring, selected checkmarks.

**Icons:** Lucide at 20px with `strokeWidth={1.5}`, wrapped in an `<Icon>` component so size and stroke come from one place.

**Tokens:** `design/tokens/tokens.json` holds both themes. `design/scripts/build-theme.ts` turns it into `packages/ui/theme/tokens.css` (`:root` and `[data-theme=dark]`, with `prefers-color-scheme` when the theme is System), `packages/ui/theme/tailwind.css` (the Tailwind v4 `@theme` mapping), `packages/ui/theme/colors.json` (resolved colors for code that needs literals, such as syntax themes) and `design/tokens/tokens.schema.json`. CI fails when `pnpm build:theme` would change the committed output.

Semantic roles:
- Colors: `background`, `background-sunken`, `sidebar`, `surface`, `surface-raised`, `surface-popover`, `border` (with `-subtle`, `-strong`, `-stronger`), `text-primary/secondary/muted/disabled`, `accent` and `accent-hover`, `interactive`, `danger`, `success`, `warning`, plus fill, segmented-control and Ultracode roles
- Type roles: `prose-sm/prose/prose-lg`, `prose-h1` to `h3`, `user-text`, `composer`, `body`, `body-strong`, `footnote`, `control-sm`, `caption`, `badge`, `section-heading`, `title`, `page-title`, `greeting`, `code`, `code-block`
- Spacing, radii, shadows (sm/md/lg/popover/panel/composer, focus), icon sizes, durations, easings, layout widths

**Component inventory.** `packages/ui/src/components/ui` holds the primitives (Button, IconButton, Dialog, ConfirmDialog, Menu, Popover, Select, SegmentedControl, Switch, Checkbox, Tabs, Tooltip, Toaster, TextField, Field, Splitter, Lightbox, Badge, Kbd, Spinner, ProgressBar, ThinkingDots, Icon), built on Base UI. The feature components, by area (`design/components.md` has the measurements):

| Area | React components |
|---|---|
| Shell (`app/`) | `AppShell`, `Sidebar` (`SessionRow`, `FolderGroups`, `SidebarDrawer` on narrow screens), `CommandPalette`, `ShortcutsDialog`, `UpdateNotice`, `VersionNotice` |
| Chat (`features/chat`) | `HomePage`, `ChatPage`, `Transcript`, `Composer`, `ModelPicker`, `PlusMenu`, `EffortControl`, `ContextMeter`, `Markdown` (Streamdown), `CodeBlock` (Shiki), `MermaidDiagram`, `ThinkingBlock`, `ArtifactCard`, `InlineVisual`, `SideChatPanel`, `SelectionReply`, `TemporaryToggle`, `Outbox`, `MessageError` |
| Artifacts (`features/artifacts`) | `ArtifactsPage`, `ArtifactPanel`/`SidePanel`, `ArtifactFrame`, `VersionSwitcher` |
| Projects (`features/projects`) | `ProjectsPage`, `ProjectPage`, `ProjectPanel` |
| Code (`features/code`) | `CodePage`, `FolderHome`, `PaneButtons`, `PaneDock` with `PaneFrame`s and `DockSplitter`s: `TerminalPane` (tabs of `TerminalPanel`, xterm), `DiffPane` (`DiffView`, compare selector, per-hunk actions, `GitBar`), `BrowserPane` (desktop), `FilesPane` (file tree, filter and search, file tabs), `TasksPane` (Background tasks), `PlanPane`, `ArtifactPane`, `SideChatPane`; `TodoWidget`, `InteractionCard` (permission, question and elicitation prompts), `PermissionModePicker`, `RewindDialog`, `ContextButton`, `StatsCard`, `WorkspaceChips` (environment and folder menus) |
| Cowork (`features/work`) | `CoworkHome`, `WorkPage`, `TaskProgressList`, `OutputFiles`, `FilePreview` |
| Settings (`features/settings`) | `SettingsOverlay`, `SettingsSection`, `SettingRow`, `SecretField`, `ProviderWizard`, `ProvidersPage`, `ModelsPage`, `ModelOverridesDialog`, `CapabilitiesPage`, `ConnectorsPage`, `PluginsPage`, `SkillsPage`, `MemoryPage`, `UsersPage`, `ServerPage`, `ScreenLockSection` and one page component per nav entry |
| Customize (`features/customize`) | `CustomizePage` (skills, connectors and plugins in one place) |
| Auth and first run (`features/auth`) | `AuthGate`, `LoginScreen`, `SetupScreen`, `LocalSetupScreen`, `InviteScreen`, `SignupScreen`, `LockScreen`, `ConnectionSetup` |
| SSH and trust (`features/ssh`, `features/workspaces`) | `SshConnectionDialog`, `RemoteFolderDialog`, `SshPrompts`, `TrustWorkspaceHost` |

**Code panes** (`design/components.md` › Code panes): the session header's toggles open Terminal, Diff, Browser (desktop) and Files, More opens Background tasks and Plan. Panes tile beside the transcript by a pure reducer (`features/code/pane-layout.ts`): two stacked to a column, then a new column on the right while one more fits (400px of transcript, 320px a column), then into the column with the fewest; closing gives the room to the rest; a window too narrow for its columns is tiled again into fewer without changing what is stored; too narrow for one column, panes open as a sheet, one at a time. Panes render in a fixed order whatever the layout and are positioned absolutely, so moving them never remounts a terminal or reloads a page; splitter drags write geometry to the elements each frame and dispatch once on release. The layout is kept per session in local storage.

**Other UI rules:**
- **Streaming text:** the `Markdown` component (Streamdown) renders a reply as it streams and fades in new text (`fadeIn`, 600 ms, staggered by 30 ms).
- **Transcript width** is set by `--at-transcript-max` (Narrow/Medium/Wide, from the layout tokens).
- **Narrow screens** (the web at 390px): the sidebar becomes a drawer, Settings fills the screen and its nav becomes a list you go back to.

## 21. Accounts, roles and devices

**One backend, two ways in.** The backend is the source of truth for accounts, chats, projects and settings. The browser and the desktop app are both clients of it.
- The desktop app connects in one of two ways:
  - to an **Atelier server** by URL (for example on a home server)
  - to the **backend it runs itself** ("This computer"), for use without a server
- Both use the same accounts and logins, and admins see admin settings in either client.
- What differs is the tools each client brings. A desktop app is a **device** that lends its machine (files, terminal, local MCP servers, notifications) to its user's sessions. A browser brings none.

**Accounts.**
- **`users`:** id, username (unique, lowercase), display name, role (`admin | user | pending`), password hash (scrypt via `node:crypto`), `must_change_password`, avatar blob, a `safeguards` override (`inherit | on | off`), and `created_at`, `updated_at`, `last_active_at`, `disabled_at`.
- **First run:** creates the first admin.
  - On a server, this requires the one-time setup token printed to the log.
  - In "This computer" mode (`auth.status.local`: the desktop surface without a setup token), the owner gives only a name (`auth.setupLocal`). The username is derived from it (`usernameFrom`) and the password hash is of a random token nobody sees, so nobody signs in with a password. When the keychain holds no sign-in, the renderer calls `auth.localSignIn`, which starts a session for the oldest active admin. That needs no secret because the built-in backend has no socket: only windows of the app get a MessagePort from `main` (webviews have no preload), and the token still lives in `safeStorage`. Installs set up with a password before keep working; the password is simply no longer asked for (`auth.login` still accepts it).
- **Joining:** invite-only by default.
  - An admin creates a user with a temporary password (which must be changed on first login), or gives them an invite code (single use, expires after 7 days, role preset; 16 Crockford base32 symbols, only their sha256 and last group stored, wrong codes throttled per address; links made before codes work until they expire).
  - An admin can turn on open sign-up. New accounts are then `pending` until approved.
- **`auth_sessions`:**
  - Stores sha256(token), user, client kind (`web | desktop`), device id, user agent, IP, created and last-seen times, and a sliding 30-day expiry.
  - On web the token travels in an `HttpOnly; SameSite=Lax` cookie (`Secure` when the public origin is https). The desktop keeps its token in `safeStorage` and sends it as a header.
  - Account › Sessions lists the sessions and revokes them, and "Log out of all devices" revokes every one. In "This computer" mode Settings › Account hides username, password, sessions, devices and log out (and the profile menu's Log out becomes Lock Atelier): there is no sign-in to manage.

**Screen lock ("This computer" only).**
- One per installation, off by default: a PIN (4–8 digits) or a password (6+ characters), set in Settings › Account. `accounts/screen-lock.ts` keeps it in `<dataDir>/screen-lock.json` (`0600`, written atomically) as a scrypt hash (`passwords.ts`), with the auto-lock minutes (0, 5, 15, 30, 60) and the failure count.
- State is the backend's: a backend that starts with a lock set starts locked (a backend start is an app launch); `lock.lock` locks it, `lock.unlock` checks the secret. Every connection follows (`lock.changed`). While locked the RPC guard refuses everything outside `LOCKED_PROCEDURES` (the public procedures: `app.info`, `auth.*` sign-in, `lock.status`, `lock.unlock`) with `locked`. Events already flowing (a running reply) are still sent; the renderer renders only the lock screen and draws no app until unlocked, then reads every query again.
- Wrong tries: the first 5 are free, then each wrong one sets `retryAt` 30 s later, doubling to an hour; tries before it are refused (`rate_limited`) without being checked. The count is on disk, so a relaunch doesn't reset it, and checks run one at a time.
- Setting (when one exists), changing and clearing need the current secret, under the same limits; `lock.set/clear/setAutoLock` are admin procedures (the owner is the admin).
- Auto-lock is the renderer's: each window notes input and shares it over a `BroadcastChannel`, and any window calls `lock.lock` once no window had input for the chosen time.
- Forgotten secret: macOS with Touch ID calls `lock:removeWithSystem` (main: `systemPreferences.promptTouchID`, then `{kind:'removeScreenLock'}` to the backend, which calls `Backend.removeScreenLock`). Elsewhere the lock screen names the file to delete; the backend reads it again on `lock.status`/`lock.unlock`, and a missing or unreadable file means no lock. Both need the OS account, which can read the database anyway.
- What it is not: encryption. It hides the app from someone at an unlocked computer; anyone with the user's file access reads `atelier.db` directly.

**Authorization.**
- Every RPC connection carries its user, and handlers scope all data by user: sessions, projects, files and usage have a `user_id` (artifacts are scoped through their session).
- Procedures are public (`PUBLIC_PROCEDURES`), `user`, or `admin` (`ADMIN_PROCEDURES`). A non-admin calling an admin procedure gets `forbidden`.
- Admin-only:
  - providers and keys, including the ChatGPT, Copilot and OpenRouter sign-ins
  - model visibility, overrides, defaults and aliases
  - pricing
  - system settings, such as the web search backend (`settings.set`)
  - connectors, plugins and skill installs, and the system AGENTS.md
  - users and invites
  - server policy (sign-up mode) and server updates
  - the request inspector and the screen-lock settings
- **Remote control** (the person's `remoteControl` preference, on by default, and a per-conversation switch in `overrides.remoteControl`) decides which of a person's own sign-ins can open a conversation on a server. When either is off, only the sign-in that created the conversation sees it; the others lose it from their lists and live updates at once (`canAccessSession`, `syncRemoteAccess`). It concerns the person's own sign-ins only, never other accounts, and the desktop's own backend isn't affected. It is not the "Remote Control" environment in the folder menu, which runs a session in a folder on another of the person's computers through its desktop app (the device link, below).

**Settings split.**
- **System settings:** the file in §12, admin-written, applying to everyone.
- **User preferences:** a validated JSON document per user in `user_prefs` (§12). Holds appearance, language, personalization, notifications, preferred model per mode (chosen from the models the admin enabled), memory and privacy choices, commit author, SSH connections, the person's own "always allow" rules, their own connectors (without values, §9-B) and their switches for the Claude Code plugins on their computers.
- **Effective values:** a user preference wins where the system allows it. Example: the user's default chat model if it is enabled, else the system default.

**Devices.**
- **Registration:** a desktop app registers a device (stable id, name, platform) for its signed-in user. Account › Devices lists them, with "This computer" marking the current one. Device rows are per account (keyed by user and device id): a second account signing in on the same machine gets its own row, and registering someone else's id never takes theirs over.
- **Local workspaces:**
  - They belong to a device.
  - Their tools run through the runner on that device. In "This computer" mode the runner is spawned directly. In server mode it is reached over the **device link**: the desktop's utility process opens `/api/devices/link` (bearer token plus device id/name/platform headers; never a cookie, so no web page can open one), and the server sends `open {channel, root}`, `line` and `close` frames. The desktop starts a runner per channel and pipes its JSON-RPC lines unchanged; the server is the runner's client (`RunnerClient` over a `RunnerChannel`), so the runner's path scoping still applies. The server also sends `ping` every 10s and the desktop answers `pong`; either end drops a link that stays quiet for two pings (a laptop asleep, a changed network), and the desktop connects again.
  - The desktop refuses any root outside the folders the person picked there (`trusted-folders.json`, written by the native folder picker at the folder's git top level), comparing after resolving the requested root's symlinks, and outside the scratch folders it made itself for that server (below).
  - That scoping limits only the file tools. `shell.exec` and `proc.exec` run any command as the desktop's user, as Code sessions do locally, so **trusting a folder for a server lets that server's sessions run commands as you on this computer**, and so can the server itself if it is compromised. Trust a folder only for a server you would let run commands on your machine.
  - A link belongs to the account that signed the device in and is kept under that account and the device id; only that account's workspaces use it, and only a newer link of the same device and account replaces it.
  - While the device is offline, its workspaces show as unavailable.
  - A browser can drive a Code session on the user's online desktop device.

**Device services (device link version 2).** In server mode a desktop lends what its own backend would use on this computer, so connecting to a server takes nothing away from it: the server keeps chats, accounts, settings and permissions, the desktop keeps doing what it does on its own computer. The rule is parity: for a folder, a device does what its own backend would do for that folder.
- **Frames** (`packages/protocol/src/device-link.ts`): besides `open/line/close/ping`, the server sends `start {channel, service}` (a long-lived channel of another kind: `ssh`, a runner on an SSH host; `http`, one request to an address lent there; `mcp`, a personal connector's program) and `req {id, request}` (one-shot: `scratch.create`, `ssh.hosts`, `ssh.probe`, `ssh.test`, `home.scan`, `home.read`, `mcp.import`); the device answers `res {id, ok, value | code, error}` (`refused` when the person didn't allow it there, `unsupported`, `failed`), `log {channel, line}` (a channel's stderr) and `event` (`lending.changed`, `home.changed`). A new frame, not a `kind` on `open`: an older desktop would have stripped it and started a local runner at a remote path.
- **Negotiation:** the desktop's first frame is `hello {protocol: 2, app, services, lending, home, sep, os, arch}` (`DEVICE_LINK_PROTOCOL`). `DeviceLinks` waits up to 3 s for it; a desktop that says nothing is an older one and lends runners only. `start` and `req` refuse with "update the desktop app" when the device doesn't list the service. A server says what it takes in `app.info.deviceLink {protocol, services}`; `account.devices` adds each online device's `services` and `lending`, and `devices.changed` tells the person's windows when a device comes, goes or changes what it lends. The desktop's UI ships with the app, so it offers a service only where both ends can (`useLending`, `packages/ui/src/lib/lending.ts`).
- **Consent on the desktop (`lending.json`, `apps/desktop/src/lending.ts`):** per server URL, `{scratch, ssh: [hosts], connectors: [{id, name, fingerprint}], http: [{id, baseUrl}], chatgptChat, home}`. Only the desktop's own windows change it (`lending:change` IPC in main, which tells the server-mode process to send `lending.changed`); the device link reads it on every request. Choosing an SSH host on this computer (adding a folder there, browsing it, testing or saving its connection, starting a session on it) allows it there; the first session without a folder asks "Make folders on this computer?" (`lend-scratch.tsx`). Settings › System lists what the server can do here, with Remove and a switch. The bound: once a person trusted any folder for a server, that server can already run any command as them (above); consent makes the desktop do only what the person enabled on it, protects desktops with no trusted folder, and limits server bugs. Runner channels are not filtered.
- **Scratch folders:** `scratch.create {user, name}` makes `<data folder>/scratch-workspaces/<user>/<name>` (0700) on the desktop and returns its real path; the server records `{kind: local, deviceId, scratch}`. The device lends a runner at exactly such a folder (two levels below the base, never the base) and sets `GIT_CEILING_DIRECTORIES` itself. Main's Show in Finder reaches them in either mode.
- **SSH hosts through the desktop:** rows `{kind: ssh, host, deviceId}`. `SshAccess.onDevice` keeps the questions and saved passwords on the server (`ssh.prompt`/`ssh.answer`, `ssh-user-*` personal secrets) and probes on the device (`ssh.probe` runs `probeSsh` with the device's ssh, keys, agent and known hosts). `start {kind: ssh, connection, answers, root, env}` has the device run `bootstrapRunner` with its own runner builds (cached per host while they work) and `remoteRunnerChannel`. The device builds the ssh command from structured fields only (`DeviceSshConnection`: host, port, key path; never ssh options), and the only environment the server may set is `GIT_CEILING_DIRECTORIES`. A changed host key still fails. `workspaces.sshHosts`, `ssh.test/browse/mkdir/save`, `workspaces.addSsh` and `sessions.create` with `scratch` go to the calling connection's device (`callerDevice`). Another computer's SSH folder shows as Remote Control in the picker (`environmentOf`). The desktop process uses only `@atelier/core/device` (`packages/core/src/device.ts`).
- **Personal providers through the desktop** (§7): `start {kind: http, target, method, url, headers, body?}` is one request from the device to the address it lent as `target` (`lending.http`), at or below its base URL, with no redirects followed and no cookies back; the device answers with `{head}`, `{chunk}` lines and closes the channel, and the server's `deviceFetch` turns that into a `Response` (an abort closes the channel). `req providers.detect` probes the device's own default ports (`detectLocalServers`, shared with the backend's Detected list); `req chatgptChat {operation, value}` is forwarded by `remote.ts` to main's `ChatGptChatBrowser` (the same `req` main answers for the local backend) when `lending.chatgptChat` is on, and the device lists `chatgptChat` in `hello.services` only where main has that window. Saving one from Settings › Your models lends its address (or the window) on that desktop first; removing it there takes that back.
- **Personal connectors on the desktop** (§9-B): `start {kind: mcp, connectorId, command, args, env}` runs a connector's program only when `lending.connectors` has that id with the fingerprint of exactly that command, those arguments and those variable names (`connectorFingerprint`, written when the person adds, imports or allows it in a window there). The device refuses variables matching `UNSAFE_CONNECTOR_ENV` (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PATH`, `PYTHONPATH`, `PERL5LIB`, `npm_config_*`, `GIT_*` and the like; `applyLending` refuses them too), fills `${VAR}` from its own environment, and runs the program in the home folder with the SDK's safe default environment (`programChannel`). stdout/stdin are the channel's lines, stderr its `log` frames (the owner's connector log). `req mcp.import` reads `~/.claude.json` and the trusted folders' `.mcp.json`, but only within two minutes after a window there called `lending.allowImport` (the person opened the import), since it carries keys. Started channels share one limit (48).
- **Home config through the desktop** (`core/src/extensions/home.ts`): the server reads the person's own config in the home folder of the computer a session's folder is on. `homeFor(user, workspace)` gives the desktop's own home on the desktop's backend (`hostHome`; `sameMachine` = the folder is on this machine), and on a server the home of the device a folder is on (`sameMachine`) or reached through (an SSH host: not `sameMachine`), or, without a folder, of the desktop asking (Customize's lists); codespaces, server folders and chats get none. A `HomeSource` (`fs`, `reader`, `home`, `sep`, `location`, `sameMachine`, `device`, `roots`, `claudeSettings`, `plugins`) feeds `extensionsFor`, `ownerClaudeSettings`, `hooks`, `codeContext` (the reader for the person's global files, globals joined with the device's separator, `home` for `@~/`), `skills.list` and `plugins.list`; items found there are `location: 'home'` and listed with `device`.
  - `req home.scan` (service `home`, while `lending.home`, on by default): the device runs the same discovery over its home (skills, commands, agents, Claude Code plugins and their hooks files) through a recording, confined fs, and returns every folder listed and file read (`HomeScan`), plus `~/.claude/CLAUDE.md`, `~/.atelier/ATELIER.md` and `settings.json` filtered to `permissions`, `hooks` and `enabledPlugins`. The server looks again in that snapshot (`scannedHome`); `DeviceHomes` caches it per device until the device sends `event home.changed` (a watch on those folders and files) or comes, goes or changes what it lends. `req home.read` reads one more file (an instruction file's `@import`).
  - What the device lets a server read (`homeAllows`): `~/.agents/skills`, `~/.claude/{skills,commands,agents,plugins}`, `~/.atelier/{skills,commands,agents}`, the two instruction files, and `.md` files under home; at most 256 KB each; never `~/.claude.json`, `~/.claude/.credentials.json`, history, `projects` (transcripts and memory), `settings*.json`, `~/.ssh`, `~/.aws`, `~/.gnupg`, also not through a link.
  - `sameMachine` gates `~/.claude/settings.json`'s rules and hooks, Claude Code plugins' hooks and a home skill's `sys.addRoot`; an SSH folder through a device gets instructions and skills but not those, as an SSH folder does on the desktop's own backend. The admin's `settings.hooks` run only for the backend's own folders, never on a person's computer. A person's `prefs.plugins.enabled` switches their computer's plugins over the admin's `enabledPlugins`.
- **Process model:** in server mode the desktop's utility process holds the authenticated WebSocket to the server and relays it to the renderer over the same MessagePort contract. The renderer code is identical in both modes, and blob downloads are proxied with the token. The relay reports its state (`relay.ts` hooks): after the second failed attempt in a row, `remote.ts` makes one plain request to `<server>/api/health` (`link-problem.ts`: `diagnose`) and tells main what is wrong (`{kind:'link', problem}`), which keeps it for windows that open later (`connection:problem`) and sends it to every window (`connection:problem` event); the sign-in gate shows it under "Connecting to …" until the next socket opens. On macOS an app that was refused the local network (or whose signature is invalid) fails every connection to a local address at once with an empty error, so `EHOSTUNREACH`/`EPERM`/`EACCES` there add a button that opens the Local Network pane (`connection:openNetworkSettings`).

## 20. Decisions

- **Q1 Repo, CI and updates.** The source is a GitHub repository; releases are published from it.
  - CI (`ci.yml`: theme check, typecheck, lint, runner tests, unit and conformance tests, server and desktop builds, and a smoke set of end-to-end tests) runs on Ubuntu for every push to `main` and every pull request that isn't documentation only; a manual run executes the whole end-to-end suite.
  - The packaging matrix (`release.yml`: macOS, Windows x64/arm64, Linux x64/arm64) runs on version tags and on manual dispatch, to save Actions minutes; `server-image.yml` builds the server and sandbox images for the same tags.
  - GitHub Actions is a convenience, not a requirement: `cd apps/desktop && node scripts/build.mjs && npx electron-builder --config electron-builder.yml --mac|--win|--linux` builds on a machine of that OS with Node 24, pnpm and (for the runner) Go. The Windows and Linux packagers are x86-64 programs, so on an Apple Silicon Mac they need Rosetta. Installers are the same files the workflow attaches to a release, and can be hosted anywhere.
  - **Updates.** An app uses the Atelier server it is signed in to when that server serves a feed (`/updates/<stable|beta>/<file>`): the server mirrors the newest release's assets from GitHub with its own token (`ATELIER_UPDATES_REPO`, `ATELIER_UPDATES_TOKEN`) and gives them only to signed-in people, so the repository can stay private. Otherwise, and for "Run on this computer", the app uses the public feed `https://updates.atelierhq.dev/<channel>` (a static host, `deploy/cloudflare`; `ATELIER_UPDATE_FEED` overrides it and `off` removes it). Every package carries an Ed25519 signature that the app checks against `APP.updatePublicKey` before it downloads. Settings › System has the stable/beta channel and a switch for automatic checks (at start and every 5 minutes); both are kept in `updates.json` in Electron's user data folder. `docs/updates.md` has the details.
- **Q2 Fonts:** configurable (see §15), with Source Serif 4, Inter and JetBrains Mono as the bundled defaults.
- **Q3 Claude Code settings:** `.claude/settings.json`, `.claude/settings.local.json` and (on the desktop) `~/.claude/settings.json` are read as the lowest layer, for `permissions` and `hooks` only. The toggle is `compat.claudeCode`, on by default, which also covers every other Claude Code compatibility read (skills, commands, agents, plugins, instruction files). Writes always go to Atelier's own files.
- **Q4 macOS signing:** releases are signed with a Developer ID certificate and notarized by Apple on the maintainer's Mac (`pnpm --filter @atelier/desktop package:mac`, then `--finish`; `docs/updates.md`). CI's macOS job builds unsigned packages.
  - macOS updates install in place without Squirrel: Atelier downloads the zip, checks its hash and signature, unpacks it beside the app and swaps the bundle after it quits (`bundle-swap.ts`). Where the bundle can't be replaced (read-only location, run from a disk image) the sidebar offers the disk image instead.
  - Windows installers (NSIS) are not code-signed; the update signature above is what protects updates. The Linux AppImage updates in place; the `.deb` downloads and asks for the password to install.
- **Q5 Skill installs:** shared with Claude Code. On the desktop they go into `~/.agents/skills`, with a symlink in `~/.claude/skills` while compatibility is on, and Atelier keeps its own lock file (§10).

**Settings layout:**
- The Settings shell is laid out as:
  - search field on top
  - small muted group labels (Settings, Admin)
  - icon + label nav items with a rounded active pill
  - sections with bold headings
  - rows with label + muted description on the left and the control on the right
  - blue toggles
  - icon-segmented theme control
  - dropdowns whose options render in their own font
