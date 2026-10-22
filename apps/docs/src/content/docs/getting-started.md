---
title: Get started
description: Install Atelier, choose where it keeps your chats, connect a first model, and work through your first Chat, Code session and Cowork task.
---

## What Atelier is

Atelier is a workspace for language models. Its three modes share one set of conversations, settings and
models:

- **Chat** for conversations, with artifacts, projects, attachments, memory and web search. See [Chat](/chat/).
- **Cowork** for a longer task in a folder, which ends in files you can open. See [Cowork](/cowork/).
- **Code** for an agent that works in a repository: it reads and edits files, runs commands in a terminal and shows its
  changes as diffs, under the permission rules you choose. See [Code](/code/).

It runs on the models you choose: a local server such as Ollama or llama.cpp, a hosted API with your own key, or a
ChatGPT or GitHub Copilot plan you already pay for. No model comes with Atelier.

There is one backend with two ways in. The **desktop app** (macOS, Windows and Linux) can run the backend inside itself
or connect to a server. The **web app** is the same interface in a browser, served by an Atelier server you host
([Self-hosting](/self-hosting/)). There is no Atelier cloud; your conversations stay on the machine that runs the
backend. Atelier is in beta; macOS is the most tested platform, Windows and Linux less so.

## Install the app

Download it from [atelierhq.dev/download](https://atelierhq.dev/download/); the [install guide](/install/) has the
details for each system. If someone gave you an Atelier server's address, you don't need to install anything: open it in
a browser, or choose **Connect to a server** in the desktop app.

## Choose where Atelier keeps your chats

The first time the desktop app opens, it asks **Where should Atelier keep your chats?**

<!-- screenshot: the first-run screen with the two choices, "Run on this computer" and "Connect to a server" -->

| Choice | What it means |
|---|---|
| **Run on this computer** | Atelier runs its own backend here; chats and settings stay on this computer. Pick this to try Atelier or to use it alone. |
| **Connect to a server** | Use an Atelier server, for example in your home lab, and sign in with your account there. Your chats live on the server, which you can also open from a browser. |

Either way the desktop app can open folders on this computer for Code and Cowork. In a browser there is no such choice:
you open your server's address and sign in.

### Run on this computer

Atelier starts its own backend inside the app and asks one thing: **What should Atelier call you?** Type your name and
choose **Continue**. There is no password, because only the app itself can reach this backend. You can add a PIN or
password as a screen lock later in **Settings › Account** (see [Security](/security/)).

Being "the owner" on this computer means:

- You are the first account on this backend, which makes you the **admin**: the sidebar shows "Admin" beside your name,
  and Settings has an **Admin** group (listed [below](#settings)).
- Your chats, settings and memory are in `~/.atelier` on this computer, and your provider keys are encrypted with the
  operating system's secure storage. See [Install](/install/#where-atelier-keeps-its-data).
- There is no sign-in to manage: Settings › Account has no password, sessions or devices, **Log out** becomes
  **Lock Atelier**, and **Setup** lets you switch to a server later.

### Connect to a server

Choose **Connect to a server** and type the address in **Server URL**. The field accepts `atelier.example.com`,
`192.0.2.20:7340` or a full URL.

- Without `https://`, Atelier tries `https://` first and, if nothing answers within 4 seconds, plain `http://`. Plain
  `http://` is only accepted for this computer, your local network and Tailscale (`*.ts.net`); any other server must use
  `https://`.
- With a scheme typed, that exact address is used.
- If nothing answers, you get "No Atelier server answered at …". Check the address and that the server is running.

**Found on your network** lists Atelier servers that answered on this computer or its local networks (port 7340, within
about 3 seconds), with address and version; click one to connect. Most people use the field above instead. On a Mac,
the first time you connect to a server on your network, macOS asks whether Atelier may find devices on your local
network. Allow it, or Atelier can't reach the server (see [Troubleshooting](/troubleshooting/)).

Then sign in on the server's screen:

- **Sign in** with your username and password, or **Sign in with a passkey** in a browser.
- **I have a code** if an admin gave you an invite code: enter it, then your name, username and password.
- **Create an account** appears only when the admin opened sign-up; the account waits for an admin to approve it.
- On a brand-new server you create the first account, the admin, with the one-time setup token from the server's log
  (see [Self-hosting](/self-hosting/)).

A desktop connected to a server lends the folders you open to that server's sessions, which then run commands on this
computer as you. See [Accounts](/accounts/) for roles and sign-in, and [Security](/security/) for what a lent folder
allows.

### Changing your mind

Nothing you choose here deletes anything. Before sign-in, **Use a server instead** (on this computer) or **Change
server** goes back to the choice. Afterwards, **Settings › Account** has **Setup › Change setup…** on this computer and
**Server › Switch…** when the desktop app is connected to a server. Your chats on this computer stay where they are;
choose **Run on this computer** again to get back to them.

## Connect your first model

Only admins connect providers. A new install opens on the Chat home like any other day; the model menu under the message
box says **Choose a model** and offers **Add a provider**, which opens **Settings › Admin › Providers**. There Atelier
lists what it found by itself:

- **Local servers on their usual ports:** Ollama on 11434, llama.cpp on 8080 and LM Studio on 1234. Only an answer in
  the server's own shape counts, so another app on the same port isn't mistaken for a model server.
- **API keys in the environment:** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Atelier sees only the environment it was
  started with. An app opened from the Dock or a launcher doesn't read your shell profile (only its `PATH`), so a key
  exported in `~/.zshrc` alone won't be found; start Atelier from a terminal, set the variable system-wide, or add the
  provider by hand.

The scan runs on the machine that runs the backend: your computer in "Run on this computer" mode, the server when you are
connected to one.

Press **Set up** next to what it found: the provider's form opens filled in, and **Add provider** tests and saves it. A
key found in the environment is copied into Atelier's encrypted secret store, and only a masked ending is shown
afterwards. **Scan again** looks again. Once a provider is there, its first model is chosen in the model menu until you
pick another. If Ollama runs but has no models, pull one (for example `ollama pull qwen3`) and try again.

**Add provider** on the same page offers the full list:

| Provider | What you need | Notes |
|---|---|---|
| **Ollama** | Ollama running, default `http://localhost:11434` | No key. |
| **llama.cpp** | `llama-server` running, default `http://localhost:8080` | No key. For tool calls start it with `--jinja`, or switch the model to prompted tools. |
| **OpenAI-compatible** | A base URL (default `http://localhost:1234/v1`, LM Studio's) and a key if the server asks | LM Studio, vLLM or any server with an OpenAI-compatible API. |
| **Anthropic** | An API key | Claude models through the Anthropic API. |
| **OpenAI** | An API key | GPT models through the OpenAI API. |
| **ChatGPT Plan** | A ChatGPT plan; you sign in | Uses your plan's limits instead of per-token billing. Unofficial. Desktop on this computer: your browser opens. On a server: a one-time code to enter on OpenAI's page within 15 minutes, and everyone using the provider uses the admin's plan. |
| **GitHub Copilot** | A Copilot plan; you sign in with GitHub | A code to enter at `github.com/login/device`; counts against the plan's allowance. Unofficial. |
| **ChatGPT Chat** | A ChatGPT account | Experimental. ChatGPT itself, driven through a signed-in browser window. Desktop app on this computer only. |
| **OpenRouter** | An OpenRouter account or key | **Connect with OpenRouter** creates a key for you. Models marked free are limited to 50 requests a day (1,000 once you have bought 10 credits). |
| **OpenCode Zen** | An OpenCode Console key | Billing may be required; its free models may only work inside OpenCode itself. |

[Providers](/providers/) covers every field, [Local models](/local-models/) the local servers,
[ChatGPT](/chatgpt/) the two ChatGPT options, and [Models](/models/) how models are listed, hidden and overridden.

![Settings › Admin › Providers, with a detected provider, a connected Ollama server and Add provider](/img/providers-2496.webp)

If you are not an admin, the model picker says "No models available" and "Ask an admin to connect a provider."

## Your first Chat

Choose **New** in the sidebar (⌘N or Ctrl+N), type in the message box and press Enter; Shift+Enter starts a new line. The
model picker and effort setting are at the bottom right of the box.

![A Chat answering a question with a comparison table](/img/chat-2560.webp)

- While you have fewer than five chats, ideas under the box fill it with an example prompt.
- Attach images, PDFs and text files by dropping or pasting them, with ⌘U or Ctrl+U, or from the **+** menu.
- **Research** in the **+** menu is a per-conversation switch, off by default: each message then searches broadly and
  cites its sources. Plain web search is on from the start (see [Web search](/web-search/)).
- The ghost button at the top right starts a **temporary chat** that never appears in your history.
- Something a reply builds (a page, component, diagram or document) opens in a panel beside the conversation; see
  [Artifacts](/artifacts/).

Hover a message to copy it, retry a reply or edit your own message; the earlier versions stay, one click away.

## Your first Code session

1. Choose the **Code** tab at the top of the sidebar, then **New**.
2. Above the message box, the folder chip says **No folder** until you open one (**Select folder…** when the desktop app
   is connected to a server). Open it and choose **Open folder…**. If the folder is inside a Git repository, Atelier
   works in the repository's top level.
3. When a folder is new to your list, Atelier asks **Trust this workspace?** Its agent may read, write or run commands
   there, as you, so choose **Trust workspace** only if you trust what is in the folder.
4. Pick how much it may do with the mode at the bottom left of the box. **Auto mode** is the default.

   | Mode | What it does |
   |---|---|
   | **Auto mode** | The model reviews each action that would ask, in a separate request, and blocks risky ones. |
   | **Ask permissions** | Asks before editing files or running commands. |
   | **Accept edits** | Edits without asking, still asks before commands. |
   | **Plan mode** | Reads and plans only; changes wait until you approve the plan. |
   | **Bypass permissions** | Never asks, not even for risky commands. |

   Shift+Tab, with the message box empty, cycles Auto, Ask, Accept edits and Plan. Auto mode reduces prompts; it does not
   replace review of sensitive work. See [Permissions](/permissions/).
5. Describe a task and press Enter. When something needs your approval you choose **Deny**, **Allow once**, or
   **Always allow** (for this project; the arrow beside it offers this session or everywhere).
6. Open the **Diff** pane (and **Terminal**, **Browser**, **Files**; the Browser is in the desktop app only) from the
   buttons at the top right to review what changed, commit, or reject a single hunk. **More** has Background tasks,
   Plan, Artifact and Side chat.

![A Code session asking permission before running a git commit](/img/permission-2560.webp)

**No folder** (first in the folder menu, offered when the desktop app runs on this computer) gives each new session an
empty folder of its own, a safe way to try Code. In a browser, Code works in a folder lent by one of your desktop apps
or in a GitHub codespace; the server never runs commands on its own machine. See [Code](/code/).

## Your first Cowork task

1. In the Chat sidebar choose **Cowork**.
2. Choose a folder as in Code (or **No folder**), describe the task and press Enter. From a new chat you can also use
   **+ › Add folder**, which turns it into a Cowork task.
3. Watch its steps and the task list beside the conversation. It ends with cards for the files it wrote, each with **Open**.
4. Turn on **Notify me when a task finishes** and **Notify me when a task needs me** in **Settings › General** to get a
   system notification while you are in another window.

![A Cowork task with its progress list and the file it wrote in the folder](/img/cowork-2560.webp)

Cowork has no permission-mode picker; it uses the default mode from **Settings › Admin › Code** (Auto, unless an admin
changed it). New Cowork tasks and Code sessions start on the **Default model for everyone**; pick another in the message
box before your first message. See [Cowork](/cowork/).

## A tour of the interface

### The sidebar

- The header has the sidebar toggle (⌘B) and two tabs, **Chat** and **Code**. Cowork is a page inside Chat.
- **Search** (⌘K) finds chat titles and message text, and offers actions such as a new chat.
- In Chat: **New**, **Projects**, **Artifacts**, **Cowork**, **Customize** (skills, connectors and plugins) and **More**
  (**Settings**, **Usage**, **Keyboard shortcuts**), then pinned items and your recent chats and Cowork tasks by day. In
  Code: **New**, **Customize**, **More**, then your sessions by folder.
- At the bottom: your name with "Admin" or "Member" and a menu (Settings, theme, **Lock Atelier** or **Log out**).
- A line above the profile shows an update's download progress, then **Restart**. See [Updates](/updates/).

### The message box

- The **+** button opens **Upload or add files**, **Add folder** (on a new conversation), **Skills**, **Connectors**
  (switch them on or off for this conversation), **Add plugins** (admins) and **Research**. `/` lists commands and
  skills, and `@` mentions a file in Code. See [Shortcuts](/shortcuts/).
- The **model picker** lists the visible models by provider.
- The **effort** control (⌘⇧E or Ctrl+Shift+E) sets how hard the model works. Every model has the same stops (Low,
  Medium, High, Extra, Max), starting at the one marked Recommended for that model; ChatGPT Chat takes the stops of
  ChatGPT's own picker. Higher stops think and check more, take longer and use more tokens; Max warns that it uses about
  3.5 times more. In Code the last stop is **Ultracode**, where the model plans and has sub-agents investigate and check
  in parallel; an admin can switch it off. Models that can only turn thinking on or off get a **Thinking** switch in the
  same popover. See [Effort](/effort/).
- The **context ring** shows how full the model's context window is. In Chat and Cowork, hover it; older messages are
  summarized automatically before it fills. In Code, click it for what fills the window, **Compact session**, the
  session's tokens and cost, and your usage (for a ChatGPT Plan, the plan's own limit windows).

### Settings

Open Settings with ⌘, (Ctrl+, elsewhere), from **More**, or from the profile menu. The search box finds any setting by
name. The pages in the **Settings** group are for everyone:

| Page | What it is for |
|---|---|
| **General** | Theme, chat font, transcript text size and width, motion; your own **Default model** for new chats; Cowork notifications. |
| **Account** | Your photo, name, what Atelier calls you, personal **Instructions**, **Personality**, **Response style** and **Your ATELIER.md**. On this computer also **Screen lock** and **Setup**; on a server your password, passkeys, active sessions, devices, **Remote control** and **Log out**. |
| **Privacy** | **Keep conversations** (automatic deletion after a number of days), **Temporary chats**, **Export your data**, **Delete all conversations**. |
| **Memory** | What Atelier remembers across chats, and whether it may. See [Memory](/memory/). |
| **Usage** | Requests, tokens and cost by day, mode and model. |
| **Code** | Permission rules you approved with **Always allow**, code appearance and font, the default transcript view, the interface font, and the commit author. |
| **Folders** | The folders you opened for Code and Cowork, and your SSH connections. |
| **Cloud** | Your GitHub connection and the codespaces that become folders. |
| **Skills** | The skills sessions can use, and installing them from GitHub (admins). |
| **System** (desktop app only) | The version, updates (**Check now**, **Check for updates automatically** and the update channel), **Launch at login**, and the **Data folder**. |

The **Admin** group appears only for admins: you, on this computer; whoever has the admin role, on a server. **Users** and
**Server** matter mainly on a server; the server's version and **Update server** appear only there.

| Page | What it is for |
|---|---|
| **Providers** | What was detected, and adding, editing, disabling or removing providers. |
| **Models** | The **Default model for everyone**, the **Small model** that writes titles, summaries and memory, every model with its overrides, and aliases for agent files that ask for `opus`, `sonnet`, `haiku` or `fable`. |
| **Capabilities** | Web search and web fetch, **Instructions for every conversation**, hand-editing memory, and extra safeguards. |
| **Code** | The default permission mode, allow, ask and deny rules, additional directories, **Ultracode**, Claude Code compatibility, hooks, how long checkpoints are kept, and the system AGENTS.md. |
| **Connectors** | MCP servers that give sessions tools from other services, and each tool's permission (Always allow, Ask or Block). |
| **Plugins** | Installed plugins and adding marketplaces. |
| **Keys & secrets** | The API keys and tokens Atelier stores encrypted. |
| **Users** | People, approvals for self sign-ups and invite codes. |
| **Server** | The server's version, **Update server**, and the sign-up policy. |
| **Developer** | The request inspector, connector logs and a reload. |

Every setting, with its description, is listed in [Settings reference](/reference/settings/).

## What leaves your computer

Atelier has no telemetry: no analytics, no crash reports, and nothing that sends your chats, settings or keys to its
makers. What it does send:

- **Model providers and connectors you set up** receive what you send them. A local model on your own machine receives it
  there.
- **Update checks (desktop app).** At start and every 5 minutes the desktop app asks `updates.atelierhq.dev` for the
  newest version's update file. Connected to a server whose admin set up updates, it asks that server first. **Settings
  › System › Check for updates automatically** turns this off, and **Check now** still looks. See
  [How do I stop Atelier from checking for updates?](/faq/#how-do-i-stop-atelier-from-checking-for-updates)
- **Web search and web fetch**, on by default. A search sends its query text to search engines (the built-in search tries
  DuckDuckGo, Brave and Bing in turn, and Wikipedia when they refuse; news searches also go to Bing News and Google News,
  programming searches to Stack Overflow, Hacker News and GitHub), and the first result pages are fetched from your
  computer, or from the server. Settings › Admin › Capabilities turns them off or points them at your own SearXNG, Brave
  Search or Tavily.

Details are in [What leaves your machine](/privacy/), [Web search](/web-search/) and [Updates](/updates/).

## Where to go next

**Start here:** [Install](/install/) · [Providers](/providers/) · [Models](/models/) · [Local models](/local-models/) · [ChatGPT](/chatgpt/)

**Using Atelier:** [Chat](/chat/) · [Artifacts](/artifacts/) · [Projects](/projects/) · [Cowork](/cowork/) ·
[Code](/code/) · [Permissions](/permissions/) · [Effort](/effort/) · [Sessions](/sessions/) · [Loops](/loops/) ·
[Shortcuts](/shortcuts/) · [Web search](/web-search/) · [Memory](/memory/)

**Extend it:** [Customize](/customize/) · [Connectors](/connectors/) · [Hooks and plugins](/hooks-and-plugins/)

**Running it:** [Self-hosting](/self-hosting/) · [Accounts](/accounts/) · [Remote control](/remote-control/) ·
[Security](/security/) · [What leaves your machine](/privacy/) · [Data and files](/data-and-files/) ·
[Environment variables](/environment-variables/) · [Updates](/updates/) · [Troubleshooting](/troubleshooting/)

**Under the hood:** [How it works](/how-it-works/) · [Claude Code compatibility](/claude-code-compatibility/) ·
[Prompts](/prompts/) · [Settings reference](/reference/settings/) · [Tools reference](/reference/tools/)

**About:** [FAQ](/faq/) · [License](/license/)
