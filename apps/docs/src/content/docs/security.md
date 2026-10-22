---
title: Security
description: "What Atelier protects and what it does not: the permission model, Auto mode's limits, sandboxes, the web server's defenses, secrets, updates, and how to report a problem."
---

This page says what each part of Atelier does to protect your computer, your accounts and your data, and where that
protection stops.

## The short version

- Code and Cowork sessions **run commands as you**, on the machine whose folder they work in. They are not sandboxed. The
  protection is the [permission system](/permissions/), and in the default mode that is partly a language model's judgment.
- A server **never runs commands on its own machine**. A session runs in a desktop's folder you trusted, in a codespace,
  or, for Chat, in a separate sandbox container.
- Secrets (provider keys, tokens) are encrypted at rest and never shown again. Conversations and files are **not**
  encrypted at rest.
- The web server checks every sign-in and live connection against the address people use, keeps sessions in HttpOnly
  cookies, and sends a strict Content-Security-Policy. Put it behind HTTPS.
- Updates are verified against a key built into the app before anything is downloaded.

## What Code and Cowork can do

A Code session or Cowork task can read and write files in its folder and run shell commands there. The commands are
ordinary processes started by the **runner**, a small program (written in Go) that Atelier starts on the machine that has
the folder: your computer, an SSH host, a codespace. The runner:

- speaks to Atelier only over its standard input and output: it opens no network port;
- confines its **file tools** (read, write, search, list) to the folders it was given: the folder you opened, a skills
  cache, and the folders an admin listed under **Settings › Admin › Code › Additional directories**. When a call on a file outside them is allowed, by you or by Auto mode (which lets
  reads outside the folder through), the runner also takes the nearest folder around that file, never the filesystem root,
  your home folder or the folder above it. Paths are made absolute and symlinks are resolved first, so a link inside the
  folder cannot lead out of it. Unless a call you approve reaches it, the rest of `~/.atelier`, including the database, is
  out of reach of file tools;
- starts commands (Bash, terminals, hooks) with **your** privileges. Confinement to a folder applies to the file tools;
  a command can `cd` anywhere, read anything you can read and use the network. That is why running them is a decision
  the permission system makes.

Opening a folder asks **Trust this workspace?** Project files that run code are part of that trust: hooks in
`.atelier/settings.json` or `.claude/settings.json`, and the instruction files the model reads, come from the folder.
A codespace is asked too, and the backend enforces the answer: until you agree, a
folder's hooks, permission rules, instruction files, skills, commands and agents are ignored, whichever client (a browser
included) added it. Codespaces are trusted one at a time.

A desktop app connected to a server lends only the folders you picked in its own folder picker, and the check follows
symlinks. **Trusting a folder for a server lets that server's sessions, and the server itself if it were compromised, run
commands as you on that computer.** Trust folders only for a server you would let do that.

## The permission model

Every tool call is judged in this order, in every mode: **deny rules** (the call is refused), then, in Plan mode,
anything that changes something is refused; **ask rules** (you are asked); **allow rules**; then the mode's default.

Rules are written like Claude Code's (`Bash(npm test *)`, `Edit(/src/**)`, `WebFetch(domain:example.com)`) and come from
**Settings › Admin › Code** (everyone), your own "Always allow" answers, each project's `.atelier/settings.json` and
`.atelier/settings.local.json`, and, with Claude Code compatibility on, the project's `.claude/settings.json` and
`.claude/settings.local.json` and (on the desktop) your own `~/.claude/settings.json`. Deny and ask rules look through wrappers (`sh -c`, `env`, `xargs`, `find -exec`, quoting tricks),
and a compound command such as `a && b` is checked part by part: `Bash(npm test *)` does not approve `npm test && rm -rf ~`.
**Deny and ask rules apply in Bypass permissions mode too.**

What the five modes do with the cases that matter for safety:

