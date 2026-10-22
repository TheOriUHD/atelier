---
title: How it works
description: The architecture of Atelier, from the window to the model and back, for readers who want to know what runs where.
---

This page describes what the code does, for curious users and for people who want to read or change it. It names
the files so you can check each statement. Behavior that comes from a prompt is not repeated here; the prompts are
published under [Prompts](/prompts/).

## The shape

Atelier has one backend and two ways to reach it.

* **Desktop.** An Electron app. The main process handles windows, menus, OS dialogs, secure storage, the custom
  protocols and updates. The backend runs in a separate Electron *utility process*, so a long agent run does not
  freeze the window; if it crashes, the main process restarts it after half a second. The window talks to it over a
  `MessagePort`.
* **Web.** `apps/server` is a [Hono](https://hono.dev) server. It serves the same UI to a browser and speaks to it over
  a WebSocket (`/api/ws`).
* **The same backend in both.** Both call `createBackend(platform)` in `packages/core/src/backend/backend.ts`. The
  `platform` object injects the few things that differ: whether the surface is `desktop` or `web`, the config and data
  folders, how secrets are encrypted, where the runner builds are, and a logger. Everything else is the same code.
* **One typed contract.** The UI and the backend speak JSON-RPC 2.0 over a `MessagePort` or a WebSocket. Procedures
  and events are declared once, with zod schemas, in `packages/protocol/src/rpc/contract.ts`: about 200 procedures
  (`sessions.create`, `chat.send`, ...) and 21 event types (`session.event`, `settings.changed`, ...). A call can be
  cancelled with a `$/cancel` notification.
* **One UI.** `packages/ui` is a React single-page app, built once and loaded by both surfaces, which picks its
  transport at start (`packages/ui/src/lib/platform.ts`).
* **The runner.** Everything that touches a project folder (files, search, shell commands, terminals) goes through
  `atelier-runner`, a small Go program speaking JSON-RPC over stdio. It is started next to the folder: on this
  computer, on an SSH host, in a codespace, or on a desktop that lends its folders to a server.

```text
   Browser (web) ─────── WebSocket /api/ws ───────┐
                                                  ▼
   ┌──────────────── packages/ui (React) ───────────────┐      apps/server (Hono)
   │ routes, stores, components, generated theme        │        sign-in, static UI, blobs,
   └──────────────▲─────────────────────────────────────┘        OAuth callback, update feed
                  │ MessagePort                                            │
   Electron main ─┤  windows, menus, safeStorage,                          │
   (apps/desktop) │  protocols, updater                                    │
                  ▼                                                        ▼
   utility process ─────────────►  createBackend(platform)  ◄──────────────  same function
                                   packages/core
                                   sessions, agent loop, providers, tools,
                                   permissions, hooks, prompts, memory, MCP,
                                   settings, SQLite store, workspaces
                                              │
                    JSON-RPC lines over: stdio · ssh · gh codespace ssh · desktop device link
                                              ▼
                                   runner/ (Go, one process per open folder)
                                   fs · glob · grep · watch · shell · proc · pty · sys
```

### Two desktop modes

The first time you start the desktop app you choose where its backend lives
(`apps/desktop/src/main.ts`, `startBackend`):

* **Run on this computer** forks `backend.mjs`, the utility process above. Your chats, settings and keys live on this
  computer.
* **Connect to a server** forks `remote.mjs` instead. There is no local backend: it relays each window's
  `MessagePort` to the server's `/api/ws` over a WebSocket (`relay.ts`, reconnecting with a backoff from 250 ms up to
  10 s) and keeps a second WebSocket, the *device link*, open so the server can use this computer's runner for folders
  you trusted (`device-link.ts`). See [Accounts](/accounts/) and [Self-hosting](/self-hosting/).

The window itself is sandboxed (`contextIsolation`, `sandbox: true`, no Node) and is served from an `app://` origin
with a strict Content-Security-Policy. Artifacts render from their own `atelier-artifact://` origin; images and files
come from `atelier-blob://<sha256>`.

