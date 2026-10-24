---
title: Troubleshooting
description: Symptom-driven fixes for connection, sign-in, model, search, connector, Code, startup, update and data problems, with the exact messages Atelier shows.
---

Find the message or symptom and follow what it means. Messages are quoted as Atelier shows them. To report a problem, see
the [end](#reporting-a-bug).

## Can't reach the server

After a couple of failed attempts, the desktop app's **Connecting to …** screen turns into **Can’t reach … yet**, says why,
and keeps trying by itself. **Change server** lets you pick another server or **Run on this computer**. The reasons:

| It says | What to check |
|---|---|
| macOS isn't letting Atelier reach *host*. If it is on your local network, switch Atelier on under System Settings › Privacy & Security › Local Network. | See [the next section](#macos-and-a-server-on-your-local-network). |
| There is no server named *host* on this network. Check the address, and that you are online. | The name is mistyped, you are offline, or this network's DNS does not know it. |
| *host* refused the connection. Is the server running, and is the port right? | Nothing listens there: the server or proxy is down, or the port is wrong. |
| *host* didn't answer in time. | A firewall or VPN drops the traffic, or the host is down. |
| *host* can't be reached from this computer's network. | No route: another network, or a VPN that is not connected. |
| *host*'s security certificate isn't trusted (*code*). | The proxy's certificate is self-signed or from an internal authority this computer does not trust. Install the authority, or use a certificate from a public one. |
| The server answers, but refuses the live connection. If it sits behind a proxy, the proxy has to pass WebSockets, and the address in the proxy and in Atelier must match. | See [the page loads but spins forever](#the-page-loads-but-spins-forever). |
| The address answered HTTP *n*, which is not an Atelier server's health check. Check the address. | Something else answers there (a login page, a different app). |
| Couldn't connect to *host*: *reason*. | Anything else the system reported. |

<!-- screenshot: the "Can’t reach … yet" screen with a reason and the Change server link -->

### Entering a Server URL

On the **Connect to a server** form, the field takes `atelier.example.com`, `192.0.2.20:7340` or a full URL.

| It says | Meaning |
|---|---|
| No Atelier server answered at *address*. | You typed a full URL and `/api/health` did not answer there within 5 seconds. |
| No Atelier server answered at *host*, over https:// or http://. | Without a scheme Atelier tried `https://` (4 seconds), then `http://`; neither answered. A name that may not use plain `http://` (next row) is tried over `https://` only, and the message names `https://`. |
| Use https:// for *host*. Plain http:// is only allowed for this computer, your local network and Tailscale (*.ts.net). | Plain HTTP is accepted only for private addresses. |
| Enter the server’s address, for example atelier.example.com or 192.168.1.20:7340. / Enter the full server URL, for example https://atelier.example.com. / The server URL must start with https:// or http://. | The field is empty, or the text is not a usable address. |

**Found on your network** lists only servers on port 7340 over plain HTTP. A server behind a proxy that does not publish
7340 is not listed: type its address. See [Run a server](/self-hosting/#connecting-browsers-and-desktop-apps).

### macOS and a server on your local network

macOS asks once whether Atelier may find devices on your local network. If the answer was no, every later attempt fails
without a word. The connecting screen then has **Open Local Network settings**, which opens **System Settings › Privacy &
Security › Local Network**, where Atelier must be switched on. A server name that is public but points at a local address (a
proxy on your network) counts too.

A build you made yourself must be validly signed for macOS to keep this permission; an unsigned build whose bundle was modified
is refused silently.

### The page loads but spins forever

Run `atelier-setup doctor` on the server's machine (see [Install it with the setup wizard](/self-hosting/#install-it-with-the-setup-wizard)).
It opens the address the way a browser does and says which step fails and what to change. The rest of this entry is what
it checks.

In a browser, behind a proxy: the server and the proxy disagree about the address people use, so the live connection is
refused (HTTP 403, "Cross-site WebSocket refused."), and a sign-in may say "Cross-site request refused." Typically
`ATELIER_BASE_URL` still names another address while people arrive at the public one, or the proxy is not in
`ATELIER_TRUSTED_PROXIES` (a proxy that moves to another address, as when its machine gets a new DHCP lease, stops being
trusted). The server's log says so: `docker compose logs atelier` shows "Refused a WebSocket: the browser's address is …,
but this server sees itself at …", with the address of the sender and the setting to change. Either set `ATELIER_BASE_URL` to the exact public address, or leave it unset and put the proxy's
own address in `ATELIER_TRUSTED_PROXIES`. Also check that the proxy passes WebSockets on `/api/ws`. The full list of what
breaks is in [Run a server](/self-hosting/#what-breaks-when-they-are-wrong).

## Signing in

| You see | Meaning and fix |
|---|---|
| Wrong username or password. | Passwords are case-sensitive. Usernames are not (Atelier lowercases what you type). The message is the same for an unknown username. |
| Too many attempts. Try again in a few minutes. | 8 failures for that username from that address in 15 minutes. Wait. If everyone is affected, the server does not know the visitors' addresses: set `ATELIER_TRUSTED_PROXIES`. |
| Your account is waiting for an admin to approve it. | You signed up while sign-up was open. An admin approves you under **Settings › Admin › Users › Waiting for approval**. |
| This account is disabled. Ask an admin to re-enable it. | An admin disabled the account. |
| Choose a new password to continue. / **Choose a new password** | An admin gave you a temporary password; replace it. |
| This invite code is wrong, already used or expired. | Codes work once, for 7 days. Ask for a new one. |
| That setup token is wrong. It is printed in the server log. | `docker compose logs atelier \| grep setupToken`. A new token is generated at each restart unless `ATELIER_SETUP_TOKEN` is set. |
| This server already has an admin. Sign in instead. | The first account exists. |
| The username “*name*” is taken. | Choose another. |
| Sign-up is by invitation. Ask an admin for an invite code. | The server is on **Invite only**. |
| Cross-site request refused. | The address in the browser is not the one the server expects. See above. |
| Sign-in works and you are signed out at once | The browser blocks cookies for the site. (An address that differs from `ATELIER_BASE_URL`, `http` against `https` included, is refused with "Cross-site request refused." instead.) |
| You’re signed in for now: This computer has no secure storage Atelier can use, so it can’t keep you signed in. | No usable keychain (common on Linux without a keyring). You sign in again next start. Set up the system's keyring to stay signed in. |
| Atelier is locked. Unlock it to continue. | The screen lock is on; enter your PIN or password. |

### Passkeys

**Sign in with a passkey** appears only in a browser, over HTTPS (or on `localhost`), at a hostname: not on an IP address
or in the desktop app. Messages:

| You see | Meaning |
|---|---|
| The passkey request was cancelled or timed out. | You dismissed the browser's prompt, or it waited too long. |
| That passkey isn’t registered here. | This server does not know the passkey: it was removed, or made for another hostname. |
| The passkey couldn’t be verified. Try again. | The address in the browser differs from the server's `ATELIER_BASE_URL` (passkeys are bound to its hostname and origin). |
| That passkey request expired. Try again. | The prompt stayed open for more than 5 minutes. |
| This device already has a passkey for your account. | Remove the old one first, or use it. |

### Screen lock

"That PIN is wrong." / "That password is wrong." After 5 wrong tries each further one waits (30 seconds, doubling, up to an
hour): "Too many wrong tries. Wait a moment, then try again." The count survives a restart. If you forgot the PIN: **Forgot
your PIN?** › Touch ID on a Mac with it, or quit Atelier and delete `screen-lock.json` in the data folder
([Data and files](/data-and-files/)).

## Models

### No models are listed

- **Settings › Admin › Providers** must show the provider as **Connected** (with a count of models). **Test connection** in its
  ⋯ menu re-checks. **Unreachable** shows the reason.
- "Nothing is listening at *host:port*." The model server is not running, listens on another port, or listens only on
  `localhost` while Atelier reaches it over the network. Ollama listens on all interfaces with `OLLAMA_HOST=0.0.0.0`. On a
  server, `localhost` means the server's own container, not your computer.
- "*Provider* is running but has no models yet." (setup) Pull one, for example `ollama pull qwen3`.
- "llama-server is still loading the model": wait and test again.
- *Provider* rejected the credentials (401): the key is wrong, expired or lacks access. *Provider* endpoint not found (404) —
  check the base URL: the address is missing its path (`/v1` for OpenAI-compatible servers).
- A model may be hidden: under **Settings › Admin › Models**, **Browse catalog** shows every model of a provider with a
  **Visible** switch for the picker, while **Enabled** shows only the visible ones. Only admins see hidden models.
- A model that is in the provider but not in the list can be added by its id in **Settings › Admin › Models**.

### An answer fails

| The message | Meaning and what to do |
|---|---|
| *Provider* is busy or unavailable (500) | The provider answered with a server error, a timeout (408) or a rate limit (429). Atelier retries by itself, see below. |
| *Provider* usage limit reached | A quota, billing or plan limit ("insufficient quota", "weekly limit", payment required). It is not retried; the turn ends. Check the provider's plan or credit. |
| *Provider* rejected the credentials | See above. |
| Model not found | The model id no longer exists at the provider. Pick another in **Settings › Admin › Models**. |
| The conversation is too long for this model | The request exceeded the context window. Atelier compacts a conversation on its own at 85% of the window; this appears when even that is not enough, or when a local model's real window is smaller than Atelier believes. Raise or correct **Context length** in **Settings › Admin › Models › Edit overrides…**, or start a new conversation. |
| This task keeps filling the model's context window … | One turn was summarized repeatedly (at most 8 times) and still did not fit. Raise the model's context length or send a smaller step. |
| Cannot reach *Provider* at *host* | The connection failed. Retried automatically. |
| *Provider* at *host* took too long to respond / … sent nothing for too long (no response for 15 minutes) | A local server went silent. Raise `ATELIER_MODEL_IDLE_TIMEOUT_MS` for models that stay quiet while they write a long call. |
| The model connection ended before the reply was complete. | The stream stopped mid-reply. Retried automatically. |
| The model's reply didn't follow its own format, so *Provider* couldn't read it | The server could not parse a tool call. Atelier asks again twice. A model with a poor chat template does this often: set its tool calling to **Prompted** (below). |

**Retries.** A busy provider, a dropped connection or a timeout is retried up to 10 times with growing waits (5, 10, 15 and
30 seconds, then 1, 2, 4, 8, 16 and 32 minutes). The status line shows "Connection interrupted. Retry *n* of 10" and, in
the transcript, "Waiting to reconnect". Stop ends it. Quota errors and bad credentials are not retried.

### Tools don't work with a model

A model that answers but never uses tools, or writes tool calls as text, probably has no native tool calling. In
**Settings › Admin › Models**, open the model's ⋯ menu and choose **Probe tool calling**: Atelier asks the model to call a
test tool and records the result, "The model returned a native tool call." or "No native tool call; switched to prompted
tool calling." You can also set **Tool calling** by hand in **Edit overrides…** (**Automatic**, **Native**, **Prompted**,
**None**). Prompted describes the tools in the prompt for models without native support. A compact **Prompt tier** suits
smaller local models. See [Models](/models/).

For Ollama, "failed to parse grammar" or "failed to initialize samplers" make Atelier describe the model's tools in the prompt
instead, until the app restarts.

### A local model is slow, stalls or runs out of memory

- **"Loading the model"**, then "Still loading the model, a large one takes a while" (20 seconds) and "Still loading, this is
  taking longer than usual" (a minute): the server is loading the model into memory. Large models on small GPUs can take
  minutes. "Reading the conversation" is the same for a long prompt.
- **"Waiting in line for the model · *n* requests ahead"**: the server takes one request at a time, and others (sub-agents,
  titles, memory) are ahead. In the provider's settings, **Requests at once** and **Models at once** set what the server can
  take; raise them only if it really can.
- **"No output for a minute, it may be writing a long call"**, then "Still no output, the model may have
  stalled. Stop ends the turn", then "No output for ten minutes, the model has probably stalled": the model's
  server is silent. A long tool call is silent too. Stop ends the turn; if it keeps happening, the server may be hung
  (restart it). Without the notice, a silent server ends the request with "sent nothing for too long" after 15 minutes.
- **Out of memory or a crash** at the server: a context window too large for the memory. Lower **Context length** in
  **Edit overrides…**, or give Ollama an **Available VRAM (GB)** in the provider's settings so Atelier sizes the
  window from the model's architecture. Smaller quantizations use less memory.
- ChatGPT Chat at high effort settings shows "Thinking", then "Still thinking, a high effort setting can
  take a few minutes", and can stay on it for minutes. That is ChatGPT's own thinking time.

A context window under 16,000 tokens shows a note under the Code message box ("This model's … window is small for Code: long
tasks compact often. Raise it in Settings › Admin › Models.").

### ChatGPT

- "ChatGPT Chat requires the desktop app." It runs only in the desktop app; a server does not offer it.
- "Open the ChatGPT session to sign in." Use the provider's ⋯ menu › **Open ChatGPT session**.
- ChatGPT Plan on a server signs in with a one-time code shown in the dialog (valid 15 minutes); everyone on the server then uses the admin's plan.
- Both are unofficial; see [ChatGPT](/chatgpt/).

## Web search

**Settings › Admin › Capabilities › Web** shows each engine's state ("working", "limited for about 2 minutes", "not used yet")
and has **Test search**, which runs one real search ("*engine* answered in *n* s with *n* results.").

- "Search engines are limiting requests from this computer. Atelier tries again in about *n* minutes." Engines refuse some
  networks. Atelier waits, then retries; Wikipedia answers alone meanwhile ("General web search is unavailable right now … so
  these results come from Wikipedia only").
- "Web search is unavailable: this computer can't reach the internet."
- "The query contains what looks like a credential, so it was not sent." Queries with keys, tokens or your stored secrets are
  refused on purpose.
- With your own provider (SearXNG, Brave, Tavily) Atelier does not fall back to other engines. SearXNG needs JSON output
  enabled in its `settings.yml`; Brave and Tavily need a key.

A SearXNG instance of your own is the most reliable fix. See [Web search](/web-search/).

## Connectors

**Settings › Admin › Connectors** shows each connector as **Connecting**, **Ready**, **Error** or **Off**, and its tools. The
connector's own output is under **Settings › Admin › Developer › Connector logs**.

- "This server runs a program on this machine (stdio), which only the desktop app does. Use its HTTP endpoint instead." A
  server cannot start local programs. Use the connector's HTTP address.
- "Sign in to connect it. Every session then uses this sign-in." An OAuth connector needs an admin to sign in once. On a
  server the browser returns to `<ATELIER_BASE_URL>/oauth/callback`; finish in the browser where you started.
- "Signing in failed: …" the sign-in server refused or the callback could not reach the server.
- "The *name* connector is not connected: …" the model tried a tool of a connector that is in **Error**.
- A tool does nothing: its permission may be **Block**, or the chat has the connector switched off.
- After editing connectors or skills outside the app, **Reload** in **Settings › Admin › Developer** reconnects them.

## Permission prompts you did not expect

Every prompt says why. Common reasons:

| The prompt says | Why |
|---|---|
| *Tool* needs your approval. | No rule allows it and the mode does not run it by itself. Normal in Ask permissions. |
| The rule *rule* asks before this runs. | An ask rule matched. Ask rules apply in every mode. |
| This command *…*, e.g. "recursively deletes … outside the workspace" | A dangerous command ([Security](/security/#the-permission-model)). |
| *Tool* wants to access *path*, outside the workspace. | A file tool reached beyond the folder and the allowed directories. |
| This command uses *…* ("`eval` runs code that can't be checked in advance", "a command name that comes from a variable") | The checker cannot read the line, so allow rules do not apply. |
| *Tool* changes *.git/*, which configures tools or the agent itself. | A protected file in Auto mode, sent for review. |
| Auto mode wants your OK … / Auto mode paused after 3 blocked actions in a row. | The reviewer was unsure, or blocked too often. Approving resumes Auto. |
| Auto mode couldn't check this action (…) | The reviewing model failed or timed out. |
| Auto mode has no other model than ChatGPT Chat to check this action. Set a small model in Settings › Admin › Models, or pick another permission mode. | ChatGPT Chat never reviews itself. |
| A PreToolUse hook asks for your approval. | A hook you or the project configured. |
| **Trust this workspace?** | A folder new to your list. |

Refusals read "Blocked by the rule *rule*." (a deny rule), "Plan mode is on, so this can't run yet …", and "Auto mode blocked
this action: …". See [Permissions](/permissions/).

## Code and Cowork

- **"Open the desktop app to work in a folder on your computer, or use a codespace."** A browser has no folders of its own. Sign
  in to the server from the desktop app and open a folder there; then choose **Remote Control** in the environment menu
  above the composer and pick that computer.
- A computer shows **Offline** or "Its computer is offline": its desktop app is closed, asleep or signed out.
- "*Name* is on a device that isn't connected." / "This folder is on another computer; open folders there in that computer's
  desktop app."
- "*Device* has no runner build for this platform." / "*path* isn't a folder you opened in *device*'s desktop app." The desktop
  refuses folders you did not pick in its own folder picker.
- "This server does not run commands on its own machine. Open the desktop app to add a folder on your computer."
- **No runner:** "No runner build in … run `pnpm runner:build` to use local folders." appears in the log of a build made from
  source without runners.
- **SSH.** "SSH workspaces need the desktop app." "Use a host from ~/.ssh/config or user@host." "*host* runs … on …; remote
  workspaces need Linux or macOS on x86-64 or ARM64." "*host* didn't answer within *n* seconds." "Uploading the runner to
  *host* failed: …". "Nobody answered the connection prompt in time." (5 minutes) means a password or host-key question
  went unanswered. Atelier uses the system `ssh`, so `~/.ssh/config`, ProxyJump and agents apply; a host that works in your
  terminal works here. "This computer has no ssh command. Install OpenSSH …" means `ssh` is not on the path Atelier sees.
- **Codespaces** (not verified against a real account). "Connect GitHub first." "GitHub no longer accepts the saved token.
  Connect again." "*name* couldn't start (*state*)." "*name* isn't available after three minutes (it is *state*)." "Waking
  your codespace" can take a minute or more. The codespace needs `sshd` (the default image has it), and this computer needs
  the GitHub CLI: "Codespaces need the GitHub CLI (gh) on this computer. Install it from https://cli.github.com …" (a
  server's image includes it).
- A Code session without a folder says "Sessions without a folder need the desktop app running on this computer." when
  the backend is a server.
- Hooks that fail show "Hook failed (exit *n*): …" or "Hook timed out after *n*s". Exit code 2 blocks the call.
- **Chat sandbox:** "Chats here have no sandbox." (no `ATELIER_SANDBOX_HOST`), "The sandbox can't be reached: …" (with
  "Permission denied" the `sandbox` container is older than the server or refused the account's user: update both, or read
  `docker compose logs sandbox`), "The sandbox has no free account left" (raise `ATELIER_SANDBOX_SLOTS` on both services),
  "Read works only inside this chat's sandbox folder (…)", "The sandbox doesn't allow this: the command …".

## The desktop app won't start or looks wrong

- **Only one window, nothing happens when you open it again.** Atelier allows one running copy; a second launch focuses the
  first.
- **A blank window, or "Loading" for a long time.** The built-in backend may be failing to start and restarting every half
  second. Atelier writes no log file; start it from a terminal to see the backend's output
  (macOS: `/Applications/Atelier.app/Contents/MacOS/Atelier`; Windows: the `Atelier.exe` in your install folder; Linux:
  `atelier` or the AppImage). The usual causes are a data folder that cannot be written (full disk, permissions) or a
  damaged database. Restore from a backup ([Data and files](/data-and-files/#backing-up-and-restoring)).
- **The first-run screen again.** `connection.json` in the profile folder was deleted, or you used **Log out** or **Change
  setup…**. Choose **Run on this computer** again and your chats are there.
- **macOS: "Atelier can't be opened because Apple cannot check it …".** Releases are Developer ID signed and notarized and
  should open normally. A build without signing, yours or an old download, is blocked by Gatekeeper: right-click the app ›
  **Open**, or `xattr -dr com.apple.quarantine /Applications/Atelier.app`.
- **Windows: "Windows protected your PC".** Windows builds are not code-signed, so SmartScreen shows "unknown publisher". Choose
  **More info › Run anyway**.
- **Linux.** Prefer the `.deb` (`sudo apt install ./Atelier-<version>-amd64.deb`). The AppImage needs FUSE 2 (`libfuse2` on
  most distributions, `libfuse2t64` on Ubuntu 24.04). If a build refuses to start with a sandbox error, running it once with
  `--no-sandbox` confirms the cause, but that turns off Chromium's sandbox for the run; use the `.deb` instead. Linux and
  Windows builds are less exercised than macOS.

### "Atelier restarted and cut off this reply."

The backend (the app, or the server) was restarted while a reply or a Code session was running: an update, a crash, a
quit, a container recreate. The transcript keeps what arrived. Press **Continue** to carry on from there.

## Updates

| You see | Meaning |
|---|---|
| Nothing happens at **Check now** | Look at the **Updates** row: it says "Up to date. Checked …", the error, or why updates are unavailable. |
| Automatic checks are off. Check now looks for a new version. | **Check for updates automatically** is off. |
| This copy has no update source, so it can’t check for new versions. Get them from the Releases page. | The public feed is removed (`ATELIER_UPDATE_FEED=off`) and there is no server to ask. |
| This copy of Atelier can’t update itself. Install it from the releases page to get updates. | An unpackaged build, or a Linux package that is neither AppImage nor `.deb`. |
| The server doesn’t offer updates for this computer yet. Its admin sets them up with ATELIER_UPDATES_REPO. | The server's feed is off (and the public feed is removed). |
| The server didn’t accept your sign-in. Sign in again to get updates. | The server answered 401. |
| Atelier *x* is not signed, so it was not downloaded. / … is not signed with Atelier's key … | The package has no valid signature. A feed you run yourself needs a `.sig` file for each package (`deploy/cloudflare/sign-release.mjs` makes them). |
| Couldn’t download Atelier *x*: the file is damaged. / … the server answered 404. | A bad or missing download. The next check tries again. |
| Atelier *x* has no update for this Mac. | The feed lists no zip for your Mac's architecture. |
| **Download** instead of an automatic update (macOS) | Atelier cannot replace itself where it is: run it from Applications, not from a disk image or Downloads. |

A browser tab that shows "The server was updated to Atelier *x*." needs **Reload**. After a server update, desktop apps
reconnect by themselves.

On a server, **Update server** problems: "The updater refused this server’s secret: both must mount the same `updater-secret`
volume.", "The updater can’t be reached at …", "This server was built from source; update it by rebuilding its image."
See [Run a server](/self-hosting/#the-updater-service).

## Data and disk

- **The disk is full.** The data folder grows with conversations, attachments and file versions for Rewind. **Settings ›
  Privacy › Keep conversations** deletes old ones (every 24 hours while Atelier runs); **Settings › Admin › Code › Keep checkpoints for** shortens Rewind history.
  Scratch folders, chat sandboxes and clones in the sandbox volume are never deleted automatically.
- **Slow or "database is locked".** Two Atelier processes on one data folder wait on each other's lock for five seconds,
  then fail. Run one. SQLite does not work reliably over network file systems.
- **Provider keys are gone after restoring a backup on another computer.** Keys are encrypted with a key that belongs to the
  operating-system account (desktop) or to `secret.key`/`ATELIER_SECRET_KEY` (server). Enter them again, or restore the key.
- **"The settings file has settings that don’t apply until it is fixed: …"** (admins, top of Settings) `settings.json` has an
  invalid key or is not valid JSON. Fix the file; Settings refuses to write over a file it cannot read.
- **A conversation is missing on another device.** With [Remote control](/remote-control/) off for the account
  or for that conversation, only the sign-in that made it can open it.

## Reading logs

- **Server:** `docker compose logs -f atelier` prints one JSON object per line (`level`, `message`, sometimes `error`). It
  shows start-up, the setup token, a line when the update feed is on, connector and runner output, and failures such as
  "rpc … failed".
- **Desktop app:** no log file. Start it from a terminal (see above) to see the backend's output.
- **Settings › Admin › Developer** (admins). **Record provider requests** is off by default and records nothing until you
  switch it on: turn it on, reproduce the problem, then look. It holds the last 100 requests to providers (address, status,
  timing, masked headers, a failed response's error body; never prompts or replies) in memory, cleared when the backend
  restarts. **Connector logs** show each connector's output, credentials masked.
- **The transcript.** A failed turn shows its error on the message.

## Reporting a bug

Open an issue in the project's GitHub repository. The most useful report has:

- The Atelier version (**Settings › System › Version** in the desktop app; **Settings › Admin › Server** for a server) and
  whether it is **Run on this computer**, a server, or a browser.
- Your operating system, and for a server how you run it (Compose, source, the proxy in front).
- The provider type and model, and whether it is local or hosted.
- The exact message, and what you did before it.
- For provider problems, the relevant rows of the request log (credentials are masked), and for server problems the log lines
  around the time.

Leave out API keys, tokens, setup tokens, invite codes and anything private from the conversation. For a security problem, do
not open a public issue; see [Security](/security/#reporting-a-security-problem).

## Still stuck

Search the page for the message. [Run a server](/self-hosting/#troubleshooting-a-server) has the operator's table,
[Accounts](/accounts/) the sign-in rules, and [Updates](/updates/) the update flow.
