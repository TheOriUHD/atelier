---
title: What leaves your machine
description: Every network connection Atelier makes, what each one sends, and whether you can turn it off.
---

Every network connection Atelier makes, by feature. "Backend" means the computer running Atelier's backend: your own
computer with **Run on this computer**, or your server. Rows that cost tokens or contact third parties are in bold.

This page is about the app. What the project's websites (atelierhq.dev, these docs and the update feed) process is in
the [Datenschutzerklärung](https://atelierhq.dev/datenschutz/) (German): only what serving a page needs, no analytics,
no cookies of their own.

| Feature | What is contacted | What is sent | Can I turn it off |
|---|---|---|---|
| **Model providers** | The address of each provider you added: for example `api.anthropic.com`, `api.openai.com`, `openrouter.ai`, `opencode.ai`, `api.githubcopilot.com`, `chatgpt.com`, or your own Ollama, llama.cpp or LM Studio server | The system prompt, the conversation, tool definitions, **tool results** (file contents and command output the agent read), attachments, your memory and instructions, and your key or token in a header | Not adding a hosted provider. Local servers on your own network send nothing outside it. |
| **Small-model jobs** | The small model's provider (without one, the chat's own) | Titles, compaction summaries, memory updates and answers about fetched pages: the content of those conversations or pages | Choose the small model in **Settings › Admin › Models**; memory switches in **Settings › Memory** |
| **Auto mode review** | The provider of the session's own model (the small model's for ChatGPT Chat) | Your last 10 messages, the arguments of the last 30 tool calls (plain lookups such as Read and Grep left out), and the call to judge. No tool results. | Use another permission mode |
| Provider health and model lists | Each enabled provider | A request for its model list and status. No conversation. At start, when a provider is added or edited, on **Test connection**, and when you recalculate models in **Settings › Admin › Models**. | Disable or remove the provider |
| Detecting local servers | `localhost` ports 11434 (Ollama), 8080 (llama.cpp) and 1234 (LM Studio) on the backend's own machine | A plain request; nothing leaves the machine | It runs when you open **Settings › Admin › Providers** or the first-run model step |
| **Web search** (built in) | `duckduckgo.com` (the html and lite pages), `search.brave.com`, `www.bing.com`; `en.wikipedia.org` as a floor; for news, Bing News and `news.google.com`; for programming, `api.stackexchange.com`, `hn.algolia.com` and GitHub's repository search on `api.github.com` | The query text (at most 400 characters, never a credential), and the backend's IP address | **Settings › Admin › Capabilities › Web search**, or use your own SearXNG, Brave Search API or Tavily |
| Web search with your own provider | Your SearXNG address, `api.search.brave.com`, or `api.tavily.com` | The query text, and the API key for Brave and Tavily | The same switch |
| **Reading pages** | The first three result pages of a search, and any URL the model fetches | A GET request. The model's fetches carry `User-Agent: Atelier WebFetch`; the readings of result pages carry a browser-like user agent. What comes back goes to the model. | Fetching: **Settings › Admin › Capabilities › Web fetch**. Reading result pages goes with Web search. |
| **Connectors** | The address of each HTTP or SSE connector you added; stdio connectors are programs on the backend that may contact anything themselves | The tool arguments the model chose, plus the tokens or headers you configured | Disable or remove the connector, switch it off for a chat, or set its tools to **Block** |
| **Desktop update check** | `updates.atelierhq.dev` (a Cloudflare Worker over an R2 bucket), or the server's `/updates` when you use one | A GET for `<stable or beta>/latest.yml` (`latest-mac.yml`, `latest-linux.yml`) with `User-Agent: electron-builder`, and on the public feed a `noCache` query parameter holding the current time; your IP. When an update exists, also its `.sig` file and the package. | Yes: **Settings › System › Check for updates automatically**, or `ATELIER_UPDATE_FEED=off` to remove the public feed (a copy connected to a server still asks that server). |
| Server version check | `updates.atelierhq.dev/stable/latest.yml`, or `api.github.com` with `ATELIER_UPDATES_REPO` | A GET, only when an admin opens **Settings › Admin › Server** (at most every 10 minutes) or presses **Check now** (every time) | `ATELIER_UPDATE_FEED=off` on the server, with `ATELIER_UPDATES_REPO` unset |
| Desktop updates from your server | `api.github.com` (releases of `ATELIER_UPDATES_REPO`) and the release download | Your `ATELIER_UPDATES_TOKEN` to GitHub's API | Leave the two variables unset |
| **GitHub** (Codespaces, Cloud) | `github.com`, `api.github.com`, and the GitHub tunnel used by `gh codespace ssh` | Your GitHub token; the commands and files of a codespace you work in | Do not connect GitHub in **Settings › Cloud** |
| Skill and plugin installs | `api.github.com`, `codeload.github.com` | An unauthenticated request for the repository you named | Do not install from GitHub |
| **Provider sign-ins** | ChatGPT Plan: `auth.openai.com`, `chatgpt.com`. GitHub Copilot: `github.com`, `api.github.com`. OpenRouter: `openrouter.ai`. Connectors with OAuth: the connector's own sign-in server | The sign-in exchange; for ChatGPT Plan also a usage request for the limits display | Do not sign in |
| ChatGPT Plan model list | `registry.npmjs.org`, besides `chatgpt.com` | A GET of the `@openai/codex` package's latest metadata, to learn the current Codex version the model list is asked with, at most every 6 hours. Nothing about you. | Do not use ChatGPT Plan |
| **ChatGPT Chat** | `chatgpt.com`, in a hidden browser window | Your messages and attachments typed into the page, plus everything the chatgpt.com page itself loads | Do not use that provider. **Remove** it from **Settings › Admin › Providers** to clear its browser session |
| Code Browser pane | The pages you open in it, and their icons | Ordinary page requests | Do not open pages in it |
| Finding servers on your network | The private /24 networks of this computer, port 7340 (first-run screen only) | `GET /api/health` | It runs only on the **Connect to a server** form |
| Your Atelier server | The server you connected the desktop app to | Everything you do in the app | Choose **Run on this computer** |
| SSH hosts and codespaces | The host you connect to | The runner program (uploaded once), the commands, and the file contents the agent reads there | Do not connect |
| Commands the agent runs | Whatever they contact (`git push`, `npm install`, `curl`) | Whatever the command sends | Your permission mode and rules |
| Git actions in the Code panel | Your Git remote for **Push**; GitHub, through `gh`, for **Open pull request** | What `git push` and `gh pr create` send, with the credentials those programs already have | Do not use those buttons |
| Fonts, scripts, images, analytics, crash reports | none | none | |

