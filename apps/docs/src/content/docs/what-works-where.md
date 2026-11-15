---
title: What works where
description: Which features need the desktop app, which work on a server, in a browser and in the terminal app, and which depend on the model, the operating system or an outside service.
---

Atelier runs three ways: the desktop app on its own backend (**Run on this computer**), the desktop app connected to a
server (**Connect to a server**), and a browser on a server. The [terminal app](/cli/) is a Code session that runs on
its own computer or against a server. The backend is the same everywhere; what changes is the computer it runs on and
what the app in front of you can reach. This page gathers the differences the guides describe one by one, and each row
links to the section with the details.

## By where you run it

✓ works, — not there. A note says how it differs.

| Feature | Desktop, this computer | Desktop on a server | Browser on a server | Terminal app |
|---|---|---|---|---|
| [Chat](/chat/) and its [tasks](/chat/#tasks) | ✓ | ✓ | ✓ | — ([a Code session](/cli/)) |
| [Code](/code/) | ✓ | ✓ | [In a lent folder or a codespace](/code/#in-a-browser) | ✓ |
| [Folders on this computer](/code/#where-it-runs-the-environment-chip) | ✓ | ✓, lent to the server | — | ✓, the folder you start it in |
| [No folder](/code/#no-folder) (an empty folder per session) | ✓ | ✓, made on this computer after **Allow** | — | — |
| [Another computer's folders](/remote-control/#two-things-called-remote-control) (Remote Control) | — (needs a server) | ✓ | ✓ | [Lends its own](/cli/#the-background-service) |
| [SSH hosts](/code/#ssh-hosts) | ✓ | [✓, with this computer's `ssh`](/code/#connected-to-a-server) | Under Remote Control | — |
| [Codespaces](/code/#codespaces) | ✓ | ✓ | ✓ | — |
| [Chat sandbox](/chat/#the-sandbox) | A folder on this computer | The server's | The server's | — |
| [Computer use](/computer-use/) | ✓ | ✓, on the computer the folder is on, else the one you last wrote from | — | — |
| [Browser pane and Preview](/code/#browser) | ✓ | ✓ | — | — |
| [Artifacts](/artifacts/) and inline visuals | ✓ | ✓ | ✓ | — |
| [Co-op](/co-op/) | With other computers, through the relay | With teammates on the server | With teammates on the server | — |
| [Memory](/memory/#where-memory-applies) | ✓ | ✓ | ✓ | — (Code has none) |
| [Web search and fetch](/web-search/) | Runs on this computer | Runs on the server | Runs on the server | Here, or on its server |
| [Model servers on your computer](/local-models/#your-computers-models-on-a-server) | [Detected](/providers/#detection) on their usual ports | **Settings › Your models**, for you alone | Through your desktop app, while it is connected | [Offered at setup](/cli/#the-first-start), on its own |
| [Your sessions on other devices](/remote-control/#where-it-applies) | [With Share on your network](/accounts/#share-on-your-network) | ✓ | ✓ | With a server: `/resume`, `/open` |
| [Passkeys and single sign-on](/accounts/#signing-in) | — (no sign-in) | — (password) | ✓ | [Through the browser](/accounts/#signing-in-a-terminal) |
| [Screen lock](/accounts/#screen-lock), [Share on your network](/accounts/#share-on-your-network) | ✓ | — | — | — |
| [Report an issue](/reporting-issues/#sending-one) | F1, with a picture | F1, with a picture | Without the picture | `/bug`, `/feature` |
| [Updates](/updates/#where-updates-come-from) | Installs them itself | Itself, from the server first if it serves them | [An admin updates the server](/updates/#the-server) | [Installs them itself](/cli/#install) |
| [Print mode](/cli/#print-mode) for scripts | — | — | — | `atelier -p` |

- A server never runs commands on its own machine. Code, and a chat with a folder, work in a folder a desktop app or the
  terminal app lends it, or in a codespace ([Run a server](/self-hosting/#what-the-server-is-and-what-it-is-not)).
- A server without the `sandbox` service gives its chats no sandbox: they have no file or command tools until they get a
  folder ([The chat sandbox](/self-hosting/#the-chat-sandbox)).
- On a server, `localhost` in a provider's address is the server or its container, not your computer
  ([Local models](/local-models/#pick-a-server)).
- Also only in the desktop app: [ChatGPT Chat](/chatgpt/#chatgpt-chat) (on a server, each person adds it as their own model
  from their desktop app); connectors that run a program (stdio), an
  admin's on the desktop's own backend and, on a server, your own through your desktop app
  ([Connectors](/connectors/#your-own-connectors-on-a-server));
  [Import from Claude Code](/connectors/#import-from-claude-code-and-mcpjson); **Keep computer awake**
  ([Code](/code/#keeping-it-running)); **Open in › New window**, **Cursor**, **VS Code** and **Finder**
  ([Sessions](/sessions/#open-in)); **Settings › System** and **Settings › Connection**
  ([Accounts](/accounts/#settings--connection)).

## Needs a capable model

The model picker shows what each model can do (`vision`, `reasoning`, `prompted tools`, `no tools`), and admins correct it
per model in **Settings › Admin › Models** ([Models](/models/#the-model-picker)).

- **Tool calling.** Tools reach a model natively or, for a model without tool support, as prompted tools described in
  the system prompt. Prompted tools are less reliable and make at most one call per message. A model set to **None** only
  talks ([Tool calling](/models/#tool-calling-native-prompted-none)).
- **Tasks in Chat.** A model without tool calling can't use the file tools, and small local models may fail on long
  tasks ([Chat](/chat/#limits-and-failure-modes)).
- **Images, video and sound** work with any text model that can call tools, local ones included. A model that can't
  see gets the image's id instead, so it can still ask for changes ([Image generation](/image-generation/)).
- **Vision.** Only a model with vision receives images; others get a note that one was attached. A server that reports
  nothing, such as LM Studio, starts with vision off: set **Vision** to **Supported** ([Vision and PDFs](/models/#vision-and-pdfs)).
- **PDFs** go as files to models that take them (the Anthropic and OpenAI models Atelier knows, Mistral models that take
  images, ChatGPT Chat). Every other model gets the text layer, and a scan without one gives no text
  ([What a model receives](/chat/#what-a-model-receives)).
- **Reasoning.** Every model shows Low to Max. Where its own setting lacks a level, the model is asked for it in a note; a
  model that can only switch thinking on or off gets a **Thinking** switch ([Reasoning and effort](/models/#reasoning-and-effort)).
- **Ultracode** is in Code only, for every model except ChatGPT Chat, while an admin allows it. A model without the
  Agent tool works in phases without sub-agents, and small models may start few or none ([Ultracode](/effort/#ultracode)).
- **The compact prompt tier**, which most local models get, leaves out TaskStop, ChangeDirectory, SendMessage,
  ListSessions, MemoryView, ChatRead, Time and Usage, and computer use's ComputerApps and OpenApp. To fit 16,000
  characters it trims the skill list, connector tool descriptions and long instruction files. Set **Prompt tier** to
  **Full** for a capable local model ([Prompt tiers](/models/#prompt-tiers)). Sub-agents on it stop after 150 model
  calls instead of 200 ([Sub-agents](/code/#sub-agents)).
- **Small windows.** Code warns when a model's window is under 16,000 tokens, because long tasks then compact often
  ([Context length](/models/#context-length)).
- **Memory** gives models Atelier doesn't recognize as frontier models, most local ones, a shorter digest
  ([How the model uses it](/memory/#how-the-model-uses-it)).
- **Auto mode's reviewer** is the session's own model. With a hosted model (Anthropic, OpenAI, Mistral, Mistral Vibe,
  ChatGPT Plan, GitHub Copilot) it reads "asked for" broadly; local models and every OpenAI-compatible provider,
  OpenRouter and OpenCode Zen included, keep the stricter reading
  ([What the reviewer sees](/permissions/#what-the-reviewer-sees-and-decides)). ChatGPT Chat can't review its own
  actions: the **Small model** does, and without one you are asked ([Which model reviews](/permissions/#which-model-reviews)).

## Per operating system

The desktop app runs on macOS 13 or later (Apple silicon and Intel), Windows 10 and 11 on x64, Windows 11 on ARM, and
Linux (`.deb` and AppImage, x86-64 and ARM64) ([Install](/install/#where-the-downloads-come-from)). macOS is the most tested; Windows and Linux less so
([Get started](/getting-started/#what-atelier-is)).

**macOS**

- Builds are signed and notarized. Keep Atelier in Applications so an update can replace it; elsewhere it offers
  **Download** instead ([Install](/install/#macos), [Updates](/updates/#what-each-platform-does)).
- A server on your local network needs the **Local Network** permission, for the desktop app and for the terminal app
  ([Install](/install/#macos), [Atelier CLI](/cli/#when-something-is-wrong)).
- The chat sandbox runs inside the system sandbox: commands write only to its folder and temporary folders and can't
  read your keys, credentials, browser profiles or Atelier's data. They can still read other files
  ([The sandbox](/chat/#the-sandbox)).
- Computer use asks for **Screen recording** and **Accessibility** ([Turn it on](/computer-use/#turn-it-on)). Background
  mode uses private parts of macOS's window server, which can change with an update. Without them, Chrome and Electron
  apps take only buttons, links and fields, and the rest needs Full control
  ([How the background works](/computer-use/#how-the-background-works-macos)).
- Closing the window leaves Atelier running, with its runs and loops ([Keeping it running](/code/#keeping-it-running)).

**Windows**

- The installer isn't code-signed, so SmartScreen warns on first install (**More info**, then **Run anyway**). Updates
  are still checked against the publisher's signature ([Install](/install/#windows)).
- Code runs commands with Git Bash when Git for Windows is installed, else Windows PowerShell ([Install](/install/#windows)).
  Hooks run in PowerShell ([Hooks](/hooks-and-plugins/#what-a-hook-receives)).
- The chat sandbox isn't confined: each command goes to the Auto mode reviewer first, and to you if it can't decide
  ([The sandbox](/chat/#the-sandbox)).
- SSH password and host-key prompts aren't available yet: keys and the agent only ([SSH hosts](/code/#ssh-hosts)).
- Computer use can't use apps running as administrator ([Turn it on](/computer-use/#turn-it-on)).
- Closing the last window quits Atelier, which stops runs and loops ([Keeping it running](/code/#keeping-it-running)).

**Linux**

- Prefer the `.deb`, which installs an AppArmor profile where AppArmor supports it. On Ubuntu 24.04 an AppImage needs
  `libfuse2t64` and may not start without `--no-sandbox` ([Install](/install/#linux)). An AppImage updates itself, a `.deb` asks for your password, and
  other packages don't update ([Updates](/updates/#what-each-platform-does)).
- Without a keyring the desktop app can't keep you signed in to a server: you sign in again at the next start
  ([Troubleshooting](/troubleshooting/#signing-in)).
- As on Windows, the chat sandbox isn't confined ([The sandbox](/chat/#the-sandbox)), and closing the last window quits
  Atelier ([Keeping it running](/code/#keeping-it-running)).
- Computer use talks to X11. There is no Background mode (the first choice is **Ask per app**), password fields aren't
  recognized, and a link in a mail app can't be told from other text. On Wayland it sees and controls only apps that run
  through XWayland, and some desktops hold back their input; with no X server it is unavailable
  ([Linux](/computer-use/#linux)).

**Elsewhere**

- An SSH host must run Linux or macOS on x86-64 or ARM64 ([SSH hosts](/code/#ssh-hosts)).
- The server images are for linux/amd64 and linux/arm64 ([Images and tags](/self-hosting/#images-and-tags)); the setup
  wizard runs on Linux or macOS ([Setup wizard](/self-hosting/#install-it-with-the-setup-wizard)).
- The terminal app installs on macOS and Linux with `curl` and on Windows with PowerShell ([Install](/cli/#install)).
  `atelier daemon keep` uses launchd, systemd's user manager or Task Scheduler ([The background service](/cli/#the-background-service)).

## Unofficial or outside services

- **ChatGPT Plan** is unofficial: it signs in the way OpenAI's Codex does, so it can change or stop working. On a server
  everyone who can use it uses the admin's plan ([ChatGPT](/chatgpt/#the-two-compared)).
- **ChatGPT Chat** is experimental and desktop-only. It drives chatgpt.com in a hidden window, and automated use may
  conflict with OpenAI's terms ([ChatGPT Chat](/chatgpt/#chatgpt-chat)).
- **GitHub Copilot** is unofficial: Atelier sends the editor headers Copilot's own plugin sends. **Copilot Auto** has not
  been tried on a Free or Student account ([GitHub Copilot](/providers/#github-copilot)).
- **Mistral Vibe.** Mistral allows a Vibe key in other apps only informally, and the allowance is read from a billing
  endpoint Mistral doesn't document. On a server everyone spends the admin's plan, and Mistral's terms don't allow
  passing a key to others ([Mistral Vibe](/providers/#mistral-vibe)).
- **Built-in web search** reads public search engines' result pages, which are not an official API
  ([How it works](/web-search/#how-the-built-in-search-works)), and engines refuse some addresses
  ([Limits](/web-search/#limits)). For guarantees, use your own SearXNG, a Brave Search API key or Tavily
  ([Use my own search service](/web-search/#use-my-own-search-service)).
- **Image generation.** OpenAI doesn't document the ChatGPT Plan route. Mistral's images come from Black Forest Labs'
  FLUX through a Mistral chat model and haven't been tested against Mistral's live service ([Cloud](/image-generation/#cloud)).
- **Video.** SwarmUI's video support was written from SwarmUI's source and not yet tried against a real server with a
  video model ([Add a video provider](/video-generation/#add-a-video-provider)).
- **Codespaces** are implemented but not verified against a real GitHub account, so treat them as experimental. They run
  on your GitHub account, under its usage and billing rules ([Codespaces](/code/#codespaces)).
- **Atelier for Chrome** isn't in the Chrome Web Store yet: load it unpacked from the folder **Settings › Computer use ›
  Atelier for Chrome** shows ([Atelier for Chrome](/computer-use/#web-pages-atelier-for-chrome)).
- **Connectors** act as the account that signed in or whose token was pasted. GitHub's hosted server may need Copilot on
  your account ([Ready-made entries](/connectors/#ready-made-entries)).
- **The project's own services.** Co-op between computers goes through the encrypted relay at `coop.atelierhq.dev`, or
  one you run ([Your own relay](/co-op/#your-own-relay)). The desktop app takes updates from `updates.atelierhq.dev`
  unless your server serves them ([Updates](/updates/#where-updates-come-from)). Issue reports go to
  `reports.atelierhq.dev`, and an admin can switch them off ([Reporting issues](/reporting-issues/#where-it-goes)).

## Admin only on a server

On **Run on this computer** you are the admin, and the only person the app signs in
([One person on this computer](/accounts/#one-person-on-this-computer)). On a server, the **Admin** group in Settings is
for accounts with the admin role ([Roles](/accounts/#roles)).

- **Only on a server:** invite codes ([Invite codes](/accounts/#invite-codes)), signing in through an identity provider
  ([Single sign-on](/self-hosting/#single-sign-on)), **Settings › Admin › Limits** ([Usage limits](/accounts/#usage-limits)),
  **Settings › Admin › Activity** ([The activity log](/accounts/#the-activity-log)), and the server's version with
  **Update server** ([Settings](/getting-started/#settings), [Updating](/self-hosting/#updating)).
- **Shared by everyone:** an admin sets up the providers, models, connectors and plugins for the whole server
  ([Roles](/accounts/#roles)). ChatGPT Plan, GitHub Copilot and Mistral Vibe spend the admin's plan for everyone
  ([Providers](/providers/#github-copilot)), and a connector acts as the account that signed it in
  ([Connectors](/connectors/)).
- **Each person's own:** connectors under **Customize › Connectors › Your connectors**
  ([Your own connectors](/connectors/#your-own-connectors-on-a-server)), and the model and image servers on their own
  computer under **Settings › Your models**, from that computer's desktop app
  ([Local models](/local-models/#your-computers-models-on-a-server), [Image generation](/image-generation/#add-an-image-provider)).
- **Hooks** from **Settings › Admin › Code › Automation › Hooks** and from plugins run only for folders on the backend's
  own machine, never on a person's own device ([Where hooks come from](/hooks-and-plugins/#where-hooks-come-from)).
- **What admins can't do:** read another person's conversations, memory or files in the app. They can reset a password,
  and with it take over an account ([What admins can and cannot see](/accounts/#what-admins-can-and-cannot-see)).