| A call that… | Ask permissions | Accept edits | Plan | Auto (default) | Bypass |
|---|---|---|---|---|---|
| reads inside the folder | runs | runs | runs | runs | runs |
| edits inside the folder | asks | runs | refused | runs, but see protected files below | runs |
| runs a command | asks | asks | refused | the reviewer decides | runs |
| runs a **dangerous command** (below) | asks, with a warning, even if an allow rule matches | same | refused | the reviewer decides; deleting outside the folder asks **you** | **runs without asking** |
| reads a file **outside** the folder | asks | asks | asks | **runs**, unless the path looks like a credential (then the reviewer decides) | runs |
| writes outside the folder | asks | asks | refused | the reviewer decides | runs |

Dangerous commands ask in Ask permissions and Accept edits (your answer covers that one call; remembering a rule is not
applied to a dangerous command). In Auto the reviewer, a model, decides; in Bypass nothing asks.

**Dangerous commands** are recognized by pattern: `sudo` and `doas`; `rm -r` or `find -delete` / `-exec rm` outside the
workspace; `git push --force` (also `-f`, `--force-with-lease`, `+ref`); `git reset --hard`; `git clean -f`; `chmod -R 777`;
`dd of=/dev/…`; `shutdown`, `reboot`, `halt`, `poweroff`; `mkfs`; downloads piped into a shell (`curl … | sh`); and a fork
bomb. Constructs the checker cannot read (`eval`, `source` or `.`, command and process substitutions such as `$(…)`, a case
statement or function definition, a command name that comes from a variable, GNU `parallel`, a shell reading commands
from its input) make the line "opaque": allow rules do not apply to it, and it needs approval. This is pattern matching. A command can do the same harm in a
form the patterns do not know; treat the list as a safety net, not a guarantee.

**Protected files.** In Auto mode, edits to files that configure tools or the agent itself go to the reviewer instead of
running: anything under `.git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.claude`,
`.atelier`, and files such as `.gitconfig`, shell startup files (`.bashrc`, `.zshrc`, …), `.envrc`, `.npmrc`, `.mcp.json`
and `.claude.json`.

**Path confinement, and its exception.** File tools stay inside the session's folder and the allowed additional
directories; a call outside them asks, in every mode except two. In **Bypass** they run. In **Auto**, a *read-only* tool
(Read, Glob, Grep, list) outside the folder runs **without review**, unless the path looks like a credential or private data (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, cloud
CLI configs, `.env` files, private keys and certificates, browser and password-manager profiles, keychains, `/etc/shadow`,
`~/.atelier/data`, …). Those go to the reviewer, which is told to allow them only when you asked for exactly that. The
pattern list is also not exhaustive: a secret in a file with an ordinary name is read without review.

## Auto mode

Auto is the default mode. When an action would otherwise ask you, **another model reviews it instead**: the session's own
model, with a fixed prompt (see [Prompts](/prompts/)). It answers `ALLOW`, `ASK` (you decide) or `BLOCK` (the agent is told
why and not to find another way).

- It reads **your messages** (the last 10, 2,000 characters each), the agent's **earlier actions** (the last 30 tool
  calls other than plain lookups such as Read, Glob and Grep, each cut at 400 characters, without their results) and the
  pending call (cut at 8,000). It never sees tool output, file contents, web pages or the agent's own prose, so text in a
  file or page cannot talk to it directly. Every `<` and `&` in what it reads is escaped. It does read the arguments of the
  calls, which the agent wrote, so an instruction the agent copies into a command can reach the reviewer.
- Your messages are its only source of intent. It blocks, unless you asked for exactly that: downloading and running code,
  sending secrets anywhere, force pushes and commands that discard uncommitted work, deleting your own pre-existing work,
  changing system locations, deploys and production changes, changing where pushes go, turning off a guard, and starting
  agents that run without review. It allows ordinary development work.
- With a **hosted model** (Anthropic, OpenAI, ChatGPT Plan or GitHub Copilot) it reads "asked for" broadly: an action your
  request clearly leads to counts. With any other provider (a local server, OpenRouter and other OpenAI-compatible APIs) it
  keeps the stricter reading, because small models judge less reliably.