## Model providers

The provider receives the whole request each turn, so it receives whatever is in the conversation: your words, text of files
the agent read, output of commands it ran, images and files you attached, and your standing instructions and memory.
That includes everything in a long conversation, again on each turn (providers may cache it).

- A **local** provider (Ollama, llama.cpp, LM Studio) on this computer or your network sends nothing further.
- **Anthropic** and **OpenAI** receive your API key in a header.
- **OpenRouter** requests carry `HTTP-Referer: https://atelierhq.dev` and `X-Title: Atelier` (also sent as `X-OpenRouter-Title`),
  naming the app.
- **ChatGPT Plan** requests carry `originator: atelier`, `User-Agent: Atelier`, your ChatGPT account id, a session id and a
  random installation id that Atelier created when you signed in.
- **GitHub Copilot** requests present themselves as the Copilot Chat extension of VS Code (`editor-version`,
  `user-agent: GitHubCopilotChat/…`), because its API refuses clients it does not know.
- Which model is used where: the chat's model answers; the **Small model** (**Settings › Admin › Models**; unset means the
  chat's own) writes titles and compaction summaries, runs memory updates and answers questions about fetched pages; Auto
  mode's reviewer is the session's own model, or the small model when the session runs on ChatGPT Chat.

## Web search and fetch

