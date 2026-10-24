---
title: Keyboard shortcuts
description: Every keyboard shortcut, slash command and menu accelerator in Atelier, on macOS and on Windows and Linux.
---

This page lists every key Atelier binds, with its default. **Keyboard shortcuts** under **More** in the sidebar opens a
short version of the first two tables inside the app, with the keys you set.

## Changing a shortcut

**Settings › Keyboard shortcuts** changes the keys of the shortcuts in the first table and of **Upload or add files**
and **Change effort**. **Change** waits for the new combination (Esc cancels), **Turn off** removes a shortcut and
**Reset** brings back its default; **Reset all** does that for every one. A shortcut needs ⌘ or ⌃ (Ctrl on Windows and
Linux), unless it is a function key such as F6. Atelier refuses a combination another of its shortcuts already has
and one the system or the text box uses (⌘C, ⌘V, ⌘Z, ⌘Q, ⌘W and the like), and says why. Send, new line, Stop, `/`,
`@` and the other keys of the message box can't be changed. Your shortcuts belong to your account, so they follow
you to every device you sign in on; in the desktop app the menu bar shows them too.

Keys are given for macOS, then Windows and Linux: ⌘ becomes **Ctrl**, ⇧ becomes **Shift**, and
↵ is Enter. Where one column is given, the key is the same everywhere.

:::note
In a browser, a combination your browser keeps for its own use (many browsers reserve the ones that open or
close windows and tabs) may not reach Atelier. The keys marked *desktop* exist only in the desktop app.
:::

## Everywhere