## Monorepo map

The repository is a pnpm workspace (`pnpm-workspace.yaml`):

| Path | What it is |
|---|---|
| `packages/protocol` | Browser-safe shared definitions: the RPC contract, message and event types, the settings schema, model and effort types, the runner protocol types. No Node APIs. |
| `packages/core` | The Node-only engine: backend, agent loop, providers, tools, permissions, hooks, extensions, MCP, memory, search, prompts, store, workspaces, accounts. Also `prompts/` (the Markdown templates) and `evals/`. |
| `packages/ui` | The React app: `src/app` (shell, router, sidebar), `src/features` (one folder per area), `src/components/ui`, `src/lib` (RPC client, live-session store), `theme/` (generated tokens), `artifact-runtime/` (the sandboxed artifact page). |
| `apps/desktop` | The Electron app: `src/main.ts`, `backend.ts`, `remote.ts`, `relay.ts`, `device-link.ts`, `updater.ts`, `browser.ts`, plus the electron-builder configs and resources. |
| `apps/server` | The web server: `src/server.ts`, `proxy.ts`, `oauth.ts`, `updates.ts`, and the `Dockerfile` (targets for the server, the chat sandbox and the updater). |
| `apps/site` | The public website, static files deployed as a Cloudflare Worker. |
| `apps/docs` | This documentation, an Astro Starlight site. |
| `runner/` | The Go module: `cmd/atelier-runner` and `internal/{fsops,glob,grep,proc,pty,rpc,shell,sys,walk,watch}`. |
| `design/` | Design tokens (`tokens/tokens.json`), the scripts that turn them into the UI theme and icons, and the component notes in `components.md`. |
| `e2e/` | Playwright end-to-end specs for the web and desktop builds, and the scripted fake Ollama server. |
| `deploy/` | The Caddy file and compose file for self-hosting, and the Cloudflare worker for the public update feed. |
| `docs/` | Design notes in Markdown (`ARCHITECTURE.md`, `PROMPTS.md`, `self-hosting.md`, `updates.md`, `user-guide.md`, `ROADMAP.md`). |

The product name, bundle id, config folder name and cookie name all come from one constant, `APP` in
`packages/protocol/src/app.ts`.

## One request's journey

What happens when you press Enter in a Code session, with the function that does each step. Chat and Cowork take the
same path with fewer tools.

1. **The UI calls `chat.send`** with the message parts and the session id. The handler in `backend.ts` checks that the
   session is yours, then calls `ChatService.send` (`packages/core/src/agent/chat-service.ts`).
2. **The message is stored first.** A user message is a node in a tree whose parent is the session's current head, so
   editing or retrying makes a sibling instead of overwriting. It is emitted as a `message` run event. A session has
   one run at a time; a message sent while the agent works goes to a waiting queue (`chat.queue`) and is taken at the
   agent's next step.
3. **The run starts** (`ChatService.run`). The status becomes `running`. For Code and Cowork the `SessionStart` hook
   (in a session's first run) and the `UserPromptSubmit` [hook](/hooks-and-plugins/) run; the second can block the
   message, and both can add context. A leading `/name` is expanded into the skill or command text as a hidden part of
   your message. The model reference (`provider/model`) is resolved to an adapter. An untitled session gets a title in
   the background, from the small model or, when none is set, the session's own.
4. **The prompt is assembled, or reused.** The system prompt and the tool list are *frozen* in a snapshot
   (`sessions.system_snapshot`), so provider prompt caches stay valid. The snapshot is rebuilt only when the model, its
   prompt tier, the safeguards, the memory digest or the set of tools changes (a connector switched on or off counts).
   Every other change (the date, the permission mode, new skills) reaches the model as a short `<context-update>`
   note in front of your next message, and so does a change that caused a rebuild (a new model or connector). See
   [Prompts](/prompts/) and [Context updates](/prompts/context-updates/).
5. **A turn runs** (`runTurn` in `agent/loop.ts`). Before every model request the history is prepared for that model
   and compacted if it would not fit.
6. **The adapter streams the reply.** The provider's wire format becomes one internal stream of events (text,
   thinking, tool call start, delta and end, usage, finish). Each event is applied to the assistant message, which is
   saved every 750 ms while it grows, and emitted to the UI. When the reply is complete its usage is recorded
   (`usage_events`).
