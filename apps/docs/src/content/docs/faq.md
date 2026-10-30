---
title: FAQ
description: Short answers about what Atelier is, what it costs, what it sends where, how it works with Claude Code's files, and what to do when something goes wrong.
---

## About

### What is Atelier?

A workspace for language models with three modes on one backend: **Chat**, **Cowork** and **Code**. It runs as a desktop
app (macOS, Windows, Linux) or a web app you host yourself, on models you choose. See [Get started](/getting-started/).

### Is Atelier made by or affiliated with Anthropic, OpenAI or GitHub?

No. Atelier is an independent project, not affiliated with or endorsed by Anthropic, OpenAI, GitHub or any other company.
You can use Anthropic's models through the API by adding a key under **Anthropic**, like any other provider; OpenAI's and
GitHub Copilot's models work likewise. "Claude" and "Claude Code" are trademarks of Anthropic. Atelier reads Claude Code's
files where they already are (see
[Do my Claude Code skills, plugins and hooks work?](#do-my-claude-code-skills-plugins-and-hooks-work)); that is
compatibility, not affiliation.

### What are Chat, Cowork and Code, and when do I use which?

- **Chat** for conversations: questions, writing, research, and anything that ends in an answer or an
  [artifact](/artifacts/) such as a page, a diagram or a document. A chat can also clone a repository and run commands in a
  sandbox of its own. See [Chat](/chat/).
- **Cowork** for a longer task in a folder that should end in files you can open, such as a report or a cleaned-up
  spreadsheet. See [Cowork](/cowork/).
- **Code** for changing a repository: it reads and edits files, runs commands and shows diffs, under a permission mode,
  with a terminal and a way to rewind. See [Code](/code/).

If you are unsure, start in Chat and move to Cowork when the answer should become files; under a reply that used the chat
sandbox, **Continue in Cowork** carries the conversation over.

### Is Atelier finished?

No. It is in beta and changing quickly, so expect things to be missing, to change or to break. macOS is the most tested
platform, Windows and Linux less so. Experimental features are marked as such in the app and in these docs.

### Which systems does it run on?

The desktop app runs on macOS 13 or later (Apple silicon and Intel), Windows 10 and 11 (x64 and ARM64) and Linux (`.deb` and
AppImage, x86-64 and ARM64). The web app runs in a browser, served by an Atelier server you host. See [Install](/install/).

### Is there a mobile app?

No. There is no iOS or Android app, but the web app has a phone layout below 768 pixels wide, so you can open your own
server in a phone's browser. See [Self-hosting](/self-hosting/).

### Is Atelier open source?

No. It is source-available under the PolyForm Noncommercial License 1.0.0: you can read, change and share the code for
noncommercial purposes, but commercial use is not allowed, so it is not an open-source license. See [License](/license/).

### How is it licensed, and can I use it at work?

Personal use, study, research, hobby projects and use by charities, schools, public bodies and similar organizations are
covered. **Commercial use** isn't: using Atelier at a company for its business needs a separate license from the author.
The repository's `LICENSE` file is what counts; this answer is not legal advice. See [License](/license/).

### Why is it called Atelier?

An atelier is a workshop where makers work. The name, the app id, the data folder name, the URL scheme and the cookie
name all come from one constant in the code (`packages/protocol/src/app.ts`).

### How do I report a bug or ask for a feature?

Open an issue in [TheOriUHD/atelier](https://github.com/TheOriUHD/atelier) on GitHub, and include:

- The version: **Settings › System › Version** in the desktop app, or **Settings › Admin › Server** on a server.
- Your system, and which provider and model you used.
- The exact text of any message, and the steps that lead to it.
- For a provider problem, the failing request: switch on **Record provider requests** in **Settings › Admin › Developer**,
  repeat the message, and open the failing row (address, status, timing, masked headers, a failed answer's body). It
  never records prompts or replies but does show server addresses, so look before you share it.

Never paste API keys, tokens or invite codes into an issue.

## Models and cost

### Which models and providers can I use?

Local servers (**Ollama**, **llama.cpp**, and **LM Studio**, vLLM or any other server with an OpenAI-compatible API),
hosted APIs (**Anthropic**, **OpenAI**, **OpenRouter**, **OpenCode Zen**), and subscriptions you already have (**GitHub
Copilot**, **ChatGPT Plan**, and **ChatGPT Chat**). You can connect several at once; the model picker groups
models by provider. See [Providers](/providers/) and [Models](/models/).

### Do I need an API key?

Not for local models: Ollama and llama.cpp need none. A hosted API needs a key from that provider, and ChatGPT Plan and
GitHub Copilot use a sign-in instead. Keys are stored encrypted, and only a masked ending is shown after you save one.

### How much does Atelier cost?

Atelier is free for noncommercial use: no subscription, no account with the Atelier project, no paid tier. What costs money
is the models; see the next question. Commercial use needs a license from the author ([License](/license/)).

### What does using models cost me?

It depends on where the model runs:

- **A local model** costs your hardware and electricity.
- **A hosted API** bills you per token. **Settings › Usage** shows tokens and cost by day, mode and model, using the
  providers' published list prices for Anthropic and OpenAI models unless an admin sets a price under **Settings › Usage ›
  Prices**; other models, and a ChatGPT plan, count tokens only. In Code, the context ring's popover shows the session's
  cost.
- **A ChatGPT or GitHub Copilot plan** uses the plan's allowance. For ChatGPT Plan, the Code context popover shows the
  plan's own limit windows (for example a 5-hour and a weekly window) and when they reset.
- **OpenRouter's free models** cost nothing but are limited to 50 requests a day (1,000 once you have bought 10 credits).

Higher effort levels use more tokens: Max is flagged as consuming about 3.5 times more, and Ultracode far more. See
[Effort](/effort/).

### Can I use my ChatGPT subscription?

Yes, in two ways, both unofficial and both able to stop working when OpenAI changes something. **ChatGPT Plan** signs in
the way OpenAI's Codex does and uses your plan's limits instead of per-token billing; it works in the desktop app and on a
server (on a server everyone using the provider uses the admin's plan). **ChatGPT Chat** is experimental and
desktop-only: it drives ChatGPT through a signed-in browser window, runs on ChatGPT's own limits and models, and
automated access like this may conflict with OpenAI's terms. See [ChatGPT](/chatgpt/).

### Can I use my GitHub Copilot subscription?

Yes: **Add provider › GitHub Copilot** shows a code to enter at `github.com/login/device`, and the models in your plan
appear. It needs a Copilot subscription, counts against its allowance, and is unofficial: GitHub documents Copilot's API for
its own editors, so it can change. Atelier lists **Copilot Auto**, where Copilot's router picks the model; on Free and
Student plans, whose model picker holds only Auto, it is listed first. See [Providers](/providers/).

### Can I run it fully offline?

Yes, with a local model. Install Ollama or llama.cpp and connect it, and your models and conversations stay on your
machine. The interface is part of the app and needs no internet. Web search, web fetch, connectors to online services,
GitHub and hosted providers need a network, and the desktop app's update check can't reach its feed (it just fails; the
message appears only in **Settings › System**, where you can also switch the automatic checks off).

### Can I use a model server on another machine?

Yes. Add it as a provider with its address, for example an Ollama at `http://192.0.2.10:11434`. The server has to accept
connections from your computer (Ollama listens only on localhost unless you tell it otherwise). On a Mac, the first
connection to a machine on your network triggers macOS's local network prompt. See [Local models](/local-models/).

### A small local model fumbles tool calls. What can I do?

A few settings help. In **Settings › Admin › Models**, open the ⋯ menu of the model:

- **Probe tool calling** runs a one-shot test and records whether the model makes native tool calls or needs
  **prompted** tool calling, where Atelier describes the tools in the prompt and parses the calls from the reply.
- **Edit overrides…** lets you set **Tool calling** (Automatic, Native, Prompted, None), **Context length**, **Max
  output**, **Temperature**, **Vision** and **Prompt tier**. The **Compact** prompt tier suits smaller local models.

With llama.cpp, a model whose template can't render tools gives "llama-server cannot render tool calls with its chat
template. Start llama-server with --jinja (or a tool-capable --chat-template-file), or switch this model to prompted
tools." Also check the model's context length: see the next question. See [Local models](/local-models/).

### My local model forgets things or the context seems short.

Atelier uses the context length the server reports. For Ollama it asks for at most 32,768 tokens by default; entering your
**Available VRAM** on the provider lets Atelier size each model's context from its weights and architecture instead. If the
reported length is wrong, set the real one under **Edit overrides…** (model overrides take priority). Atelier summarizes older
messages automatically before a conversation outgrows the window, and the context ring shows how full it is. See
[Models](/models/).

### Do all models have the same effort levels?

Yes: every model has Low, Medium, High, Extra and Max, starting at the one marked Recommended. Where a model has its own
setting for a level (Ollama's `think` option, a provider's reasoning levels), Atelier uses it; where it can't express a
level (a model that doesn't think, or one with only an on/off switch), Atelier asks the model for it in a short note.
ChatGPT Chat uses ChatGPT's own stops instead. In Code the last stop is **Ultracode** (not on ChatGPT Chat); an admin can
switch it off. See [Effort](/effort/).

### Can I use different models for different tasks?

Yes. Pick a model per conversation in the message box. **Settings › General › Default model** sets what your new chats
start with; **Settings › Admin › Models** sets the **Default model for everyone** and a **Small model** that writes titles,
summaries and memory. New Cowork tasks and Code sessions follow the default for everyone. Agent files written for Claude
Code that ask for `opus`, `sonnet`, `haiku` or `fable` use the model you map to that name under **Aliases** on the same
page.

## Privacy and data

### Does Atelier phone home? Is there telemetry?

There is no telemetry: no analytics, no crash reports, and nothing that sends your chats, settings or keys to its makers.
Apart from the model providers and connectors you set up, these are the requests Atelier makes by itself:

- **Update checks.** The desktop app asks `updates.atelierhq.dev` for the newest version's update file when it starts and
  every 5 minutes. If it is connected to a server whose admin set up updates, it asks that server first. A switch in
  **Settings › System** turns this off; see
  [How do I stop Atelier from checking for updates?](#how-do-i-stop-atelier-from-checking-for-updates) A self-hosted
  server reads the newest version number from the same feed when an admin opens **Settings › Admin › Server**, and caches
  it for 10 minutes. A server set up to serve desktop updates (`ATELIER_UPDATES_REPO` and `ATELIER_UPDATES_TOKEN`) asks
  GitHub's API for its releases instead.
- **Web search and web fetch**, on by default. Searches send the query to search engines, and pages are fetched when the
  model reads them.

See [What leaves your machine](/privacy/) and [Updates](/updates/).

### What do model providers see?

What Atelier sends them to answer you: the conversation, files you attach, the system prompt and tool descriptions, and
what tools return. A provider you run yourself on your own machine sees it there; a hosted one sees it under its own
terms. See [What leaves your machine](/privacy/).

### Where is my data?

On "Run on this computer": settings and extensions in `~/.atelier`, and the database and your files in `~/.atelier/data`
(`C:\Users\<you>\.atelier` on Windows), plus the app's own profile folder. On a server: the one data folder, `/data` in the
Docker image. Atelier encrypts the API keys and tokens it stores; it does not encrypt the conversations, so use your
operating system's disk encryption for those. See [Install](/install/#where-atelier-keeps-its-data) and
[Data and files](/data-and-files/).

### How do I back up or move my data?

Quit Atelier and copy `~/.atelier`. On a server, back up the data volume; it holds everything. Stored keys are encrypted
with the system's secure storage on a desktop, so a copy on another computer needs them entered again. **Settings › Privacy
› Export your data** makes a zip of your conversations (as JSON and Markdown), projects, artifacts, files and memory.

### Can I see exactly what is sent to the model?

The system prompts and the notes Atelier adds during a conversation are published word for word under
[Prompts](/prompts/), and every built-in tool's description and parameters under [Tools reference](/reference/tools/).
[How it works](/how-it-works/) covers how a request is put together. In the app, **Settings › Admin › Developer › Request
inspector** lists each request to a model provider with its address, status, timing, size and masked headers, but it never
records prompts or replies. In Code, the context ring's popover breaks down what fills the window:
messages, MCP tools, system tools, skills and the system prompt.

### How do I stop Atelier from checking for updates?

In the desktop app, open **Settings › System** and switch off **Check for updates automatically**. It is on by default.
With it off, the app checks nothing by itself: not at start, not after you sign in, not every 5 minutes. **Check now**
still looks when you press it, and an update that was already downloaded still installs.

The switch belongs to the desktop app on this computer and applies whether the app runs its own backend or is connected to
a server. A self-hosted server's own lookups are separate; see
[Does Atelier phone home?](#does-atelier-phone-home-is-there-telemetry) and [Updates](/updates/).

### What is a temporary chat?

A chat that never appears in the sidebar, search, the Artifacts page or a project, is not saved to memory, and is deleted
with its files and artifacts when you leave it. The ghost button at the top right of a new chat, ⇧⌘N (Ctrl+Shift+N; also
**File › New Temporary Chat** in the desktop app) or the search palette starts one. By default the model still knows your
instructions and memory; **Settings › Privacy › Temporary chats** can make it start fresh instead. See [Chat](/chat/).

### How do I delete my data?

**Settings › Privacy** has **Keep conversations** (conversations untouched for longer than the number of days you choose are
deleted once a day; pinned ones stay), **Delete all conversations** (every chat, Cowork task and Code session with its
messages, files and artifacts; projects stay; this can't be undone) and **Export your data**. Memory entries can be
deleted one by one in **Settings › Memory**.

## Using it

### Why does Atelier ask me to trust a folder?

Because a Code session or Cowork task can read, write and run commands in it, as you. A folder new to your list asks
**Trust this workspace?**; **Trust workspace** adds it. For a folder inside a Git repository, the repository's top level
is the workspace. See [Security](/security/).

### How do I make Code stop asking for permission?

Choose a different mode in the message box. **Auto mode** (the default) has the session's own model review each action that
would ask, in a separate request. **Accept edits** edits without asking and still asks before commands. **Bypass
permissions** never asks, not even for risky commands. You can also choose **Always allow** in a prompt, or an admin can
add allow rules in **Settings › Admin › Code**. Shift+Tab cycles Auto, Ask, Accept edits and Plan. See
[Permissions](/permissions/).

### Is Auto mode safe?

It reduces prompts; it is not a security boundary and does not replace review of sensitive work. A reviewing model decides
for each action that would otherwise ask, and risky ones are blocked unless you asked for them. Commands run as you,
so they can reach anything you can, and in Auto mode reading a file outside the folder is allowed unreviewed unless the path
looks like credentials. See [Permissions](/permissions/) and [Security](/security/).

### Can I undo what Code did?

Often. **Rewind to here** on one of your messages (or `/rewind`) restores the files changed since then, the conversation, or both,
and the **Diff** pane's **Reject** undoes a single hunk. Changes made by shell commands are not tracked, only file edits, so
use Git for those. Checkpoints are kept for 30 days by default (**Settings › Admin › Code › Keep checkpoints for**).

### Can Code work on another machine?

Yes: over **SSH** from the desktop app running on this computer (**Add SSH connection…** in the environment chip's SSH menu;
your keys and `~/.ssh/config` work as with `ssh`), or in a **GitHub codespace**. Codespace support is implemented but has not
been verified against a real account. In a browser, Code uses a folder lent by one of your desktop apps. See
[Code](/code/) and [Remote control](/remote-control/).

### Does it remember things between chats?

Yes, unless you turn it off. **Settings › Memory** shows what Atelier remembers about you and lets you delete entries
(editing them by hand needs an admin to switch on **Let people edit memory by hand** under **Settings › Admin ›
Capabilities**). **Generate memory from chats** and **Search and reference chats** are on by default; sensitive topics are
off by default. Chat and Cowork use memory. Code sessions and sub-agents get none, and a temporary chat reads your memory
but writes nothing to it (it reads none when **Settings › Privacy › Temporary chats** is set to start fresh). See
[Memory](/memory/).

### Can it search the web?

Yes, on by default, with nothing to set up. Add **Research** from the **+** menu to make each message search broadly and
cite its sources. Admins can switch search and fetch off, or send searches to their own SearXNG, Brave Search API or Tavily
in **Settings › Admin › Capabilities**. By default, fetching pages on your local network is refused. See
[Web search](/web-search/).

### Can I work in several sessions at once?

Yes. Split view puts up to four sessions side by side, and sessions keep running while you are elsewhere; a sidebar dot
marks one that needs you or has finished a turn. See [Sessions](/sessions/) and [Loops](/loops/).

### What are the keyboard shortcuts?

⌘N or Ctrl+N for a new chat, ⌘K or Ctrl+K for search, ⌘, or Ctrl+, for Settings, ⌘B or Ctrl+B for the sidebar, ⌘U or Ctrl+U
to attach files, ⌘⇧E or Ctrl+Shift+E for effort, Shift+Tab to cycle permission modes in Code, and Esc to stop a reply. See
[Shortcuts](/shortcuts/).

## Server and accounts

### Do I need a server?

No. **Run on this computer** is a complete setup for one person, and nobody else can reach it. You need a server for the web
app, for several people on one install, or to reach your conversations from more than one device. See
[Self-hosting](/self-hosting/).

### Does the web server run commands on its own machine?

No. A server never runs your Code or Cowork commands on its own machine. Code in a browser works through a folder lent by a
desktop app signed in to the same account, or a GitHub codespace. Chats are different: a chat can clone a repository and run
commands in a sandbox, which on a server is a separate container next to it, limited in CPU, memory and processes, that
holds none of the server's data or secrets. See [Security](/security/).

### How do other people join my server?

By invite code: **Settings › Admin › Users › Create invite code** makes a code like `A1B2-C3D4-E5F6-G7H8` that creates one
account, works once and expires after 7 days. They choose **I have a code** on the sign-in screen. An admin can also open
sign-up (**Settings › Admin › Server › Sign-up**): people then create an account that waits for an admin to approve it. Or
an admin creates the account directly with **Add user**, which gives the person a temporary password to replace. See
[Accounts](/accounts/).

### Can I sign in with a passkey?

In a browser, yes: **Settings › Account › Passkeys**. A passkey belongs to the site's hostname, so it needs a hostname
rather than an IP address (and a secure page: browsers only offer passkeys over HTTPS), and the desktop app signs in with a
password. See [Accounts](/accounts/).

### Can I sign in with Authentik, Keycloak or Google?

In a browser, yes: anything that speaks OpenID Connect. An admin adds it in **Settings › Admin › Server ›
Single sign-on**, and the desktop app keeps signing in with a password. See [Single sign-on](/self-hosting/#single-sign-on).

### Can I use my sessions from another device?

On a server, yes: sign in from another browser or the desktop app and your conversations are there. Folders opened in a
desktop app appear to your other devices as the **Remote Control** environment while that computer is online. A switch in
**Settings › Account**, and one in each conversation's header, controls whether a conversation is visible to your other
sign-ins. See [Remote control](/remote-control/).

### Can I switch between this computer and a server?

Yes, and nothing is deleted. **Settings › Account › Setup › Change setup…** goes back to the first choice on this computer,
and **Server › Switch…** does the same when the desktop app is connected to a server. The two stay separate: chats made on
this computer stay on this computer, and chats on a server stay on that server. See
[Get started](/getting-started/#changing-your-mind).

### Is there a screen lock?

On "Run on this computer": **Settings › Account › Screen lock** sets a PIN (4 to 8 digits) or a password, and Atelier then
opens locked. **Lock now**, ⇧⌘L (Ctrl+Shift+L elsewhere) or **Lock Atelier** locks it, and it can lock itself after 5, 15, 30
or 60 minutes without input. It hides Atelier; it does not encrypt your data. See [Security](/security/).

## Extending

### Do my Claude Code skills, plugins and hooks work?

Yes, they are read where they are: skills in `~/.agents/skills`, `~/.claude/skills` and a project's `.agents/skills` and
`.claude/skills`; commands and agents in `.claude/commands` and `.claude/agents`; `CLAUDE.md`, `AGENTS.md`,
`CLAUDE.local.md` and `.claude/rules` instructions; plugins installed by Claude Code; and hooks in Claude Code's settings
format (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`). Only `command` hooks run. Turn Claude
Code compatibility off in **Settings › Admin › Code** if you want the `.claude` folders ignored. See
[Claude Code compatibility](/claude-code-compatibility/) and [Hooks and plugins](/hooks-and-plugins/).

### What are connectors?

MCP servers that give sessions tools from other services, such as Cloudflare, GitHub, Notion, Linear, Brave Search or Home
Assistant. Admins add them in **Settings › Admin › Connectors** with a token or **Sign in with OAuth**, and each tool can be
set to **Always allow**, **Ask** or **Block**. In a conversation, **+ › Connectors** switches them on or off for that
conversation only. See [Connectors](/connectors/).

### How do I give Atelier my own instructions?

For every chat: **Settings › Account › Instructions**. For Code sessions and Cowork tasks: **Your ATELIER.md** on the same
page, and a project's `ATELIER.md` (or `AGENTS.md` or `CLAUDE.md`). An admin can add **Instructions for every
conversation** under **Settings › Admin › Capabilities** and a system AGENTS.md under **Settings › Admin › Code**. See
[Customize](/customize/).

## Troubleshooting pointers

### The app says "No Atelier server answered at …"

The address is wrong, the server is down, or it is unreachable from this computer. Check the address and that the server
runs; without `https://`, Atelier tries `https://` and then plain `http://` (allowed only on your local network and
Tailscale). See [Troubleshooting](/troubleshooting/).

### The app is stuck on "Connecting to …"

After the second failed attempt the screen says why ("Can't reach … yet", with the reason) and keeps trying. On a Mac the
reason is often a refused **Local Network** permission, and the screen offers **Open Local Network settings**. Behind a
proxy, the proxy must pass WebSockets and the address it uses must match the server's `ATELIER_BASE_URL`. See
[Troubleshooting](/troubleshooting/) and [Self-hosting](/self-hosting/).

### The model doesn't answer, or a provider shows "Unreachable"

Open **Settings › Admin › Providers**: each provider has a status dot, an error line and **Test connection** in its edit
dialog. Check the address and key, that the server runs, and (for Ollama with no models) that you pulled one, for example
`ollama pull qwen3`. Temporary failures retry on their own, with the retry number and elapsed time in the line under the
transcript. See [Troubleshooting](/troubleshooting/).

### A reply stopped with "Atelier restarted and cut off this reply"

Atelier or its server restarted (an update, a deploy) while the reply ran. **Continue** carries on from what was already
done instead of writing the reply again. See [Troubleshooting](/troubleshooting/).

### macOS, Windows or Linux won't open the installer or app

On macOS, a notarized build opens normally; if you see the malicious-software warning, the copy wasn't notarized
(right-click **Open**). On Windows, the installer isn't code-signed: **More info**, then **Run anyway**. On Ubuntu 24.04, an
AppImage needs `libfuse2t64` and may need `--no-sandbox`; the `.deb` avoids both. See [Install](/install/).

### Where can I read more?

[Get started](/getting-started/) walks through the first hour, [Troubleshooting](/troubleshooting/) lists messages and
fixes, and [Settings reference](/reference/settings/) lists every setting.
