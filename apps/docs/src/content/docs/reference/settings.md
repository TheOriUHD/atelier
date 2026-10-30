---
title: Settings reference
description: Every setting in Atelier by page, with what it does.
editUrl: false
---

<!-- GENERATED from packages/ui/src/features/settings/search-index.ts by settings-reference.test.ts. Do not edit; run `pnpm docs:generate`. -->

This page lists every row in Settings, with the label and description the app shows. Open Settings with ⌘, (Ctrl+,) and
use the search box at the top to jump to a row. Pages under **Admin** change how Atelier behaves for everyone on this
backend; on the desktop app running on your own computer you are the admin. Pages and rows the signed-in person may not
see are hidden in the app.

## Settings › General

| Setting | What it does |
|---|---|
| **Theme** | Light, Dark, or System (follow the operating system). |
| **Chat font** | Atelier Serif, Atelier Sans, System, or OpenDyslexic. |
| **Transcript text size** | Size of the conversation transcript text. |
| **Transcript width** | Maximum width of the transcript and composer columns. |
| **Motion** | Reduce animation in streaming responses and other interface elements. |
| **Default model** | New chats start with this model. “Server default” follows the one set for everyone. |
| **Notify me when a task finishes** | A system notification when a Cowork task ends while you’re in another window or app. |
| **Notify me when a task needs me** | A system notification when a Cowork task waits for your answer or permission. |

## Settings › Shortcuts

| Setting | What it does |
|---|---|
| **App shortcuts** | New chat, search, Settings, the sidebar and the screen lock. Change the keys or turn one off. |
| **Message box shortcuts** | Upload or add files and change effort. Send, new line, stop, / and @ always work the same. |

## Settings › Account

| Setting | What it does |
|---|---|
| **Profile photo** | PNG, JPEG, GIF or WebP, up to 5 MB. |
| **Full name** | Shown in the sidebar and to admins. |
| **What should Atelier call you?** | Used in the greeting and shared with the model. Your full name is used when this is empty. |
| **Instructions** | Preferences the model should keep in mind. They are added to the system prompt of every new chat. |
| **Your ATELIER.md** | Your own conventions and preferences for Code sessions and Cowork tasks, in Markdown. Every new one and its sub-agents read them; where a project’s ATELIER.md disagrees, yours win. |
| **Remote control** | Access your server sessions from other browsers and devices signed in to this account. Turning this off keeps sessions on their originating device, even when that session allows it. |
| **Personality** | Atelier, Technical, Relaxed or your own custom mode. Style only, not model identity. Applies to new conversations; response style stays independent. |
| **Response style** | How replies are written unless a chat asks otherwise. |
| **Username** *(only where it works)* | What you sign in with. |
| **Password** *(only where it works)* | Changing it signs you out on your other devices. |
| **Log out** *(only where it works)* | Ends your sign-in here. |
| **Server** *(only where it works)* | The Atelier server this app uses. Switch to another one, or to running on this computer. |
| **Setup** *(only where it works)* | Atelier runs on this computer. Switch to an Atelier server, or choose again. |
| **Log out of all devices** *(only where it works)* | Ends every sign-in to your account, including this one. |
| **Content safeguards** *(only where it works)* | Extra limits on what models write for you. Your administrator manages them. |
| **Active sessions** *(only where it works)* | Browsers and apps signed in to your account. |
| **Devices** *(only where it works)* | Computers running the Atelier app for your account. They lend their files and tools to your sessions. |
| **Screen lock** *(only where it works)* | Hides Atelier until you enter your PIN or password. Your data on this computer is not encrypted by it. |
| **PIN or password** *(only where it works)* | Asked for when Atelier starts and whenever you lock it. |
| **Lock when inactive** *(only where it works)* | Locks Atelier after this long without typing or clicking in any of its windows. |
| **Passkeys** *(only where it works)* | Sign in to this site with your device’s screen lock or a security key instead of your password. |
| **Connected sign-ins** *(only where it works)* | Other sign-ins for this account in a browser, such as Authentik or Google. |

## Settings › Privacy

| Setting | What it does |
|---|---|
| **Keep conversations** | Conversations untouched for longer than this are deleted once a day. Pinned ones stay. |
| **Temporary chats** | Temporary chats never appear in your history and are deleted when you leave them. Starting fresh also keeps your memory, personal instructions and projects away from the model. |
| **Export your data** | A zip with all your conversations (as JSON and Markdown), projects, artifacts, files and memory. |
| **Delete all conversations** | Every chat, Cowork task and Code session, with its messages, files and artifacts. Projects stay. This can’t be undone. |