- After **3 blocks in a row or 20 in a session**, or when the reviewer cannot answer (an error, a timeout, a reply it
  cannot read), you are asked instead. A **ChatGPT Chat** session can't review its own actions (it has one conversation slot), so
  the small model does, and with no other model the action asks you.
- Broad allow rules (`Bash(*)`, interpreters such as `python`, `node`, `bash`, `npx`, any sub-agent) are set aside while
  Auto is on, so a rule cannot hand the agent unreviewed code execution. Ask rules still ask you; deny rules still deny.
  Deleting outside the folder always asks you. A hook that answers `allow` skips the prompt, except for dangerous commands.

Auto reduces prompts. **It is not a security boundary.** It is a model reading a summary: it can be wrong, a weaker model
is wrong more often, and everything it allows runs as you. For work that must not go wrong, use Ask permissions or work in
a throwaway checkout.

## Instructions in files, pages and tool output

Models read a lot of text Atelier did not write. What is done about it:

- The prompts tell the model that file contents, command output, web pages, connector results, project documents and
  attachments are **material to work with, not orders**, and to tell you when such content tries to steer it. Pages
  fetched by the web tool are summarized by a helper model told the same.
- Atelier's own structural tags (`<context-update>`, `<instructions>`, `<document>` and the like) are escaped in anything
  that did not come from Atelier, so a file cannot forge one.
- Search queries are checked for credentials before they leave, and a rendered message cannot load images or scripts
  from other hosts.

None of this is a guarantee: it is guidance to a model, and models can be tricked. The checks that do not depend on the
model are the permission rules, the folder confinement, the address guard and the sandboxes. If you point an agent at
untrusted content, assume it may act on it, and keep permissions tight.

## Web fetch and private networks

The model's web tool refuses to connect to addresses it should not reach, so a hostile page cannot make it read your LAN or
Atelier's own API:

- Always refused: this machine (127.0.0.0/8, `::1`, `0.0.0.0`), link-local addresses including the cloud metadata address
  169.254.169.254, and multicast and reserved ranges.