- Built-in search sends the query to the web engines (DuckDuckGo, Brave, Bing) "as a browser would": on the desktop through
  Chromium's network stack, on a server from the server's own address. The news feeds get plain requests with a browser's
  user agent; Wikipedia, Stack Exchange, Hacker News and GitHub get plain requests that name themselves `Atelier
  (self-hosted assistant)`. The engines see the backend's address and the query, not your name or account.
- Your own SearXNG keeps queries off third parties; Brave Search API and Tavily receive the query and your key.
- Queries are refused if they look like a credential or contain one of your stored secrets. Search results are cached in memory
  for ten minutes (two when the model asks for a freshness window).
- Fetching refuses this machine, link-local and (unless an admin allows them) private network addresses. See
  [Security](/security/#web-fetch-and-private-networks).
- With a prompt, the fetched page is given to the small model, which answers from it. The page therefore reaches that
  model's provider.

## Update checks

**The desktop app** asks for `latest.yml` (`latest-mac.yml` on macOS, `latest-linux.yml` on Linux) in the `stable` or `beta`
folder of the feed. It does so when its backend starts, after you sign in to a server, and every 5 minutes.

- The request carries your IP address, the path (which names the channel and the operating system) and electron-updater's
  headers, including `User-Agent: electron-builder`. On the public feed it also carries a `noCache` query parameter that
  holds the current time (the server's feed gets none, because it is asked with your sign-in token). Atelier adds no
  account, device id or install id, and the request does not carry the app's version. The feed's operator sees ordinary
  request logs; what it does with them is outside the app.
- When a newer version exists, the app fetches the package's `.sig` file and the package. The `.sig` request, and on macOS the
  package, go through the app's own network stack, whose user agent typically names Atelier, its version and Electron's.
- **Where it asks.** Connected to a server, first the server's own `/updates` feed (with your sign-in token, sent to that
  server only); if the server offers none (it answers 404), the public feed. On **Run on this computer**, the public feed.
- **Turning it off.** **Settings › System › Check for updates automatically** is on by default. Off, the app asks no feed
  anything by itself; **Check now** still looks. The environment variable `ATELIER_UPDATE_FEED=off` only removes the public
  feed (a copy connected to a server still asks that server), so the switch is the way to stop automatic checks. See
  [Updates](/updates/#turning-the-check-off).

**The server** asks nothing by itself. It looks up the newest version only when an admin opens **Settings › Admin › Server**
(at most every 10 minutes, a failed lookup after one minute) or presses **Check now** (every time). See
[Updates](/updates/).

## GitHub

- A GitHub token you save in **Settings › Cloud** (a personal access token or a device-flow sign-in) is stored encrypted and
  used only for Codespaces: listing them, starting them, and `gh codespace ssh`.
- Skill and plugin installs read public repositories with no sign-in.
- The commands an agent runs in a codespace, and the files it reads there, go to your model provider like any other tool
  result.
- A GitHub Copilot provider signs in with GitHub's device flow and exchanges the token for Copilot access; the token is
  stored encrypted.

## ChatGPT Chat

ChatGPT Chat is an experimental, desktop-only provider that types your messages into a chatgpt.com page in a hidden window
and reads the replies back. What the page loads and sends is chatgpt.com's own behavior, outside Atelier. Its conversations
are ChatGPT's **temporary chats** by default (they stay out of your ChatGPT history and memory); the provider's ⋯ menu in
**Settings › Admin › Providers** has a **Temporary chats** switch to turn that off. The window's cookies and sign-in are
kept in the app's profile folder. See [ChatGPT](/chatgpt/).

## Telemetry and crash reports

None. Atelier sends no usage analytics, tracking, crash reports or error reports to anyone. What was checked: the source and
the dependency lists of the desktop app, server, core, interface and protocol packages for analytics and error-reporting
libraries (Sentry, PostHog, Mixpanel, Amplitude, Segment, Google Analytics, Plausible, Datadog, Bugsnag, Rollbar, LogRocket,
FullStory, Hotjar, Statsig, LaunchDarkly, Umami, Matomo) and for a crash reporter, and found none. The interface loads no fonts,
scripts or images from other hosts (its Content-Security-Policy would not allow it), and the built pages contain no external
address. The runner program, which runs your commands, contains no network code of its own. The documentation site and the
product website are separate from the app.

With no chat running, the only things Atelier contacts by itself are the desktop update check above and the health and
model-list requests to the providers you added (for ChatGPT Plan, also the version lookup and the usage request in the
table). Opening the **Connect to a server** form scans your local network once.

## The request log

**Settings › Admin › Developer › Record provider requests** is **off by default**. While on, the backend keeps the last 100
requests it sent to providers, **in memory only**: method, address (credential-looking query parameters replaced),
request headers (any header named like auth, token, key, secret, cookie or password replaced), the request size in bytes,
the status and the time taken, and for a failed request up to 4,096 characters of the error response. Prompts and replies
are never recorded. Only admins see it. It is cleared by **Clear** and when the backend restarts. Nothing is written to disk
or sent anywhere. Connector logs in the same page show what a connector printed, with credentials masked.

## Where your data is stored

Conversations, files, memory and settings are stored on the backend: in `~/.atelier/data` on your computer, or in the
server's volume. Provider keys and tokens are encrypted; conversations are not. The full map of folders and files is in
[Data and files](/data-and-files/).

- **Settings › Privacy › History › Keep conversations**: **Keep everything** (default), or delete conversations untouched for
  30, 90 or 365 days (pinned ones stay). The sweep runs every 24 hours while the backend is running, the first one 24 hours
  after it started, so an app that is quit within a day of starting never runs it.
- **Settings › Privacy › Your data**: **Export** (a zip of your conversations, projects, artifacts, files and memory) and
  **Delete all…** (every conversation, after typing `DELETE`).
- **Memory** (**Settings › Memory**): **Generate memory from chats** and **Search and reference chats** are on by default;
  **Include sensitive topics in memory** is off. Memory is stored per account; building it sends chat content to the small
  model's provider. See [Memory](/memory/).

### Temporary chats

A temporary chat (the ghost button on the new-chat page, File › New Temporary Chat, ⇧⌘N / Ctrl+Shift+N) never appears in the
sidebar, lists, search or the Artifacts page, and is deleted with its files and artifacts when you leave it or close its
window; a sweep removes any left behind after a day, and the rest when the backend starts again, unless a window reopens
them. Nothing of it is saved to memory. It is still **sent to the model
provider** like any chat. **Settings › Privacy › History › Temporary chats** chooses between **Don't save (default)** and
**Start fresh**, which also keeps memory, personal instructions, your name and project context away from the model (admin
instructions and safeguards still apply). Temporary chats exist in Chat only, and are not in an export.

## Who can see what

| Who | What they can see |
|---|---|
| The model provider | Everything sent to it (first table). |
| Search engines and pages | Queries, and the backend's IP address and user agent. |
| The update feed's operator | The IP address, time and path of update requests. |
| A server's admins, in the app | The account list, aggregate usage across accounts (not per person), and connector logs. Not conversations, memory or files. See [Accounts](/accounts/#what-admins-can-and-cannot-see). |
| Whoever runs the server's host | The whole data folder: conversations and files in plain form, secrets decryptable with the key in the same volume unless you set `ATELIER_SECRET_KEY` elsewhere. |
| Your other signed-in devices | Your conversations, unless you turn off [Remote control](/remote-control/). |
| Other people with accounts | Nothing of yours. |