## Settings › Memory

| Setting | What it does |
|---|---|
| **Search and reference chats** | Let Atelier search for relevant details in your past chats. |
| **Generate memory from chats** | Let Atelier remember details from your chats. |
| **Include sensitive topics in memory** | Let Atelier remember details about sensitive topics like health or religious beliefs. |
| **Import memory from other AI providers** | Bring what another assistant remembers about you into Atelier. |
| **Your memory** | What Atelier remembers about you, your topics, areas, people and projects. Open an entry to change or delete it. |

## Settings › Usage

| Setting | What it does |
|---|---|
| **Your usage** | Requests, tokens and cost of your chats, Cowork tasks and Code sessions. |
| **Tokens by day** | A chart of tokens per day, split by Chat, Cowork and Code. |
| **By model** | Tokens, cost and average output speed of each model. |
| **Prices** *(admins only)* | Dollars per million tokens, per model, in place of the provider’s list price (Anthropic and OpenAI models without one here use it). A price counts for requests made after it is set. |

## Settings › Code

| Setting | What it does |
|---|---|
| **Always-allowed actions** | What you approved with “Always allow” in a permission prompt. These rules apply in your Code and Cowork sessions and to connector tools in chats, on top of the rules your admin set. |
| **Code appearance** | Syntax highlighting for code: one theme for the light app theme, one for the dark. |
| **Default transcript view** | How Code sessions open: tool calls as usual, with thinking expanded, or with every call’s details expanded. Each session can switch in its header. |
| **Suggested replies** | After a reply in Code or Cowork, a short guess at your next message shows in the message box; Tab puts it in, typing sets it aside. The small model (or the conversation’s) writes it from your recent messages and the reply. |
| **Code font** | A monospace font installed on your computer, for code and diffs. |
| **Commit author name** | Used for commits you make from the Code view. Empty uses the repository’s git config. |
| **Commit author email** | Used for commits you make from the Code view. Empty uses the repository’s git config. |
| **Interface font** | Font for menus, the sidebar and panels. |

## Settings › Folders

| Setting | What it does |
|---|---|
| **Folders** | Folders you opened for Code sessions. Their tools run on the computer the folder is on, and can run any command there as you. |
| **SSH connections** | Remote machines you work on over SSH: their host, port and key, and whether Atelier keeps a password for them. |

## Settings › Cloud

| Setting | What it does |
|---|---|
| **GitHub** | Codespaces run on your GitHub account. Atelier keeps its token encrypted and uses it only for Codespaces. |
| **GitHub OAuth app** *(admins only)* | The client id of an OAuth app with device flow enabled, so people can sign in with GitHub. Without one, they connect with a personal access token. |
| **Codespaces** | Cloud machines on GitHub for Code sessions. Each one stops after its idle timeout and runs at most 12 hours at a time. |

## Settings › Your models

| Setting | What it does |
|---|---|
| **Found on this computer** *(only where it works)* | Model servers answering on their default ports here (Ollama, llama.cpp, LM Studio). |
| **Models on your computers** | Model servers and ChatGPT Chat on your own computers. Only you see their models, and only while that computer is connected. |
| **Add model server** | Ollama, llama.cpp, LM Studio or another OpenAI-compatible server on this computer or its network. |
| **ChatGPT Chat on this computer** *(only where it works)* | Your own ChatGPT, through the ChatGPT window of the desktop app here. Experimental. |

## Settings › Skills

| Setting | What it does |
|---|---|
| **Skills** | Instructions and scripts that sessions load when a task needs them, or that you start with /name. They come from the folder a session works in, from the skills installed for everyone, and from plugins. |
| **Install from GitHub** *(admins only)* | A repository or a folder in one: owner/repo, owner/repo@ref/path or a github.com URL. Skills installed with other tools, like npx skills, show up here by themselves; remove those with the tool that installed them. |

## Settings › System

Desktop app only.

