---
title: Chat
description: How conversations work in Atelier Chat, from the message box, attachments and replies to Research, temporary chats, the sandbox and failure messages.
---

![A conversation in Atelier's Chat](/img/chat-2560.webp)

Chat is for conversations: questions, writing, thinking something through, looking at a file or a web page, building a
small page or diagram. Use [Cowork](/cowork/) for a longer task in a folder and [Code](/code/) for a codebase. All three share the same message box, model picker and effort control.

## The sidebar

Chat's sidebar, top to bottom:

- **The header.** A button that hides the sidebar (⌘B or Ctrl+B), the **Atelier** name, and the **Chat** and **Code**
  tabs. Cowork is a page inside Chat, not a tab.
- **Search** opens the [search palette](/sessions/#search) (⌘K or Ctrl+K).
- **New**, **Projects**, **Artifacts**, **Cowork** and **Customize** open those pages. **More** unfolds to
  **Settings**, **Usage** and **Keyboard shortcuts**.
- **Pinned** lists the projects and conversations you pinned, the most recently pinned first.
- Below that, your chats and Cowork tasks, newest activity first, under **Today**, **Yesterday**, a date for each earlier
  day of the past week, **Previous 30 days** and **Older**. The sidebar loads at most 200 chats
  and 200 Cowork tasks. [Search](/sessions/#search) still finds older chats but does not search Cowork tasks.
- When you have both chats and Cowork tasks, a **Filter recents** button on the first group shows **All**, **Chats** or
  **Cowork tasks**.
- At the bottom: update and version notices (see [Updates](/updates/)), then your profile menu with **Settings**, the
  theme and **Log out**, or **Lock Atelier** when Atelier runs on this computer.

Each row shows its title, a document icon when it made something (**Made an artifact** for a chat, **Made files** for a task) and a dot while it runs. Hover a
row, or right-click it, for its menu: **Pin**, **Rename**, **Add to project ›**, **Remove from project** and **Delete**.
Cowork tasks get the fuller session menu described in [Sessions](/sessions/). On a phone-sized window the sidebar
slides in over the page.

A chat is titled from your first message by the [small model](/models/) (the chat's own model
when none is set). If neither answers, or with ChatGPT Chat, the title is the first words of your message.

## Starting a chat

**New** opens the chat home with a message box. Until you have five
chats, example ideas sit under the box (**Write**, **Learn**, **Code**, **Life stuff**, **Surprise me**); picking a prompt puts it in the box for you to edit.

Below the box, a **Project** menu offers **No project**, one of your [projects](/projects/), or **New
project…**, and the [model picker and effort control](#model-and-effort) sit on the right. The ghost button at the top
right starts a [temporary chat](#temporary-chats).

The first message creates the chat. If you turn the home into a folder task with **+ › Add folder**, the footer reads
**Cowork in** and the folder, and sending starts a [Cowork](/cowork/)
task instead.

## The conversation header

The title at the top of a chat opens a menu: **Pin** (or **Unpin**), **Rename**, **Delete**, and on a server account
**Remote control: On** or **Remote control: Off**, which decides whether other devices signed in to your account can see
and drive this conversation (see [Remote control](/remote-control/)). If remote control is off for the whole
account the item reads **Remote control disabled in account**.

## The message box

### Sending

| Key | What it does |
|---|---|
| Enter | Sends. |
| Shift+Enter | New line. |
| Esc | Stops the reply, only while the box is empty. |

You can type while the model works. A message you send then waits under the conversation and joins at the model's next step. It has **Take back and edit** (its text and files return to the
box) and **Send now**, which cuts the current step short. **Stop** leaves nothing waiting and puts the
waiting texts back in the box.

### The + menu

The **+** button at the left of the footer (**Add files and more**):

| Item | What it does |
|---|---|
| **Upload or add files** (⌘U / Ctrl+U) | Opens the file picker. |
| **Add folder ›** | New chats only. Recent folders, **Open folder…** (desktop app) or **Use a codespace…**. Turns the chat into a Cowork task in that folder. |
| **Skills ›** | Lists the skills you can start; picking one puts `/name ` in the box. See [Customize](/customize/). |
| **Connectors ›** | Switches [connectors](/connectors/) on or off for this conversation, with a count. A connector that is not connected says **Not connected**; one an admin switched off is greyed out. |
| **Add plugins** | Admins only. Opens **Customize**. |
| **Research** | A switch, shown while web search is on. See [Research](#research). |

A connector's tools ask before they run, unless a rule allows them. The prompt has **Deny**, **Always allow** and **Allow once**; the chevron beside **Always allow** offers **Allow in this
conversation** and **Always allow everywhere**. What you approve with **Always allow** is listed, and can be removed, in
**Settings › Code › Always-allowed actions**. Web search and fetch, memory and the other built-in tools do not ask. See
[Permissions](/permissions/).

### Slash commands

Typing `/` as the first character opens a list: three built-in commands in a conversation (the new-chat home has only `/model`), then every skill and
custom command you may start.

| Command | What it does |
|---|---|
| `/model` | Opens the model picker. |
| `/clear` | Starts a new chat (in a project chat, back to the project's page). |
| `/btw [question]` | Asks a side question. See below. |

Arrow keys move through the list, Enter or Tab picks, Esc closes it. Names that start with what you typed come first,
then names that contain it. `/compact`, `/loop` and `/rewind` are not offered in
Chat; the full list for every mode is in [Keyboard shortcuts](/shortcuts/#slash-commands).

### Side chats with /btw

`/btw what does this error mean?` opens a side chat in a panel on the right and answers there, while the main
conversation carries on. The side chat:

- reads the conversation so far, including the reply in progress, and answers at Low effort;
- can search the web, fetch pages, use read-only connectors and look at your memory and past chats, but changes nothing
  and has no Bash or Read;
- adds nothing to the main conversation or its context.

Each side chat is a tab with its own message box; **×** closes the tab and deletes that side chat. **+** starts
another. Side chats come back after a reload and are deleted with their chat. `/btw` alone opens an empty one. It closes an open
artifact panel to make room.

### Drafts

Text you have typed and not sent stays in its box when you leave, even after a reload. Each conversation keeps its own draft; the new chat and the
new Cowork task share one. Drafts keep the text and the attachments that have finished uploading, are stored in this browser
or app for your account only (they do not follow you to another device), and are dropped after 30 days, or when more than
50 boxes have drafts. A temporary chat keeps none.

## Attachments

Add files by dropping them on the conversation, pasting them, pressing ⌘U or Ctrl+U, or
using **+ › Upload or add files**. Each file becomes a tile above the box with its line
count (text) or size and a **×**. Click a tile to preview it: images open full size, text shows the first 200,000
characters, PDFs open in a viewer. You cannot send while a file is uploading,
and a file that failed to upload is left out of the message.

### What a model receives

| File | What the model gets |
|---|---|
| **Images** (PNG, JPEG, GIF, WebP) | The image, if the model can see. A model without vision gets only the note "An image was attached, but this model cannot view images.", and the tile shows a warning. |
| **PDF** | The file itself, for models that take PDFs natively (the Anthropic and OpenAI models Atelier knows, and ChatGPT Chat). For every other model, the PDF's text layer, page by page. A scan with no text layer yields no text. |
| **Text and code** (`.txt`, `.md`, `.csv`, `.json`, `.html`, `.py`, `.svg` and similar) | The text, inside a document block with the file name. Text beyond 400,000 characters is cut off. |
| **Anything else** (Word, Excel and PowerPoint files, archives, audio, video) | Nothing readable: the model is told "Attached file … cannot be read by this model." Put such files in a Cowork task's folder instead. |

Limits:

- **32 MB per file.** A larger file gets the tile error "Larger than 32 MB". Atelier sets no limit on the number of files; providers do (below).
- Before each request Atelier fits the images in the whole conversation to what the provider accepts: it shrinks an
  image that is too large, and leaves out the oldest images (telling the model) when a request would hold too many.
  Anthropic, GitHub Copilot and OpenAI-compatible endpoints take images up to 8,000 pixels and 5 MB each, 100 per
  request and 24 MB in all (and 2,000 pixels each past 20); the OpenAI API takes 20 MB each, 500 per request and 40 MB in all;
  Ollama and llama.cpp have no count limit and get images up to 4,096 pixels and 25 MB each.
- **ChatGPT Chat** (the experimental browser-session provider, desktop only) takes the last 10 files of a message, 20 MB
  each. See [ChatGPT](/chatgpt/).

### Reply to a passage

Select text in a conversation and press the **Reply** button that appears above it. The passage waits in the
box as a quote card (remove it with **×**) and goes with your next message. You can quote up to 5 passages per message, each cut to 4,000 characters.

## Model and effort

The model picker, at the right of the footer, groups models by provider and notes context size, vision and reasoning. Next to it is the effort control (⌘⇧E or Ctrl+Shift+E): **Low** to **Max**, starting at the
level marked Recommended, plus a **Thinking** switch on models that can only think on or off. Both can change mid-conversation and apply from the next message. A new chat starts on your **Settings › General › Default
model**, else on the admin's **Default model for everyone**, else on the first available model. See [Models](/models/) and [Effort and thinking](/effort/).

## Research

**Research** is a per-conversation switch in the **+** menu, **off** by default. While it is on, a
**Research** chip appears beside the **+** button (click it to switch off). You can switch it on before the
first message.

While it is on, every message carries a short note asking the model to search broadly, read the
strongest sources in full, cite the ones it relies on, and say where they disagree or the evidence is thin. It uses the ordinary [web search and fetch](/web-search/) tools, not a separate engine. Expect more
searches, more tokens and a longer wait.

The switch only appears while an admin has **Settings › Admin › Capabilities › Web search** on, and it exists in Chat and
in project chats, not in Cowork or Code.

## What you see while it works

Under the conversation a status line shows what is happening, the time since you sent your message and, when known, the
reply's output tokens and the context:

```text
Writing…   12s · ↓ 842 tokens · context 25k / 128k
```

The context figure turns amber from 75% of the window and red above 90%. What the first part says:

| Message | Meaning |
|---|---|
| **Thinking…**, **Writing…**, **Searching the web…**, **Reading the web…**, **Running a command…**, **Using a connector…** | What the model is doing. |
| **Waiting for the model** or **Waiting in line for the model · 2 requests ahead** | Another request is using the same model server. A model server on your computer or network answers one request at a time. |
| **Loading the model**, then **Still loading the model, a large one takes a while** (after 20 s) and **Still loading, this is taking longer than usual** (after a minute) | A local model is being loaded into memory. |
| **Reading the conversation**, then **Still reading, a long conversation takes a while** and **Still reading, this is taking longer than usual** | A local server is processing the prompt before its first word. |
| **Waking your codespace** | A sleeping codespace is starting. |
| **Compacting conversation…** | See [Long conversations](#long-conversations). |
| **Connection interrupted. Retry 3 of 10** | See below. |
| **No output for a minute, it may be writing a long call**, then **Still no output, the model may have stalled. Stop ends the turn** (2 minutes after the first line) and **No output for ten minutes, the model has probably stalled** (10 minutes after it) | The model's server has sent nothing; a model writing a long tool call is silent too. Press **Stop** to end the turn. The message clears with the next output. |
| **Thinking**, then **Still thinking, a high effort setting can take a few minutes** (after 2 minutes) and **Still thinking, this is taking much longer than usual** (after 10) | A model whose own service thinks before it answers (ChatGPT Chat at its higher settings). |

**Retries.** When the connection to a model drops, or the provider answers busy or unavailable, Atelier retries the same
request by itself, up to 10 times, and says **Connection interrupted. Retry n of 10**. The waits are 5, 10, 15 and 30 seconds, then 1, 2, 4, 8, 16 and 32 minutes, about 64 minutes in all. **Stop** ends it. Errors that retrying cannot fix (a rejected key, a missing model) are shown at once, and so is a
usage limit.

**A restart in the middle.** If Atelier or its server restarts while a reply is being written, the
conversation says **Atelier restarted and cut off this reply.** with a **Continue** button, which carries on from what
was already done instead of writing the reply again.

## Replies

Hover a message (always visible on a phone-sized window) for its actions:

- On **your message**: how long ago you sent it, **Previous version** and **Next version** arrows when it has versions,
  **Retry**, **Edit** and **Copy**.
- On **a reply**: **Copy**, **Retry**, the version arrows, how long ago it was written and the model's name with its
  output speed.

Click the age ("5 minutes ago") to see the exact date and time, and again to go back.

**Retry** asks again; **Edit** rewrites your message and asks again from there. Neither overwrites anything: each
makes a new version, and the version arrows switch between them. The conversation continues from
the version you are on.

What a reply can contain:

- **Code blocks** with syntax colors from **Settings › Code › Code appearance** and a
  **Copy** button.
- **Math** between `$…$` (inline) or `$$…$$` (display), typeset with KaTeX. Dollar amounts such as `$299` stay text.
- **Diagrams.** A `mermaid` code block renders as a diagram, with **Show source** and **Copy source**.
- **Links** open in your system browser. When the model searched the web it is told to link its sources inline and to
  end with a **Sources** list of the pages it used.
- **Images.** Click any image to see it fitted to the
  window; arrow keys step through the others, Esc closes.
- **Inline visuals and artifacts.** See below.

Tool calls and thinking are folded into one line that opens to the details (for example **Used WebSearch**). Memory and
past-chat lookups get lines of their own, such as **Saved a memory** and **Searched past chats**.

## Artifacts and inline visuals

When a reply builds something to keep (a page, a React component, an SVG, a diagram, a document, a program), it appears
as a card in the conversation. **Open** shows it in a panel beside the conversation, with a preview, the code and its
versions. Artifacts are sandboxed: they cannot reach your account, your storage or the network.

An **inline visual** is a smaller explainer or interactive widget drawn in the conversation, for
understanding rather than keeping. Hover it for **Reset visual**, **Download as HTML** and **Expand visual**.
The [Artifacts page](/artifacts/) describes both.

## The sandbox

Where Atelier can offer it, a chat gets two tools, **Bash** and **Read**, in a folder of its own that starts empty and is
kept. The model can clone a repository, run a script or a test, or check a file
without asking you each time. The sandbox is made the first time it is needed. A server whose compose file leaves out the `sandbox` service gives its chats no sandbox. Where it lives:

- **On a server**, in the separate `sandbox` container that comes with the compose file ([Self-hosting](/self-hosting/)):
  a Debian image with git, Python 3, Node.js, npm, build tools, curl, jq and ripgrep, limited to 2 GB of memory, 2 CPUs
  and 512 processes. It holds none of the server's data or secrets. A desktop app connected to a server uses the server's
  sandbox. Every account runs in the shared container as a Unix user of its own (256 by default), with home and chat
  folders that only that user can enter. The operating system enforces this: one person's commands cannot read, list, change or leave files in another's
  folders, and cannot become another user (no root, no `sudo`, no setuid programs). Accounts still
  share the container's CPU, memory, disk space, network and process list: another account's
  command lines show up in `ps`, so do not pass secrets as command-line arguments. See
  [Security](/security/#the-chat-sandbox).
- **In the desktop app on its own**, in a folder on your computer (`chat-sandboxes` in the [data folder](/data-and-files/)).
  On macOS the commands run inside the system sandbox: they can write only to that folder and to temporary folders, and
  cannot read your SSH and GPG keys, cloud, Kubernetes, Docker and package-manager credentials, keychains, cookies, the
  profiles of Chrome, Firefox, Arc and Safari, Mail, Messages or Atelier's own data. They can still read other files on
  your Mac.
  On Windows and Linux nothing confines the commands to the folder, so each command goes to the
  [Auto mode](/permissions/#auto-mode) reviewer first, and to you if the reviewer cannot decide.

Apart from that review, the sandbox asks no permission and follows fixed rules:

- **Read** works only inside the folder.
- **Bash** runs anything except commands that run as root (`sudo`), recursively delete or `find -delete` outside the
  folder, pipe a download into a shell, force-push, `git reset --hard`, `git clean -f`, `chmod -R 777`, write to a
  device, shut the machine down, format a filesystem or fork-bomb. The model is told "The
  sandbox doesn't allow this: the command …" and takes another way.
- A command stops after 2 minutes unless the model sets a longer timeout (10 minutes at most), output is cut at 30,000
  characters, and there are no background commands.
- Nothing in Atelier filters the sandbox's network access, which is how `git clone` and package installs work.

When a reply used the sandbox, **Continue in Cowork** appears under it and copies the conversation into a new Cowork task
in the same folder. It disappears when you write again, and the **×** hides it for good. Temporary chats do not offer it.

## Temporary chats

A temporary chat leaves no trace. Start one with the ghost button at the top right of a new chat, **File › New Temporary
Chat** (⇧⌘N or Ctrl+Shift+N in the desktop app), or **New temporary chat** in the search palette. A **Temporary chat** strip
across the top shows that you are in one.

- It never appears in the sidebar, search, the Artifacts page, a project or an export, and nothing of it is saved to
  [memory](/memory/). It cannot be continued in Cowork, and it keeps no unsent draft.
- It is deleted, with its files and artifacts, when you leave it: open something else, start a new chat, press **×** in
  the strip, or close its window. A window that closes or drops has a minute to come back (a reload keeps the chat).
  Any temporary chat nobody has open and that has been idle for 24 hours is removed too.
- By default the model still knows your personal instructions and memory. **Settings › Privacy › Temporary chats**
  chooses:
  - **Don't save (default)**: the model may use your memory and instructions; nothing is written.
  - **Start fresh: also ignore memory and personal instructions**: the model gets no memory, personal
    instructions, name, project or search over your past chats, as on a new install. The project menu is not offered.
- Your admin's instructions and safeguards always apply, and the model provider still receives what you send.

## Personality and instructions

**Settings › Account** has what shapes every new chat:

- **What should Atelier call you?** The name used in the greeting and shared with the model.
- **Instructions**: preferences for the model (up to 20,000 characters), added to the system prompt of every new chat.
- **Personality**: **Atelier — helpful and pragmatic** (the default), **Technical — precise and earnest**, **Relaxed —
  casual, more emoji**, or your own custom modes (**Add custom mode**, up to 20; a name and up to 4,000 characters of
  style instructions; **Edit mode**, **Delete mode**). A personality changes tone only, not identity or abilities, and your explicit instructions and response
  style win over it.
- **Response style**: **Default**, **Concise**, **Explanatory** or **Formal**, independent of the personality.

Changes apply to new conversations. Your administrator can add instructions for every conversation under **Settings ›
Admin › Capabilities**. They come first when instructions conflict, then what you say in the conversation, your
response style, your saved instructions, and last project instructions. The wording is in the
[Chat prompt](/prompts/chat/).

## Memory and past chats

Chat and Cowork can remember lasting things about you across conversations and search your earlier chats when you refer
to them. See [Memory](/memory/) for what it keeps and how to edit or turn it off. The
toggles are in **Settings › Memory**: **Search and reference chats**, **Generate memory from chats** and **Include
sensitive topics in memory**. Chats inside a project also read that project's memory entries.

## Long conversations

Atelier summarizes the older part of a conversation before it outgrows the model's context window and shows a
line, **Compacted chat · saved 666.2k tokens**, that opens the summary. Everything stays visible above it.

- It starts when the next request would pass 85% of the window, or earlier when the room left would not fit a full reply
  (up to a quarter of the window, at most 20,000 tokens). The 85% is `context.autoCompactAt` in the
  system `settings.json` (between 0.5 and 0.98); Settings has no row for it.
- The **small model** (**Settings › Admin › Models › Small model**) writes the summary when one is set and differs from
  the chat's model. If that fails, the chat's own model does, then once more in smaller chunks. A conversation too
  long for the summarizer goes in parts that are merged.
- The newest messages are kept as they were. The summary carries your current request, task list and changed files.
- If a single turn needs eight summaries and still does not fit, it stops with "This task keeps filling the model's
  context window… Raise the model's context length (Settings › Admin › Models)".
- Chat and Cowork have no `/compact`; only Code does.

The ring at the right of the footer shows how full the window is. Hover it for the figures ("25K of 128K tokens used (20%)"). It turns amber from 75% and red above 90%.

In Code the ring opens a popover with a breakdown of what fills the window, the tokens left until auto-compact, **Compact session**, and your usage: the plan's own windows for the
**ChatGPT Plan** provider ("5-hour limit", "Weekly limit"), the session's cost, today's
and the last 7 days' for a hosted API (Anthropic, OpenAI or an OpenAI-compatible endpoint), and tokens today and over 7 days for anything else. See [Code](/code/).

## Projects

A project gives a set of chats the same instructions and files. See [Projects](/projects/).

## Deleting, exporting and retention

- **Delete** a chat from its row's menu or the title menu. The chat
  and its artifacts are deleted for good.
- **Settings › Privacy › Keep conversations** deletes conversations (chats, Cowork tasks and Code sessions) untouched
  for **30**, **90** or **365 days**. Pinned ones stay. The default is **Keep everything**. The check runs 24 hours after
  Atelier's backend starts and every 24 hours after that, so a desktop app quit within a day each time never
  runs it.
- **Settings › Privacy › Export your data › Export** builds a zip of your conversations (each as Markdown for its active
  branch, plus all of them with every version as `conversations.json`), your projects' names, descriptions and
  instructions, every artifact version, your uploaded and project files, and your memory. Temporary chats are not in it.
- **Delete all…** removes every conversation (chats, Cowork tasks and Code sessions) with its messages, files and
  artifacts after you type `DELETE`. Projects stay, without their chats.

See [Privacy](/privacy/) for what is stored where.

## Limits and failure modes

Provider errors begin with the provider's name as in **Settings › Admin › Providers** (here, Anthropic).

| You see | What it means and what to do |
|---|---|
| **Connection interrupted. Retry n of 10** | A temporary failure. Atelier is retrying. Wait, or press **Stop**. |
| **Anthropic usage limit reached…** | A billing, quota or plan limit. Not retried. Add credit or wait for the plan window, or pick another model. |
| **Anthropic rejected the credentials (401)…**, with **Fix in Settings** | The key or sign-in is wrong or expired. **Fix in Settings** opens **Providers**. |
| **Model not found…**, with **Fix in Settings** | The provider no longer lists that model. Pick another, or check **Settings › Admin › Models**. |
| **The conversation is too long for this model** | The provider refused the request as too long, even after Atelier compacted and tried again with a tighter fit. Start a new chat, or raise the model's context length in **Settings › Admin › Models**. |
| **Anthropic is busy or unavailable (503)…** | Retried automatically. If it ends, press **Retry**. |
| **The model's reply didn't follow its own format, so Ollama couldn't read it** | A small or local model made a malformed tool call. Atelier asks again up to twice; press **Retry** if it persists. |
| **The model connection ended before the reply was complete.** | The stream broke. Retried automatically. |
| **The model provider stopped this response.** with **Edit** and **Retry** | The provider declined to continue. Atelier does not retry this; edit your message or try again. |
| **Atelier restarted and cut off this reply.** | Press **Continue**. |
| **Stopped: the same action ran 15 times with the same result. Send a message to continue, ideally saying what to do differently.** | The model kept repeating one call. Atelier told it on the 6th repeat and stopped the turn on the 15th. Say what to try instead. |
| **The sandbox isn't available: …** | The sandbox could not start (for example the server's `sandbox` container is down). |
| A file tile reading **Larger than 32 MB** | Too big to upload. |

More in [Troubleshooting](/troubleshooting/). Every setting that touches Chat is in the
[settings reference](/reference/settings/), and the tools a chat can use are in the [tool reference](/reference/tools/).