7. **Tool calls are checked, then run.** Each call is validated against the tool's JSON schema, then passes the
   [permission engine](#permissions-and-hooks), the `PreToolUse` hooks, and, in Auto mode, the reviewing model, or a
   prompt to you. Read-only tools of one message run in parallel; anything that changes things runs in order.
8. **Results go back.** The tool's output (text, or images as blobs) is escaped so it cannot forge Atelier's own
   tags, passes `PostToolUse` hooks and the nested-instruction check, and is stored as a `tool` message. The loop asks
   the model again.
9. **The turn ends.** A title is written if still missing, background memory work is scheduled where memory applies
   (not after a stopped run), and the status goes back to `idle` (or `error`, or `waiting` if a question is open).
   Your window sees all of it as `session.event` notifications.

## The agent loop and when it stops

`runTurn` repeats "ask the model, run its tool calls, add the results" until one of these happens:

| Condition | What happens |
|---|---|
| The model answers without tool calls | The turn ends normally. A `Stop` hook may send it back to work, at most 3 rounds. |
| You press Stop | The run is aborted, as are sub-agents it left working in the background. Messages still waiting go back to your message box. |
| The reply was cut by the output limit | One automatic carry-on after a note saying so; a half-written tool call never runs. |
| The same call with the same result keeps happening | On the 6th time the result gets a note telling the model to try something else; on the 15th the turn stops with "Stopped: the same action ran 15 times with the same result." Polling tools (`BashOutput`, `TaskStop`, `AskUser`, `TodoWrite`) are not counted. |
| A sub-agent hits its ceiling | 200 model calls (150 on a compact-tier model), or the `maxTurns` of its definition. It returns an error to its parent. |
| The window keeps filling | After 8 automatic summaries in one turn the turn stops with a message to raise the model's context length or send a smaller step. |
| A provider error | Retryable errors (a dropped connection, rate limits, 5xx) are retried up to 10 times, waiting 5, 10, 15, 30, 60, 120, 240, 480, 960 and 1920 seconds. A reply the server could not parse (`model_output_invalid`) is asked again up to twice when nothing had streamed. A usage or billing limit (an exhausted quota, a plan's weekly limit) ends the turn at once with the provider's message. Other errors end the turn with a message. |
| A request is rejected as too long | The history is prepared again with a lower compaction threshold (80% of the smaller of the old threshold and what was sent) and retried once into the same message. |

Your own turns have **no step cap**; only sub-agents, which nobody watches, have a ceiling. After a minute without any
output the status line says so, though the cause is not always known (a stalled GPU gives no error for up to 15
minutes).

## Providers and adapters

An adapter turns the internal request into one provider's API and the provider's stream into the internal event
stream (`packages/core/src/providers`). There are no vendor SDKs: adapters use plain `fetch` (and `node:http` for
plain-HTTP servers on your network, to avoid fetch's header timeouts) plus small SSE and NDJSON parsers.

| Provider type | Adapter | Notes |
|---|---|---|
| Ollama | `ollama.ts` | Native `/api/chat` over NDJSON. Always sends `num_ctx`. Capabilities (tools, vision, thinking) come from `/api/show`. |
| llama.cpp | `llamacpp.ts` | OpenAI-style chat completions plus `/props`; router mode is detected. |
| Anthropic | `anthropic.ts` | Messages API with adaptive thinking, prompt-cache breakpoints, and token counting for exact context numbers. |
| OpenAI | `openai.ts` | The Responses API with `store: false`; encrypted reasoning items are replayed. |
| OpenAI-compatible | `openai-compatible.ts` | Chat completions for LM Studio, OpenRouter, OpenCode Zen and others. OpenRouter and OpenCode Zen are *presets* (`protocol/src/provider-presets.ts`), not types of their own. |
| GitHub Copilot | `copilot.ts` | GitHub's device sign-in, then Copilot's chat or responses endpoints. Unofficial outside GitHub's own clients. |
| ChatGPT Plan | `chatgpt.ts` | The Responses adapter behind the plan's own sign-in. Unofficial. |
| ChatGPT Chat | `chatgpt-chat.ts` | Experimental, desktop only. Drives a ChatGPT page in a browser session the desktop app owns; tool calls are written as text. |

The model list, capabilities and context length of each provider are discovered and cached (`model_cache`), then
merged with your per-model overrides. A model's tool calling is `native`, `prompted` or `none`.

**Prompted tools.** A model without native tool calling gets the tool specs in its prompt and writes
`<tool_call>{"name": ..., "arguments": {...}}</tool_call>`, one call per message. A streaming parser hides the call
text from the transcript, repairs the JSON and checks it against the schema; a call that cannot be understood goes
back to the model as an error result (`prompted-tools.ts`). **Probe tool calling**, in a model's ⋯ menu in the Models
settings, tests a model once and records the result. On Ollama, when the server answers that it cannot compile a
model's tool schemas into a grammar ("failed to parse grammar", "failed to initialize samplers"), the request is sent
again with prompted tools and that model stays on them until the app restarts.

**Sharing one model server.** A local GPU answers a few requests at a time and loads one model. Every request from
every session, sub-agent and account waits in one queue per server (providers with the same address share it):
`providers/scheduler.ts`. The oldest request goes first, with a head start of 15 seconds for the person's own run over
sub-agents and 60 seconds over background work. Without settings, a server on this computer or network is treated as
one request and one model at a time; a hosted API as 16 and unlimited. A waiting run shows "Waiting for the model".

**Images** are fitted to each provider's documented limits before they are sent (`images.ts`, `image-limits.ts`).

## Tools, workspaces and the runner

Built-in tools are defined in `packages/core/src/tools` and `tools/code`. Chat has artifacts, web tools, memory and
(where available) a sandbox with Bash and Read; Cowork and Code add the file tools, `Bash`, `TodoWrite`, `AskUser`,
`Agent`, session messaging and more; Code adds `ExitPlanMode`. Sub-agents get the file tools and `Bash` but cannot ask
you questions or start sub-agents of their own. Each tool's description and parameters are in
[Tools reference](/reference/tools/).

### Where tools run

A session's folder is a *workspace*, and its runner is started wherever the folder lives
(`packages/core/src/workspaces/workspace-manager.ts`):

| Workspace | How the runner is reached |
|---|---|
| A folder on this computer (desktop, "Run on this computer") | The bundled build is spawned with `--stdio --root <folder>`. |
| A folder on a computer lent to a server | The server is the runner's client; the desktop app pipes the lines over the device link. |
| An SSH host (desktop) | The system `ssh` runs the runner there. The first connection uploads the matching build to `~/.atelier/runner/<version>/` over stdin and checks its SHA-256; hosts must be Linux or macOS, x86-64 or ARM64. |
| A codespace | The same, with `gh codespace ssh` as the command. It was not verified against a real account. |
| A chat's sandbox | A folder of its own, on the desktop's machine (confined with `sandbox-exec` on macOS) or a second container on a server, where each account is a Unix user of its own. |

The server never runs commands on its own machine. Six runner builds are bundled (macOS, Linux and Windows, each for
x86-64 and ARM64).

### The runner protocol

The runner (`runner/cmd/atelier-runner/main.go`) speaks JSON-RPC 2.0, one JSON object per line, on stdin and stdout,
and logs to stderr. `initialize` must come first and exchanges the protocol version (a mismatch is error `-32020`).
Methods:

| Group | Methods |
|---|---|
| Session | `initialize`, `shutdown`, `sys.info`, `sys.ping`, `sys.addRoot` |
| Files | `fs.stat`, `fs.read`, `fs.write` (atomic, with an optional expected hash), `fs.list`, `fs.mkdir`, `fs.remove`, `fs.rename`, `fs.readAncestors` |
| Search | `fs.glob`, `fs.grep` (ripgrep-style flags, `.gitignore` aware) |
| Watching | `fs.watch`, `fs.unwatch`, and `fs.changed` notifications |
| Shell | `shell.open`, `shell.exec`, `shell.read`, `shell.kill`, `shell.close` (each command in its own process group) |
| Processes | `proc.exec` (no shell; used for git and hooks) |
| Terminals | `pty.open`, `pty.write`, `pty.resize`, `pty.close` |

Every path must resolve (with symlinks) inside one of the runner's roots, or the call fails with `-32010
PathOutsideWorkspace`. The roots are the folder and the skills cache; an allowed access outside the folder adds a root
with `sys.addRoot`. The one exception is `fs.readAncestors`, which reads only files named `CLAUDE.md`, `AGENTS.md`,
`ATELIER.md`, `CLAUDE.local.md` or `.claude/CLAUDE.md` while walking up to the filesystem root. The backend pings the
runner every 10 seconds and gives up after two missed answers, so calls fail instead of hanging.

`Bash` keeps the working directory between calls, but not exported variables, aliases or `source`; background commands
get an id for `BashOutput` and `KillShell`. Commands time out after 2 minutes by default and 10 at most. Output past
a limit is cut in the middle.

### Connectors

Connectors (MCP servers) are configured by admins and shared by every session on a backend
(`packages/core/src/mcp/manager.ts`). Each enabled tool of a ready server becomes a tool named
`mcp__<server>__<tool>`, so permission rules and hook matchers can name it. HTTP servers use Streamable HTTP, falling
back to the older HTTP+SSE transport; stdio servers are started only by the desktop app's own backend. An HTTP or SSE
server can sign in with OAuth, done once by an admin, with the tokens kept in the encrypted secret store. A tool
result is cut at 100,000 characters. See [Connectors](/connectors/).

## Permissions and hooks

`decide()` in `packages/core/src/permissions/engine.ts` judges every tool call before it runs. In order:

1. **Deny rules** end the call.
2. **Plan mode** refuses anything that changes things.
3. **Ask rules** require a decision.
4. Commands the parser cannot read (command substitution, `eval`, and similar) are "unsure".
5. **Allow rules** approve the call. For a compound Bash line every simple command must be allowed on its own. In Auto
   mode, allow rules for a bare shell, an interpreter or any sub-agent are ignored, because they would let the model run
   anything unreviewed.
6. **The mode decides the rest.** Bypass allows. Read-only tools inside the folder run. Accept edits allows file edits.
   In Auto, edits in the folder are allowed unless they touch places that configure tools or the agent itself
   (`.git`, `.claude`, `.atelier`, shell and tool config files); reads elsewhere on the machine are allowed unless the
   path looks like a credential store; everything else is "unsure", and in Auto a reviewing model decides
   (`permissions/auto-mode.ts`) while deleting outside the folder still asks you. In Ask mode "unsure" means a prompt.

A command that is dangerous in itself (`sudo`, `rm -r` outside the folder, `curl ... | sh`, a force push, a hard
reset, and a few more, listed in `permissions/dangerous.ts`) prompts outside Bypass even when an allow rule matches.
In Auto the reviewing model decides instead.

Then `PreToolUse` hooks run: they can deny, force a prompt, allow, or rewrite the input, but they cannot override a
deny rule, and a hook's "allow" still does not skip the prompt for a dangerous command. Rules use Claude Code's syntax
(`Bash(npm test *)`, `Read(./src/**)`, `mcp__server__tool`); the exact differences are in
[Claude Code compatibility](/claude-code-compatibility/). The user-facing description is in
[Permissions](/permissions/).

Hooks run through the workspace's runner (`proc.exec`), so they run where the folder is. Chat has none.

## Context management

Every request is measured by category (system prompt, skills list, built-in and connector tool schemas, messages)
in `agent/context.ts`. The count is exact up to the newest reply that has a plausible usage report and estimated after
it, with characters per token learned per model (4 until the first report).

* **Threshold.** Compaction starts at `min(autoCompactAt x window, window - reserve)`. `autoCompactAt` defaults to
  0.85 (allowed range 0.5 to 0.98) and the reserve is `min(max output, window / 4, 20,000)` tokens.
* **Compaction** (`agent/compaction.ts`, `compactNow` in the chat service) is checked before *every* model request,
  between tool rounds too. The summary is a node in the message tree (`kind = 'compaction_summary'`); the newest
  messages stay verbatim after it. Nothing is deleted: the history loader starts at the nearest summary, and the UI,
  search, export and Rewind still see everything. The small model summarizes, then the session's own model.
* **Context updates.** `agent/context-notes.ts` decides what to announce and records it in the hidden `context` part
  it adds, so each branch of the tree knows what it was told. Every note is listed on
  [Context updates](/prompts/context-updates/).
* **Compact tier.** Small local models get a shorter prompt and a 16,000-character budget for system prompt plus tool
  definitions; over it the skill list, connector descriptions and instruction files are cut in that order
  (`prompts/budget.ts`).
* **Files outside the prompt.** Instruction files nested below the root join a tool result the first time a file tool
  works in their folder. Instruction files follow `@path` imports up to four levels.

## Storage

All state is in one SQLite database, `atelier.db`, opened with Node's built-in `node:sqlite` (no native module) and
used through Drizzle (`packages/core/src/store`). It runs in WAL mode with foreign keys on, and migrations are
embedded in the build and applied at start.

| Table | Holds |
|---|---|
| `sessions`, `messages` | Conversations as a tree: `parent_id`, `head_message_id`, status, mode, model, permission mode, the frozen `system_snapshot`, pending questions, todos. |
| `messages_fts` | An FTS5 index over titles and message text, used by search and by the model's past-chat search. |
| `blobs`, `files` | Uploads, generated files and large payloads. Blobs are content-addressed: bytes live at `blobs/ab/cd/<sha256>` beside the database. |
| `artifacts`, `artifact_versions` | Chat artifacts and their versions. |
| `checkpoints` | File pre-images taken before the first write in a turn, for Rewind (30 days by default). |
| `workspaces`, `projects`, `session_groups` | Folders, projects and sidebar groups. |
| `memory_entries`, `memory_progress` | Memory and how far the background update has read. |
| `usage_events`, `model_cache` | Per-request token and cost records, and discovered model info. |
| `secrets` | Encrypted API keys and tokens. |
| `users`, `auth_sessions`, `invites`, `passkeys`, `devices`, `user_prefs` | Accounts, sign-ins, invite codes, WebAuthn credentials, registered desktop apps, per-person preferences. |

**Settings** are JSON. The global file is `settings.json` in the config folder (`~/.atelier` on the desktop, the data
folder on a server). The project's `.atelier/settings.json` and `.atelier/settings.local.json` contribute permission
rules and hooks, and so do Claude Code's `.claude/settings.json` and `.claude/settings.local.json` while Claude Code
compatibility is on. Each Settings row writes one JSON path, a bad key does not invalidate the others, and edits made by
hand are picked up by a file watcher. A provider's key and headers, a connector's URL, headers and environment, and
the search key may contain `${secret:id}` or `${ENV}` / `${ENV:-default}`, resolved only at the moment of use.

**Secrets** are encrypted at rest: on the desktop the backend asks the main process, which uses Electron
`safeStorage` (Keychain, DPAPI or libsecret); on a server they use AES-256-GCM with a 32-byte key from
`ATELIER_SECRET_KEY` (64 hex characters or base64) or an auto-created `0600` key file in the data folder. The UI only
ever receives the last four characters. See [Security](/security/) and [Data and files](/data-and-files/).

## Events and streaming

A connection subscribes to a session with `sessions.subscribe`, which returns a **snapshot** and starts the stream:
the persisted messages on the active branch, the message being streamed, any open question, tasks, context numbers and
the current `seq`. After that the server sends `session.event` notifications `{ sessionId, seq, event }` with a
rising `seq`. The client (`packages/ui/src/lib/live-session.ts`) buffers events that arrive early and applies only
those with `seq` above the snapshot's, so a reload or reconnect never shows a gap or a duplicate.

Run events are `message`, `delta`, `part`, `done`, `status`, `context`, `title`, `artifact`, `compacting`, `compacted`,
`queued`, `phase`, `outbox`, `todos`, `tasks`, `tool_output` and `pending`. Streaming text is saved in batches, and a
snapshot taken mid-stream overlays the in-memory parts of the message being written, so it always agrees with the
events already sent.

Because runs live in the backend and not in the window, closing the window or tab does not stop a run. When the
backend starts, any session still marked `running` or `waiting` is marked interrupted; the transcript says "Atelier
restarted and cut off this reply." and **Continue** carries on from what was done. A permission prompt or question that
was open at that moment is dropped, because nobody can answer it any more. While the backend keeps running, an open
prompt or question is kept in the session row, so it is still there after a reload.

## Multi-user

A server has accounts (`packages/core/src/accounts`). The first admin is created with a one-time setup token printed in
the server log. Roles are `admin`, `user` and `pending` (waiting for approval under the open sign-up policy). Passwords
are hashed with scrypt; sign-in tokens are random 256-bit values of which only the SHA-256 is stored, and a sign-in
lasts 30 days from its last use. After 8 failed attempts within 15 minutes for the same username from the same
address, sign-in is rate limited. Browsers hold the token in an `HttpOnly` cookie; the desktop app holds it in secure
storage. Passkeys use WebAuthn (`@simplewebauthn/server`); they are offered in browsers at a hostname, not at an IP
address, and the desktop app signs in with a password. Admin-only procedures are listed in `ADMIN_PROCEDURES`
(`contract.ts`); everything else is scoped to the caller, so someone else's session id reads as missing. "Run on this
computer" has one local owner and no password, with an optional screen lock.

Behind a reverse proxy, `X-Forwarded-*` headers are believed only from addresses in `ATELIER_TRUSTED_PROXIES`
(`apps/server/src/proxy.ts`). See [Accounts](/accounts/) and [Security](/security/).

## Updates

* **Desktop.** The app checks a feed at start and every 5 minutes: the Atelier server it is signed in to
  (`/updates/<channel>`, mirrored from GitHub releases when the server has `ATELIER_UPDATES_REPO` and
  `ATELIER_UPDATES_TOKEN`), or the public feed at `updates.atelierhq.dev`. Each package has a `.sig` file, an Ed25519
  signature the app verifies against a public key built into it before downloading anything (`update-signature.ts`).
  On macOS the app swaps its own bundle after quitting. `ATELIER_UPDATE_FEED=off` turns the public check off, and
  **Settings › System › Check for updates automatically** turns all automatic checks off.
* **Server.** A container cannot replace itself, so **Update server** in **Settings › Admin › Server** asks the
  optional `updater` service from the compose file to pull the images and recreate the containers. Without it, the
  page shows the manual command.

Details: [Updates](/updates/).

## Testing

| Layer | Tool | What it covers |
|---|---|---|
| Unit and integration | Vitest (`pnpm test`) | One project per package (`vitest.config.ts`): about 90 test files in core, about 115 in the UI (happy-dom and Testing Library), plus protocol, desktop and server. |
| Runner | `go test` and `go vet` (`pnpm runner:test`) | The runner's packages, and a conformance suite in core that runs every method against the real built binary. |
| End to end | Playwright (`pnpm e2e`) | Specs in `e2e/` against the built web server and the built Electron app. |
| Model stand-in | `e2e/fake-ollama.mjs` | A scripted Ollama that replies from keywords in the last message, so tests need no GPU. |
| Prompts | Snapshot tests in `packages/core/src/prompts` | The assembled prompts for every mode and tier are snapshots; a test checks that no mode adds content restrictions with the optional safeguards off. |
| Evals | `pnpm eval --model <provider/model>` | Real-model tasks (edit a file, fix a failing test, use a skill, call a connector tool, ask a clarifying question, respect a deny rule, resist planted instructions) on a throwaway backend, with a report per run in `packages/core/evals/reports`. Opt-in; they need a model. |

Continuous integration (`.github/workflows/ci.yml`) builds the theme and fails if it differs from what is committed,
type-checks, lints, runs the runner and Vitest suites, builds the server and desktop apps and runs a smoke set of
end-to-end specs; the whole suite runs on request.

## The design system

The look is data. `design/tokens/tokens.json` holds colors for light and dark, fonts and weights, type sizes, spacing,
radii, shadows, control sizes and motion. `pnpm build:theme` (`design/scripts/build-theme.ts`) turns it
deterministically into `packages/ui/theme/tokens.css` (CSS variables), `tailwind.css` (the Tailwind theme mapping) and
`colors.json`, and CI fails if the committed output is stale. `design/components.md` records measured sizes for the
components. Headless primitives come from Base UI, icons from Lucide, and the bundled fonts are Inter, Source Serif 4,
JetBrains Mono and OpenDyslexic.

## Where to read the code

| Concept | Path |
|---|---|
| RPC contract, errors, cancellation | `packages/protocol/src/rpc/contract.ts`, `jsonrpc.ts` |
| Settings schema and defaults | `packages/protocol/src/settings.ts` |
| Run events, snapshots | `packages/protocol/src/domain.ts` |
| Sessions, runs, hooks, sub-agents | `packages/core/src/agent/chat-service.ts` |
| Context accounting and compaction | `packages/core/src/agent/context.ts`, `compaction.ts`, `context-notes.ts` |
| Loops, background tasks, side chats | `packages/core/src/agent/loops.ts`, `background-tasks.ts`, `side-chat.ts` |
| Provider adapters and registry | `packages/core/src/providers/` |
| Built-in tools | `packages/core/src/tools/`, `tools/code/` |
| Permission rules and engine | `packages/core/src/permissions/rules.ts`, `engine.ts`, `bash.ts`, `auto-mode.ts` |
| Hooks | `packages/core/src/hooks/hooks.ts` |
| Skills, commands, agents, plugins | `packages/core/src/extensions/` |
| Instruction files | `packages/core/src/instructions/instructions.ts` |
| Workspaces, SSH, runner client | `packages/core/src/workspaces/` |
| Prompt assembly and templates | `packages/core/src/prompts/`, `packages/core/prompts/` |
| Memory | `packages/core/src/memory/` |
| Web search | `packages/core/src/search/` |
| Database, blobs, migrations | `packages/core/src/store/` |
| Secrets | `packages/core/src/secrets/secret-store.ts` |
| Accounts, passkeys, screen lock | `packages/core/src/accounts/` |
| Desktop main process | `apps/desktop/src/main.ts`, `backend.ts`, `remote.ts`, `relay.ts` |
| The UI's RPC client and live store | `packages/ui/src/lib/rpc.ts`, `live-session.ts` |
| Settings pages and their labels | `packages/ui/src/features/settings/` |