- Refused unless an admin allows them: private ranges 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, the carrier-grade range
  100.64.0.0/10 (Tailscale uses it) and IPv6 `fc00::/7`. The file-only setting `capabilities.webFetchPrivateNetworks`
  allows them (see [Data and files](/data-and-files/#settings-files)); there is no switch for it in Settings.
- The error reads "`host` resolves to a private network address, which WebFetch may not access."
- Every address a name resolves to is checked, and again for each redirect. Redirects to **another host** are not followed
  silently (the result names the new URL), so `WebFetch(domain:…)` rules cannot be sidestepped. URLs with embedded
  credentials are refused; responses over 10 MB are refused; at most 5 same-host redirects, 30 seconds, 100,000 characters.
- The check resolves the name before connecting; it does not pin the connection to the checked address. A hostile DNS
  server that answers differently the second time could get past it.

Search results' pages are opened with the same guard. Search queries never carry credentials: a query that looks like a
key, token or password, or contains one of your stored secrets (8 characters or longer), is refused with "The query
contains what looks like a credential, so it was not sent." Queries are limited to 400 characters.

## Artifacts and inline visuals

An artifact runs in an iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin`, so it has an opaque origin: no
access to the app, cookies, local storage or your account. Its page carries a Content-Security-Policy with `connect-src
'none'` (no network from script), `form-action 'none'`, `base-uri 'none'`, images only from `data:` and `blob:` and fonts
only from `data:`. It talks to the app only through `postMessage` with a fixed message format. It bundles React and the libraries
artifacts use, so nothing is loaded from the internet. Inline visuals in chat run in the same kind of frame.

What it does not do: an artifact is code the model wrote, so it can use the CPU and draw anything on its frame, and
anything you copy out of it is untrusted.

## The chat sandbox

In Chat, the model can get **Bash** and **Read** in a folder of its own, with no permission prompts and fixed rules instead:
Read works only inside the sandbox folder; dangerous commands are refused with their reason; other commands run.

| Where | Confinement |
|---|---|
| **A server** | A separate container with none of the server's data or secrets, limited to 2 CPUs, 2 GB and 512 processes. Each account's commands run as a Unix user of its own there, in folders only that user can enter (below). The server reaches it over SSH with its own key and does not verify the container's host key, since it is reachable only on the Compose network. |
| **The desktop on macOS** | The runner runs inside the system sandbox: writes only to the chat's folder and temporary folders, and no reading or writing of credentials (`~/.ssh`, cloud and package-manager credentials, keychains, browser profiles, mail) or Atelier's data. |
| **The desktop on Windows and Linux** | **Not confined.** The folder is a normal folder and commands run as you. Commands that pass the dangerous-command check go to the Auto reviewer instead of running. |

Limits to know:

- **Network is open.** Commands in the sandbox can reach the internet (that is how they clone repositories) and, on a
  server, the other containers on the Compose network. Put the sandbox on a network of its own if that matters.
- **On a server, accounts are kept apart by the operating system.** The container has a pool of Unix users
  (`sbx000`, `sbx001`, …, 256 by default, `ATELIER_SANDBOX_SLOTS`). The server gives each account one for good and logs in
  as it, so every command of that account's chats (and its runner, its caches and its temporary files) runs as that user.
  An account's home and `chats/<account>/` are mode `0700`, owned by its user. A command from another account's chat
  cannot list, read, change, delete or leave a file in them, cannot signal or read the environment of its processes, and
  cannot become another user: only sshd and the short script it runs to prepare an account's folders run as root, the image
  has no setuid, setgid or file-capability program and no `sudo` (its build fails otherwise), and the compose file starts
  the container without new privileges and with only the six capabilities sshd needs (all in Docker's default set). The server's private key is not in the
  container (it has the public half), and the accounts cannot read the file that says which user belongs to which account.
- **What accounts still share on a server.** The container's CPU, memory, disk and process limits are shared, so one
  account can use up what the others need. The network is shared: another account's server on `localhost` is reachable.
  The process list is shared: `ps` shows the command lines (not the environment, working directory or files) of other
  accounts' running processes, so a secret passed as a command-line argument is visible while the command runs. The
  names of other accounts' folders can be probed (an existing one answers "permission denied"). Do not keep secrets in a
  server's sandbox anyway: it is a place to run a model's commands.
- **A sandbox of your own** (a container you built, with `ATELIER_SANDBOX_USER` set) has one login for everybody and none
  of this separation.
- The dangerous-command check is a pattern list, as above.
- Sandbox folders are never deleted when a chat is.

## Sessions that message each other

A Code or Cowork session can send a message to another **of the same person's** sessions (`SendMessage`, with
`ListSessions` to find them), and a sub-agent can message its parent. The tool is not read-only, so it asks like any other
write. It never reaches another account (another person's session reads as unknown), and Chat conversations cannot
receive messages. To stop two sessions from driving each other in circles, a chain of messages that starts turns with
nobody in between is held after 3 turns, and one conversation may start at most 5 turns by itself in a row; after that the
message waits for you.

## Memory and sensitive topics

Memory is per person and stays in your account. **Include sensitive topics in memory** (health, religious beliefs and the
like) is **off by default**, and with it off entries marked sensitive are not read back into conversations. The model that
writes memory is the one you configured, so what memory learns passes through that provider. See [Memory](/memory/).

## Connectors

Connectors (MCP servers) add tools. Their trust level is whatever you give the server:

- A connector's tool descriptions and results go to the model and can contain instructions. They are treated as untrusted
  material, but a malicious or compromised connector is a way to influence the model.
- Calls to connector tools ask by default (**Ask**; **Always allow** and **Block** are the other choices; in Auto mode the
  reviewer answers for a tool left on its default). A server's own "read-only" hint lets a call into Plan mode but never
  skips a prompt.
- **Stdio connectors run a program on the machine of the backend as that user**, so only the desktop app starts them; a
  server refuses them. Prefer connectors with an HTTP address.
- HTTP connectors that use OAuth are signed in once by an admin; the tokens are stored encrypted and used for every
  session, so everyone on the server acts through that one sign-in.
- Credentials are masked in the connector logs under **Settings › Admin › Developer**.

## The desktop app

- The window is sandboxed with context isolation and no Node.js. Its Content-Security-Policy allows scripts and styles only
  from the app itself and no network connections of its own: the interface cannot talk to the internet, only the
  background backend can.
- Links and new windows open in your system browser (only `http` and `https`); the window cannot navigate away from the app.
  Of the browser permissions, only clipboard writing and notifications are granted.
- Messages between the window and the backend are validated.
- The Code **Browser pane** shows pages in a separate, hardened frame: no Node, no preload, only `http(s)` pages (or files of
  the workspace), a session of its own where every permission is refused and downloads are cancelled, at most 20 tabs, and
  no route into the app's sign-in.
- In server mode your sign-in token is kept in the operating system's secure storage and goes only to your server. The
  window sees it once, when you sign in, and hands it to the main process; after that only the main and background
  processes hold it, and attachments are fetched by the background process.
- **ChatGPT Chat** keeps a browser session with your chatgpt.com sign-in in its own storage in the app's profile folder.
  Treat that folder like a browser profile.

## The web server

### The web server's headers

- Every HTML page carries `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src
  'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:;
  worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Scripts and
  styles come from the server only; **images from other hosts are not loaded**, so Markdown cannot beacon data to a third
  party; the site cannot be framed.
- The artifact page has the stricter policy above, `X-Content-Type-Options: nosniff`, and is served at
  `/artifact-runtime/` and `/inline-visual.html`.
- `/api/blobs/<hash>` (attachments, generated files, avatars) requires a sign-in, serves only common image types inline
  (PNG, JPEG, GIF, WebP, AVIF) and everything else as a download, with `Content-Security-Policy: default-src 'none'; sandbox`
  and `nosniff`.
- The server does **not** send `Strict-Transport-Security` or `Referrer-Policy`: add `Strict-Transport-Security` at your
  proxy once HTTPS works.

### Origin checks, cookies and proxies

- **Sign-in, sign-out and passkey requests must come from the site's own address**, and so must the WebSocket that carries
  the whole app. A request with an `Origin` that is not `ATELIER_BASE_URL` (or, without it, the address derived from the
  request) is refused with "Cross-site request refused." / "Cross-site WebSocket refused." Together with `SameSite=Lax`
  cookies this blocks cross-site forgery. Programs that send no `Origin` (the desktop app, `curl`) pass this check; they
  still need a valid token.
- The session cookie `atelier_session` is `HttpOnly`, `SameSite=Lax`, path `/`, 30 days, and `Secure` when the public
  address is `https`. The token is 256 bits of randomness; the server keeps only its SHA-256.
- `X-Forwarded-*` headers are believed only from `ATELIER_TRUSTED_PROXIES`, so a client cannot spoof its address or the
  scheme. See [Run a server](/self-hosting/#addresses-https-and-proxies).
- The device link (`/api/devices/link`) accepts only a bearer token in a header, which a web page cannot set, so no website
  can open a link with your cookie.
- Passwords are scrypt-hashed (N=2^15). Wrong passwords and invite codes are rate-limited (8 in 15 minutes: per username
  and address for passwords, per address for invite codes). Passkeys need user verification and a discoverable credential. Details in [Accounts](/accounts/).
- Connector OAuth sign-ins finish at `/oauth/callback` only with the same person's cookie.

### Isolation between accounts

Every request is scoped to the signed-in account. Two things are not per-person permission checks: files are fetched by
their content hash, so any signed-in account that knew a 256-bit hash could fetch that file (the hash cannot be guessed,
but it is an address, not a grant); and an admin can reset a password and thereby take over an account. See
[Accounts](/accounts/#what-admins-can-and-cannot-see).

## Secrets

- Provider keys, connector tokens and sign-ins (ChatGPT Plan, GitHub Copilot, GitHub tokens, saved SSH passwords) are stored
  encrypted: in the desktop app with Electron's `safeStorage` (Keychain, Credential Manager, Secret Service); on a server
  with AES-256-GCM and a 32-byte key from `ATELIER_SECRET_KEY` or a 0600 key file. Settings files hold only references
  such as `${secret:my-key}`.
- A saved secret is never shown again: the interface gets only its last four characters. The request log masks headers and
  query parameters whose names look like credentials.
- **Settings › Admin › Keys & secrets** shows which settings use a secret. A person's own GitHub token and SSH passwords
  are hidden from admins and cannot be referenced from settings.

What encryption at rest does not do: it does not protect conversations and files, and with the default server setup the key
is in the same volume as the secrets (see [Run a server](/self-hosting/#the-secrets-key)).

## Screen lock on this computer

With **Run on this computer** there is no password. **Settings › Account › Screen lock** (off by default) sets a PIN or a
password; setting it up and locking are described in [Accounts](/accounts/#screen-lock). While it is on:

- Atelier opens locked, only the lock screen is drawn, and the built-in backend refuses every request from the app's
  windows except unlocking.
- The PIN is stored only as a scrypt hash in `screen-lock.json` in the data folder and checked by the backend. After 5 wrong
  tries each further one waits longer (30 seconds, doubling, up to an hour), also after a restart.
- Changing or turning off the lock asks for the current one.

It hides Atelier from someone at your unlocked computer. **It does not encrypt your data**: anyone who can read your files
(another user account with access, a backup) can read Atelier's database without it, and work already running (a Code
session, a scheduled loop) carries on while it is locked. A forgotten PIN is removed with **Forgot your PIN?** › Touch ID on
a Mac that has it, or by quitting Atelier and deleting `screen-lock.json`, which takes the same access as reading the data.

## Updates

Every update is checked before it is downloaded: each package needs a `<file>.sig`, an Ed25519 signature over the package's
name and hash, which must verify against a public key built into the app. A compromised update server or storage account cannot hand out an update of its own; it would need the
publisher's private key. The key and the exact flow are in [Updates](/updates/#what-is-verified). macOS builds are Developer
ID signed and notarized. Windows builds are **not** signed, so SmartScreen warns on first install, and the
update signature is what protects Windows updates.

## Content safeguards

Atelier adds no content policy of its own by default; the model's and provider's behavior applies. Admins can switch on
optional safeguards for everyone or per person (**Settings › Admin › Capabilities**). They are instructions to the model,
not a filter: a determined person or a model that follows instructions poorly can get around them.

## What Atelier does not protect against

- **A malicious or compromised model provider.** Whatever you send a provider (the conversation, file contents the agent
  read, command output, attachments) is visible to it. A provider can also return tool calls; they go through the same
  permission checks as anything else.
- **A compromised host.** Anyone who can run code on the machine as you, or read the server's volume, can read
  conversations and, on a server with the default key arrangement, the stored keys.
- **A model that is manipulated or wrong.** Prompt-injection defenses are best-effort. Auto mode is a reviewer model, not a
  boundary. Bypass mode removes the safety net by design.
- **Commands you approve.** A command you allow runs as you with the network open.
- **ChatGPT Plan and ChatGPT Chat are unofficial.** Neither is an API OpenAI offers to other apps: Plan signs in the way
  OpenAI's Codex does and uses its endpoints; Chat drives a chatgpt.com browser session. They can break
  without notice, and your ChatGPT account and plan limits are the ones at stake.
- **Unsigned Windows builds** on first install, and Windows and Linux builds being less exercised than macOS.
- **Other people with access to the same server** beyond what [Accounts](/accounts/) describes: admins decide what every
  model is told, and the host's operator can read everything.

## Reporting a security problem

Report a suspected vulnerability privately, not in a public issue: on the project's GitHub page, **Security** › **Report
a vulnerability** ([`SECURITY.md`](https://github.com/TheOriUHD/atelier/blob/main/SECURITY.md) has the details). Include the
version and platform, the steps to reproduce, and what an attacker gains.

## Telemetry

None. Atelier contains no analytics, tracking or crash-reporting code. What it does contact, and when, is
[What leaves your machine](/privacy/).