| Setting | What it does |
|---|---|
| **Version** | The version of the desktop app you are running. |
| **Updates** | Where an update stands, with **Check now**, which looks for a new version right away. See [Updates](/updates/). |
| **Check for updates automatically** | Atelier asks for the newest version when it starts and every 5 minutes. Off: it only looks when you press Check now. |
| **Update channel** | Beta gets new versions before they’re released as stable. |
| **Launch at login** | Open Atelier when you sign in to this computer. |
| **Enable computer use** *(only where it works)* | Let the assistant in Code and Cowork see and use the apps you allow on this computer. |
| **Unhide apps when Atelier finishes** *(only where it works)* | Apps hidden while Atelier had full control of your screen come back when it stops. |
| **How Atelier uses the apps you allow** *(only where it works)* | Background: asks you for each app, then works in one app at a time in the background, without your mouse and keyboard, while you keep working. Full control: takes over your computer as it is, any app but your denied ones, without asking. |
| **Denied apps** *(only where it works)* | Atelier never uses these apps: asking for them is turned down without a question. |
| **Apps allowed for good** *(only where it works)* | Apps you allowed with “Always allow on this computer”; every session may use them. |
| **Accessibility** *(only where it works)* | macOS lets Atelier use the mouse and keyboard, and read what is under them, with this permission. |
| **Screen recording** *(only where it works)* | macOS lets Atelier take screenshots of the apps you allow with this permission. macOS asks again from time to time. |
| **Folders for sessions without one** *(only where it works)* | The server can make a new, empty folder on this computer for each session you start without a folder. |
| **SSH hosts reached from here** *(only where it works)* | Hosts the server may connect to from this computer, with its ssh, keys and known hosts. Choosing a host here adds it. |
| **Connectors that run a program here** *(only where it works)* | Your connectors the server may start on this computer. Adding or importing one here adds it; a changed program asks again. |
| **Addresses reached from here** *(only where it works)* | Model servers and connectors on this computer or its network that the server may reach through it. |
| **ChatGPT Chat on this computer** *(only where it works)* | Your ChatGPT Chat models answer through the ChatGPT window of this app. |
| **Your instructions and skills from this computer** *(only where it works)* | Sessions in folders on this computer use your ~/.claude/CLAUDE.md, ~/.atelier/ATELIER.md, skills, agents, commands and Claude Code settings here. |
| **Data folder** | Where Atelier keeps its data on this computer. |

## Settings › Admin › Providers

Admins only.

| Setting | What it does |
|---|---|
| **Detected on this machine** | Local servers on their default ports and API keys in the environment. |
| **Add provider** | Connect Ollama, llama.cpp, LM Studio, Anthropic, OpenAI, GitHub Copilot, OpenRouter, a ChatGPT plan or any OpenAI-compatible endpoint. |

## Settings › Admin › Models

Admins only.

| Setting | What it does |
|---|---|
| **Default model for everyone** | New chats, Cowork and Code sessions start with this model unless people choose their own. |
| **Small model** | Writes titles, summaries and memory. “Same as the chat” uses each chat’s own model. |
| **Available models** | Rename, hide or favorite models, and override what was detected about them. |
| **opus** | Which of your models answers when an agent file asks for `opus`. See [Models](/models/). |
| **sonnet** | Which of your models answers when an agent file asks for `sonnet`. |
| **haiku** | Which of your models answers when an agent file asks for `haiku`. |
| **fable** | Which of your models answers when an agent file asks for `fable`. |

## Settings › Admin › Capabilities

Admins only.

| Setting | What it does |
|---|---|
| **Web search** | Let chats look things up on the web. Nothing to set up: Atelier searches by itself. |
| **Search engine** | Built-in search needs no account or key. Use your own SearXNG, Brave Search or Tavily to keep searches on a service you choose. |
| **Test search** | Searches are sent to the engine that answers, as a browser would send them; news searches also go to Bing News and Google News, and programming searches to Stack Overflow, Hacker News and GitHub. The server or this computer then opens the first result pages, and your own SearXNG keeps searches off third parties. |
| **SearXNG URL** | Base URL of your instance. JSON output must be enabled in its settings.yml. |
| **Search API key** | Stored encrypted in the secret store, never in settings files. |
| **Web fetch** | Let chats read web pages and documents by URL. |
| **Instructions for every conversation** | What models are told in every Chat, Cowork and Code conversation, for every account, ahead of anything a person or project asks. Applies to new conversations. Code and Cowork also follow the system AGENTS.md (Admin › Code). |
| **Let people edit memory by hand** | Adds Edit to every memory entry in Settings › Memory, for changing its title, summary and details directly. Without it, memory changes only through Atelier. |
| **Extra safeguards for everyone** | Off by default: models then follow only their own and their provider's rules. When on, the categories below apply to every conversation, except for people Users sets otherwise. |
| **Explicit sexual content** | Erotica and graphic sexual material. Sex education and health questions are still answered. |
| **Hate and violent extremism** | Content that demeans people for who they are, and extremist propaganda. Every political view can still be discussed and argued. |
| **Harassment of private people** | Threats and insults aimed at real private people, and help finding where they live or work. |
| **Self-harm** | No methods or doses for someone who seems at risk; the model answers with care and points to help. |
| **Younger people** | For accounts that may belong to someone under 18: no romantic role-play, and no instructions for alcohol, drugs or risky stunts. |
| **Crisis resource** | A helpline or service the self-harm safeguard can point to, such as a national number. |