| Action | macOS | Windows / Linux | Notes |
|---|---|---|---|
| New chat, Cowork task or Code session | ⌘N | Ctrl+N | Starts a new one in the mode you are in. |
| New temporary chat | ⇧⌘N | Ctrl+Shift+N | Opens a temporary chat from any page (from Cowork or Code it switches to Chat). See [Temporary chats](/chat/#temporary-chats). |
| Search | ⌘K | Ctrl+K | The [search palette](/sessions/#search). |
| Settings | ⌘, | Ctrl+, | |
| Show or hide the sidebar | ⌘B | Ctrl+B | |
| Lock Atelier | ⇧⌘L | Ctrl+Shift+L | *Desktop*, and only on "Run on this computer"; also **Lock Atelier** in the profile menu and the **File** menu. Without a screen lock set it says "Set a PIN or password first" and opens the setting. |

## The message box

These work in the message box of Chat, Cowork and Code (and project chats).

| Action | macOS | Windows / Linux | Notes |
|---|---|---|---|
| Send | Enter | Enter | While the model works, a sent message waits for its next step (**Take back and edit**, **Send now**). |
| New line | ⇧Enter | Shift+Enter | |
| Stop the reply | Esc | Esc | Only while the box is empty. |
| Upload or add files | ⌘U | Ctrl+U | Opens the file picker. In a split view, acts in the active session only. |
| Change effort | ⇧⌘E | Ctrl+Shift+E | Opens the effort popover on models that have it. In a split view, the active session. |
| Switch permission mode | ⇧Tab | Shift+Tab | **Code only**, only while the box is empty. Cycles **Auto → Ask → Accept edits → Plan**; **Bypass** is chosen from the menu only. |
| Start a slash command or skill | `/` | `/` | As the first character; see below. |
| Mention a file | `@` | `@` | **Code and Cowork** (a session with a folder). See below. |

Pasting or dropping a file attaches it. Editing a message of yours:
**Enter** saves it, **Shift+Enter** adds a line, **Esc** cancels.

## Slash commands

Typing `/` as the first thing in the box opens a list. It holds the built-in commands the current page offers,
then your skills and custom commands. ↑ and ↓ move, Enter or Tab picks, Esc closes it (until the text changes). Names
that start with what you typed come first, then names that contain it (`review` finds `plugin:review`). Picking a command that takes no argument runs it at once; one with an argument
puts `/name ` in the box.

### Built-in commands

| Command | What it does | Offered in |
|---|---|---|
| `/model` | Opens the model picker. | Everywhere with a message box: chat home, chats, project chats, Cowork, Code |
| `/clear` | Starts a new session: in a chat, a new chat (a new temporary chat from a temporary chat, the project's page from a project chat); in Cowork and Code, the home page with the same folder chosen. | Chats, Cowork tasks, Code sessions |
| `/btw [question]` | Asks a side question in a panel on the right; it reads the conversation, changes nothing and adds nothing to it. `/btw` alone opens an empty one. See [Chat](/chat/#side-chats-with-btw). | Chats, Cowork tasks, Code sessions |
| `/loop [interval] <prompt>` | Sends the prompt now and again every interval while the session is idle. See below and [Loops](/loops/). | Cowork tasks, Code sessions |
| `/compact [focus]` | Summarizes the conversation so far to free up context; the optional text says what to keep. The same as the context popover's **Compact session**. | Code only (Chat and Cowork compact by themselves) |
| `/rewind` | Restores the code, the conversation or both to an earlier point. | Code only |

`/loop` forms:

| You type | Result |
|---|---|
| `/loop 5m check the build` | A loop that sends "check the build" now and every 5 minutes. Intervals are `30s`, `5m`, `2h`, `1d` or a combination in that order (`1h30m`). |
| `/loop check the build` | The same every 10 minutes (the default). |
| `/loop` or `/loop list` | Shows the session's loops. |
| `/loop stop` | Stops all of the session's loops. |
| `/loop stop 2` | Stops one, by its number in the list (or its id). |

An interval is at least 1 minute (shorter ones are rounded up) and at most a day. The other limits are on [Loops](/loops/#limits).

### Skills and custom commands

After the built-ins the list shows every **skill** you may start and every **custom command** (a Markdown prompt in a
`commands` folder of `.atelier` or, with Claude Code compatibility on, `.claude`, or one that comes with a plugin; a
plugin's are named `plugin:name`), each with its description and an argument hint if it takes one. Typing `/name args`
and sending expands the skill or command into the message. A built-in command wins over a skill with the same name.
The **+ › Skills** menu offers the same skills. See [Customize](/customize/).

### Mentioning files

In a Code session or a Cowork task, `@` at the start of a word lists files in the folder (matching as you type);
↑ and ↓ move, Enter or Tab inserts `@path`, Esc closes the list. The model reads the file when it needs it. **Attach as
context** in the Files pane's right-click menu inserts the same mention.

## Answering a question or permission prompt

An ask from the model appears above the message box, and its keys work even while the cursor is in the box.

| Ask | Key | Does |
|---|---|---|
| **Permission** ("Allow Atelier to run …?") | 1 or Esc | **Deny** |
| | 2 or ⇧⌘↵ | **Always allow** (the chevron picks this session, this project or everywhere). Absent for dangerous commands, which are approved one call at a time |
| | 3 or ⌘↵ | **Allow once** (2 when there is no **Always allow**) |
| **Folder change** | 1 or Esc | **Stay here** |
| | ⌘↵ | **Move here** |
| **Plan** | Esc | **Revise…** |
| | ⌘↵ | **Accept and auto mode** |
| | ⇧⌘↵ | **Accept** (approve each edit) |
| **Questions** | 1–9 | Picks that option, for a single question |
| | Esc | **Skip** |
| | ⌘↵ | **Submit**, once every question is answered |

Digits count only while focus is on the prompt and not in a text field. The prompt takes focus when it appears, unless you are typing.

## The search palette

| Key | Does |
|---|---|

| ↑ ↓ | Move through actions and chats. |
| ↵ | Opens the highlighted one. |
| Esc | Closes it. |

**Settings** has its own search box: ↑ ↓ choose a result, Enter opens it, Esc clears the text.

## Session menus

With a Code or Cowork session's menu open (⋯ on its row, or right-click), the letter beside an item does it. No ⌘ or
Ctrl is needed.

| Key | Item |
|---|---|
| P | **Pin** or **Unpin** |
| U | **Mark as unread** or **Mark as read** |
| R | **Rename** |
| F | **Fork** |
| A | **Archive** or **Unarchive** |
| D | **Delete** |
| 1, 2, 3 … | In **Open in ›**: the places in order (**Split view**, **New window**, then **Cursor**, **VS Code**, **Finder**). In **Move to group ›**: the first nine groups. |

## Split view and dividers

| Key | Does |
|---|---|
| ⌘U, ⌘⇧E | Act in the active session of a [split view](/sessions/#split-view). Clicking or focusing a cell makes it active. |
| ← → (on a focused vertical divider) | Move the divider 2%; with Shift, 10%. |
| ↑ ↓ (on a horizontal divider, between stacked panes) | The same. |
| Home, End | Move the divider to its smallest or largest position. |
| Double-click a divider | Even sizes. |

## Sliders, lists and viewers

| Where | Keys |
|---|---|
| **Effort** slider | ← or ↓ lower, → or ↑ higher, Home or Page Down lowest, End or Page Up highest.  |
| Image viewer (click any image) | ← and → to the previous and next image, Esc to close. |
| Files pane (Code) | The menu key or Shift+F10 on a focused row opens its menu (**Attach as context**, **Copy ›**, **Open in ›**); Esc clears the filter. |
| **Reply** button over selected text | Esc hides it. |
| Plan pane (Code): comment box | Esc discards the comment. |
| **Open a repository…** (Code › Cloud): search box | Enter opens the top match. |
| Editing in place (project name and description) | Enter saves, Esc cancels (Shift+Enter adds a line in the description). |
| Memory bar ("Tell Atelier what to change") | Enter sends, Shift+Enter adds a line. |
| Projects page search | Esc clears it and closes it. |

## The desktop menu

The desktop app has a menu bar. Its own items, with their default keys (the menu shows the ones you set in
**Settings › Keyboard shortcuts**):

| Menu | Item | macOS | Windows / Linux |
|---|---|---|---|
| Atelier (macOS) | **Settings…** | ⌘, | |
| File | **New Chat** | ⌘N | Ctrl+N |
| File | **New Temporary Chat** | ⇧⌘N | Ctrl+Shift+N |
| File | **Lock Atelier** (only on "Run on this computer") | ⇧⌘L | Ctrl+Shift+L |
| File (Windows / Linux) | **Settings…** | | Ctrl+, |
| File (Windows / Linux) | **Quit** | | |
| View | **Toggle Sidebar** | ⌘B | Ctrl+B |
| View | **Search** | ⌘K | Ctrl+K |

The rest comes from the system's standard menus (**Atelier**, **Edit**, **View** and **Window** on macOS; **Edit**,
**View** and **Window** on Windows and Linux), with the operating system's usual keys. A build run from source also shows
**Toggle Developer Tools** and **Reload** in **View**.

## Desktop only

- The menu bar, including ⇧⌘L and **Lock Atelier** (the screen lock exists only on "Run on this computer").
- **Open in › New window**, **Cursor**, **VS Code** and **Finder** in the session menu.

Everything else on this page works the same in the desktop app and in a browser.

See also: [Sessions](/sessions/), [Chat](/chat/) and [Code](/code/).
