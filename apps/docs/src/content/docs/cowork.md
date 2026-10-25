---
title: Cowork
description: Hand a longer task to Atelier in a folder and get back the files it makes, with a progress panel, file previews and notifications.
---

![A Cowork task with its steps and output files](/img/cowork-2560.webp)

Cowork works through a whole task inside a folder: sorting files, reading a stack of PDFs and writing up what
is in them, building a spreadsheet, drafting a document. You describe the result you want; it plans the
steps, does them in the folder with real file tools, and leaves the files there. You see its steps while it works, and
what it made as cards you can open.

## Chat, Cowork and Code

| | Chat | Cowork | Code |
|---|---|---|---|
| For | Conversations, questions, writing, small builds | A longer task on files in a folder | Software projects |
| Works in | A conversation (optionally a private sandbox) | A folder you pick, or a new empty one | A folder you pick, often a git repository |
| File tools | Bash and Read in a sandbox | Read, Write, Edit, Glob, Grep, Bash | The same, plus Diff, Files, Terminal and Browser panes |
| Permission mode | Fixed rules, no picker | No picker; follows the admin's default | Picker in the message box |
| Result | The reply, [artifacts](/artifacts/) | Files in the folder, shown as cards | Changes in the repository |
| Memory | Yes | Yes | No |
| Plan mode, Rewind, `/compact` | No | No | Yes |

## Starting a task

Open **Cowork** in the Chat sidebar. The page shows your activity stats,
**Your tasks** by folder, and at the bottom the chips and the message box:

1. **Choose where to work.** The first chip is the environment: **Local** (this computer, desktop app only), **Cloud**
   (a GitHub codespace), **Remote Control** (a folder on another of your computers that is connected to the same
   server) or **SSH** (a host you added, desktop app on its own backend only). The second chip is the folder: **Recent**
   folders, **Open folder…**, or **No folder**.