## Settings › Admin › Code

Admins only.

| Setting | What it does |
|---|---|
| **Default permission mode** | The mode new Code sessions and Cowork tasks start in. People can switch it in each Code session. |
| **Allow rules** | Tool calls that match run without asking. |
| **Ask rules** | Tool calls that match always ask first, in every mode. |
| **Deny rules** | Tool calls that match are blocked, in every mode. |
| **Additional directories** | Folders sessions may use besides their workspace. Reaching anywhere else asks first. |
| **Ultracode** | The last effort level in Code, on every model except ChatGPT Chat, which brings its own stops: the model plans, has up to 24 sub-agents per request investigate and check its work, and uses far more tokens. Off: sessions that chose it run at Extra. |
| **Claude Code compatibility** | Also read what projects and your home folder keep for Claude Code: CLAUDE.md and rules, .claude/settings.json permission rules and hooks, and the skills, commands, agents and plugins in .claude folders. |
| **Hooks** | Commands that run at points of every Code session and Cowork task on this computer, in Claude Code’s settings format. Projects bring their own in .atelier or .claude settings; people’s own devices run only those. |
| **Keep checkpoints for** | How long file versions are kept for rewinding Code sessions. |
| **System AGENTS.md** | Instructions every Code session and Cowork task follows, for every account. Projects add their own CLAUDE.md and AGENTS.md. |

## Settings › Admin › Connectors

Admins only.

| Setting | What it does |
|---|---|
| **Connectors** | MCP servers that give sessions tools from other services. People turn them on in each session, and their tools ask before they run unless you allow them here. |

## Settings › Admin › Plugins

Admins only.

| Setting | What it does |
|---|---|
| **Installed plugins** | Bundles of skills, commands and agents. Turning one off takes what it brings out of every session. Plugins installed with Claude Code can only be turned on or off here. |
| **Add from a marketplace** | A GitHub repository with a .claude-plugin/marketplace.json, as Claude Code uses: owner/repo or a github.com URL. |

## Settings › Admin › Keys & secrets

Admins only.

| Setting | What it does |
|---|---|
| **Keys and secrets** | API keys and tokens, kept encrypted. Settings refer to them as ${secret:id}; their values never leave the backend. |

## Settings › Admin › Users

Admins only.

| Setting | What it does |
|---|---|
| **Users** | Everyone who can sign in, with their role and status. |
| **Waiting for approval** | People who signed up themselves. Approve them to let them in. |
| **Invite codes** | Each code creates one account and expires after 7 days. Only the last group of a code is shown here. |

## Settings › Admin › Server

Admins only.

| Setting | What it does |
|---|---|
| **Server version** | The version of Atelier this server runs. |
| **Update server** | Installs the newest version of Atelier on this server. It restarts, and everyone reconnects by themselves. |
| **Sign-up** | Invite only: admins add people or give them invite codes. Open: anyone who can reach this server can create an account, which waits for an admin to approve it. |
| **Single sign-on** | Lets people sign in to this server in a browser through an OpenID Connect identity provider, such as Authentik, Keycloak or Google. The desktop app keeps signing in with passwords. |

## Settings › Admin › Developer

Admins only. Admins only. These are diagnostic tools.

| Setting | What it does |
|---|---|
| **Record provider requests** | Lists the requests sent to model providers: address, status, timing and headers with credentials masked. Prompts and replies are never recorded. |
| **Connector logs** | What each connector printed, and its connections and failures. Credentials are masked. |
| **Reload connectors and extensions** | Reconnects every connector and reads skills, commands, agents and plugins again. |