2. **Describe the task** and send. Attach files or drop them in if that
   helps; see [Chat](/chat/#attachments) for what a model can read.

A task starts on the admin's **Default model for everyone** (**Settings › Admin › Models**), or the first available model when none is set; your personal **Default model** in **Settings › General** is for new chats. Pick another in the model
picker before you send, or later (it applies from the next message). Cowork has the same **Low** to **Max** effort
control as Chat; see [Effort](/effort/).

**No folder** (desktop app on "Run on this computer" only, for this computer or an SSH host) gives the task a new, empty scratch
folder in the data folder under `scratch-workspaces/<account>/scratch-<date>-<code>` (on an SSH host, in
its `~/.atelier`). It stays on disk when the task is deleted, is left out of **Recent**, and is grouped under "No folder"
in your list. In a browser, use a codespace or a folder another of your
computers lends.

The first time you use a folder from your computer, Atelier asks **Trust this workspace?** and shows the path; only
**Trust workspace** records it. See [Code](/code/) for the folder, codespace and SSH details, which are the same here.

Two more ways in. From any new chat, **+ › Add folder** turns the message box into a Cowork task in that folder (with a **×** to go back to a chat). And a chat that used its
[sandbox](/chat/#the-sandbox) offers **Continue in Cowork**, which copies the conversation into a task in the same folder.

Tasks are listed by folder on this page, and by day beside your chats in the Chat sidebar. The sliders button beside
the first group sets how they are grouped, sorted and filtered, as for Code sessions (see
[Sessions](/sessions/)). The **+** beside a folder starts a new task there.

## While it works

A task has three parts:

- **The conversation.** Each step the model takes is one line (for example "Ran 3 commands"); click
  a line to see the call and its result. A status line shows what it is doing, how long, its output tokens and how full
  the context is (see [Chat](/chat/#what-you-see-while-it-works)).
  You can keep typing while it works: your message waits for the next step, with **Take back and edit** and **Send now**.
- **The progress panel** to the right of the conversation (under it in a narrow window):
  - **Progress**, the model's task list with a count ("2 of 5"). The model
  keeps this list for anything beyond a quick lookup; its last item is a check of the result.
  - **Background**, sub-agents and loops that are running, each with a **Stop**.
  - **Output files**, the files the task created or changed.
- **Questions.** When it needs a decision it asks with a card above the message box: up to four questions, each with
  two to four choices (a recommended one first) and room for your own answer. **Skip** ignores them. Permission
  prompts appear in the same place.

The conversation header shows a folder badge (**Offline** if the folder's computer is not reachable) and the title menu
(**Pin**, **Rename**, **Delete**, and **Remote control** on a server account).

### Output files and previews

**Output files** in the panel lists every file the model wrote or edited with its **Write** and **Edit** tools inside
the folder during the task, newest change last. When a request finishes, cards for the files it touched appear under the conversation,
showing the file name and where it is in the folder. The button depends on the file:

| File | Button | What happens |
|---|---|---|
| Text, code, Markdown, images (`png`, `jpg`, `gif`, `webp`, `avif`) | **Open** | A preview panel opens: text and code highlighted, Markdown rendered, images shown. Its header can copy the contents, show the file in its folder or download it. |
| Office files (`docx`, `xlsx`, `pptx` and the like), PDFs, archives, audio, video | **Show in Finder** (**Show in folder** on Windows and Linux) in the desktop app for a folder on this computer; otherwise **Download** | No preview; the file is shown in your file manager or downloaded. |

:::note
Cards come from the model's Write and Edit calls, which write text. A file produced by a command the model ran (a
converted PDF, a spreadsheet built by a script) is in the folder but gets no card. The model's closing message lists the
files it made.
:::

If the folder's computer is offline the preview says "This folder's computer is offline."

## Permissions

Cowork has no permission-mode picker. Its tasks use the mode set by **Settings › Admin › Code › Default permission
mode**, which is **Auto** unless an admin changed it. In Auto mode another
model reviews each action that would otherwise ask you; edits inside the folder run without review (except files that
configure tools, such as `.git` or `.claude`), ask rules and deleting outside the folder still ask you, and deny rules
still block. [Permissions](/permissions/) explains every mode and the rules.

When something does need you, the prompt above the message box offers **Deny**, **Always allow** (this project, this
session or everywhere, from the chevron) and **Allow once**; its keys are in
[Keyboard shortcuts](/shortcuts/#answering-a-question-or-permission-prompt).

:::caution
Because Cowork follows that one setting, an admin who sets the default to **Bypass** lets Cowork run everything without
asking, and one who sets it to **Plan** stops Cowork from changing anything (it has no plan approval).
:::

## What Cowork can use

| Tools | |
|---|---|
| Files and commands | **Read**, **Write**, **Edit**, **Glob**, **Grep**, **Bash**, **BashOutput**, **KillShell** |
| Planning | **TodoWrite** (the progress list), **AskUser** (the questions) |
| Delegating | **Agent** (sub-agents, also in the background), **SendMessage** and **ListSessions** (to your other sessions), **TaskStop** (one, several or all background tasks) |
| Clock and limits | **Time** (the date and time), **Usage** (plan limits or API cost, where the provider has them) |
| Moving | **ChangeDirectory** asks to continue in another folder on this computer or an SSH host; you correct the path or stay |
| Knowledge | **Skill**, **WebSearch** and **WebFetch** (when an admin has them on), memory and past-chat search, tools of your [connectors](/connectors/), and **AddConnector** for an MCP server you give it |
| Showing | **inline_visual** (a small explainer in the conversation) |

There is no `artifact` tool in Cowork: the deliverable is a file in the folder. Every tool, with its
description and parameters, is in the [tool reference](/reference/tools/).

### Instruction files

Cowork reads the instruction files in the task's folder and every folder above it, the way Code does: `ATELIER.md`,
`AGENTS.md` and, while **Settings › Admin › Code › Claude Code compatibility** is on (the default), `CLAUDE.md`,
`.claude/CLAUDE.md`, `CLAUDE.local.md` and `.claude/rules/*.md`. `@path` imports are followed. It also reads **Settings ›
Account › Your ATELIER.md** (your own rules for every Code session and Cowork task) and the admin's system AGENTS.md. Put
the conventions of a recurring kind of work (naming, formats, tone) in these files. When you state a lasting preference in a task,
the model adds it to the folder's `ATELIER.md` and tells you. See [Customize](/customize/).

### Sub-agents, loops and side questions

- The model can start **sub-agents**, including in the background, which keep working while it goes on; they show under
  **Background** with their status. At most 8 can work in the background at once, and a task wakes itself for their
  results at most 5 times in a row before waiting for you.
- `/loop 10m <prompt>` re-sends a prompt every interval while the task is idle. `/loop` shows the loops and `/loop stop`
  ends them. Intervals, limits and lifetimes are on [Loops](/loops/).
- `/btw <question>` asks a side question in a panel on the right without interrupting the task. It reads the task's
  conversation and folder and changes nothing. See [Chat](/chat/#side-chats-with-btw).

Cowork has no `/compact` (it compacts on its own, **Compacted task · saved N tokens**), no `/rewind`, and no separate
Background tasks pane: the Background list in the panel is it.

## Notifications

A system notification tells you when a task **finishes**, **fails** or **needs your input**, with the task's title as the body. It appears only when Atelier's
window does not have focus. Clicking it opens the task. Two switches in **Settings › General › Notifications** control it:

- **Notify me when a task finishes** (covers finished and failed)
- **Notify me when a task needs me** (a question or a permission waiting)

The desktop app allows notifications itself (your operating system's settings still apply). A browser asks
for permission the first time you send a task, and if you blocked it the setting shows
"Notifications are blocked for Atelier. Allow them in your browser's site settings or your system settings." Only Cowork
tasks notify; Code sessions show a status dot in the sidebar instead (see [Sessions](/sessions/#status-dots)).

## Writing a good task

When a request leaves out something that would change the
result (audience, purpose, length, format, where the output should go), the model asks one round of questions first. Being
specific up front saves that round trip:

- **Say what done looks like.** "A one-page summary of each contract in `contracts/`, as a single `.docx`, longest
  obligation first" beats "summarize my contracts".
- **Name the format.** Unless you do, a written piece becomes `.docx` or `.md`, slides `.pptx`, a table `.xlsx`, raw data
  `.csv`.
- **Point at the material.** Work in the folder that holds it, or put the files there first. Cowork reads the folder first
  and reuses its structure and naming.
- **Say what must not change.** By default new output is saved next to the originals with clear names, and files you made
  are not overwritten or renamed unless you ask. Before deleting or moving files in bulk it asks, and prefers moving them
  into a holding folder such as `_to_delete/`.
- **Ask for research as research.** For research it starts by searching and asks afterwards, if the results reveal a real
  fork. When its answer relies on web pages, connector items or files it ends with a **Sources** list.
- **Use effort for hard thinking, not for completeness.** The effort setting decides how long it thinks, not how much of
  the work it does. See [Effort](/effort/).

The instructions Cowork is given are published in full: [Cowork prompt](/prompts/cowork/).

## Limits and what it cannot do

- **It works in one folder.** Moving elsewhere is a request you approve (ChangeDirectory), not something it does on its own.
- **No step cap on a turn, but a loop check.** If the same call keeps producing the same result, the model is told on the
  6th time and the turn stops on the 15th with "Stopped: the same action ran 15 times with the same result. Send a message
  to continue, ideally saying what to do differently." Sub-agents have a ceiling of 200 steps.
- **Long tasks fill the context.** Atelier summarizes older steps automatically; a task that needs eight summaries in one
  turn and still does not fit stops with a message to raise the model's context length (**Settings › Admin › Models**).
- **A usage or billing limit ends the turn at once** instead of retrying; a dropped connection retries up to 10 times
  (see [Chat](/chat/#what-you-see-while-it-works)).
- **It only works as far as the model does.** Small local models may fail on long tasks, and a model without tool calling
  cannot use the file tools. See [Models](/models/) and [Local models](/local-models/).
- **It cannot undo.** There is no Rewind in Cowork. Anything that leaves the computer or
  cannot be undone (sending a message, posting, a purchase, permanent deletion) needs your explicit request.
- **No git panels, terminal or browser.** To review a diff, run a terminal or preview a dev
  server, use [Code](/code/).
- **A restart interrupts it.** If Atelier or its server restarts mid-task, the conversation says "Atelier restarted and
  cut off this reply." with **Continue**, which carries on from what was already done.
