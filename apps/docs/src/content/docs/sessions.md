---
title: Sessions
description: Find, organize and keep track of your chats, Cowork tasks and Code sessions, including split view, groups, archive and the status dots.
---

Every conversation you start is a **session**: a *chat* in Chat, a *task* in Cowork, a *session* in Code. They are listed
in the sidebar, searched from the palette, and kept until you delete them (or the retention period you set in **Settings
› Privacy** does). The keys are in [Keyboard shortcuts](/shortcuts/).

## Where sessions are listed

| Mode | Where | How it is arranged |
|---|---|---|
| Chat | The Chat tab's sidebar | **Pinned**, then by day, with Cowork tasks mixed in. A filter shows chats or tasks only. See [Chat](/chat/#the-sidebar). |
| Cowork | The **Cowork** page, and by day in the Chat sidebar | By folder, with the view options below. |
| Code | The Code tab's sidebar | By folder, with the view options below. |

Each list is capped at the 200 most recently active sessions. Older ones are still in your account and the export;
Chat's search finds older chats but never searches Cowork tasks or Code sessions. On a server, a session whose remote
control is switched off is listed only on the device that made it (see
[Remote control](/remote-control/)).

## The session menu

Hover a row and press **⋯**, or right-click it, to open its menu. For Code sessions and Cowork tasks
it holds the following; with the menu open, the letter beside an item does it:

| Item | Key | What it does |
|---|---|---|
| **Open in ›** | 1, 2, 3… | **Split view** (Code only), **New window** (desktop app), and **Cursor**, **VS Code**, **Finder** (desktop app, for a folder on this computer). See below. |
| **Pin** / **Unpin** | P | Moves it to the **Pinned** group at the top of its list, the most recently pinned first. |
| **Mark as unread** / **Mark as read** | U | Gives the row the blue "finished" dot, or clears it. |
| **Rename** | R | Opens a dialog for a title of up to 200 characters. |
| **Fork** | F | Opens a copy of the conversation (its active branch) as a new session in the same folder with the same model and settings, titled "Fork of …". The original keeps its own artifacts and file checkpoints. |
| **Move to group ›** | 1–9 | Files it under one of your groups, **Ungrouped**, or **New group…**. |
| **Archive** / **Unarchive** | A | Hides it until you switch the view's **Status** to **Archived** or **All**. |
| **Delete** | D | Deletes the session and its artifacts after a confirmation. Cannot be undone. |

A chat's menu is shorter: **Pin**, **Rename**, **Add to project ›**, **Remove from project** and **Delete** (see
[Projects](/projects/)). The title at the top of any open session has its own menu with **Pin**, **Rename**,
**Delete** and, on a server account, **Remote control** (see [Remote control](/remote-control/)).

Filing in a group, archiving and marking unread are housekeeping: they do not count as activity and do not move a session
in "last activity" order. Pinning, renaming and changing a session's model do count and move it.

## Groups

A **group** is a named folder of sessions that you make yourself, shared by Code and Cowork. **Move to group › New group…**
asks for a name (up to 80 characters) and files the session in it. A group's header
has **+** to start a new session in the group and **⋯** with **Rename
group** and **Delete group**; click the name to collapse the group. Deleting a group does not delete its sessions: they go back to **Ungrouped**.

Groups only show when the list is grouped by **Custom groups** (below). A session is in at most one group, and a fork
starts in its original's group.

## Archive

Archiving puts a session away without deleting it. Open the sliders button, choose **Status**, and pick **Archived** or **All**; **Unarchive** in the menu brings one back. Chats cannot be archived: pin them, delete them, or leave them to the retention period.

## Sidebar view options

The sliders button on the first group of the Code sidebar and of the Cowork page sets how those two lists look. It is one setting for both, saved with your account, so on a server it follows you to
other devices.

| Option | Choices |
|---|---|
| **Status** | **Active** (default), **Archived**, **All** |
| **Environment** | **All environments**, or any of **Local**, **Cloud**, **Remote Control**, **SSH** (at least one) |
| **Group by** | **Date**, **Folder** (default), **State**, **Custom groups**, **None** |
| **Sort by** | **Name**, **Date created**, **Last activity** (default) |
| **Show empty groups** | A switch; with **Custom groups** it keeps groups that have no sessions in the list |

- **Folder**: one group per folder, each with a **+** that starts a session there. Sessions without a folder are under
  **No folder**, whose **+** starts one with no folder.
- **Date**: **Today**, **Yesterday**, the date for each earlier day of the past week, **Previous 30 days**, **Older**.
- **State**: **Needs your attention** (waiting for a permission or an answer), **Running**, **Finished** (done while you
  were elsewhere, not yet seen) and **Idle**.
- **Custom groups**: your groups, then **Ungrouped**.
- **None**: one list called **Recents**.
- Pinned sessions are always in their own **Pinned** group on top, whatever the grouping.
- An environment means where the session's folder is: **Local** is this computer, **Cloud** a codespace, **Remote
  Control** a folder lent by another of your computers, **SSH** a host you added. A session whose folder is gone counts as
  Local. (The **Remote Control** environment is not the account's remote-control switch: see [Remote
  control](/remote-control/).)
- The button changes look when anything differs from the defaults, so you can tell a session may be
  filtered out.

## Status dots

Code and Cowork rows in these lists start with a dot that tells you where to look:

| Dot | Meaning |
|---|---|
| Hollow circle | Idle (also a session that ended in an error or was interrupted). |
| Pulsing dot | Running. |
| **Yellow** dot ("Needs your attention") | It is waiting for you: a permission, a question, a plan, a folder change. |
| **Blue** dot ("Finished") | A turn finished while you were in another session, and you have not opened it since. |

Opening the session clears the blue dot. A turn you stopped, or one that ended in an
error, does not turn it blue. The marks are kept by the backend, so they survive a restart and show on every device.
The Chat sidebar, which mixes chats and tasks, shows a document icon instead when the session made something
(**Made an artifact** for a chat, **Made files** for a task) and a dot while it runs.

## Search

The **Search** box at the top of the sidebar, or ⌘K / Ctrl+K from anywhere, opens the palette.

- **Actions** are filtered by what you type: **New chat** (on the Cowork page **New Cowork task**, in Code **New
  session**), **New temporary chat**, **Settings**, and **Lock Atelier** when the screen lock is on.
- **Chats**: with an empty box, your 8 most recent chats under **Recent chats**; with text, up to 20 matches under
  **Chats**. A match is a chat whose title contains your text, or any of whose messages contains every word you typed (each
  word matches as a prefix). Temporary chats are never found.
- It searches chats only, not Cowork tasks or Code sessions. Use the lists and their view options for those.

↑ and ↓ move, Enter opens, Esc closes.

## Split view

In Code you can work in up to four sessions side by side. Open the menu of a Code session and choose **Open in ›
Split view**: the session appears beside the one you are in. Do it again for a third and a fourth (past four it replaces
the active one). Cowork tasks and chats do not split.

- **One active session.** A click or focus anywhere in a cell makes it the *active* one. Typing goes to the focused
  cell; ⌘U (add files) and ⌘⇧E (effort) act in the active one only.
- **Picking in the sidebar replaces.** Clicking a session in the sidebar puts it in the active cell. If it is already open
  in another cell, that cell becomes the active one instead; a session is never shown twice.
- **New in a pane.** The sidebar's **New** puts a new session into the active cell; choose
  its folder there, and the first message you send turns it into that session. A new session in a cell keeps no draft.
- **Close.** Each cell has its own header with the title menu, the pane buttons and **Close split view** (✕).
  Closing the active cell makes its neighbor active.
- **Resize.** Drag the line between cells, or focus it and use the arrow keys (see [Keyboard shortcuts](/shortcuts/#split-view-and-dividers)); double-click
  it for even cells. Neither neighbor goes under 360 px. The sizes are remembered per number of cells in this window or
  browser.
- **Narrow windows.** Below 768 px only the active cell shows.

A split is part of the page's address (`/code/<id>?split=<id>,<id>`), so reloading or going back keeps it.

## Open in

The **Open in ›** submenu is where a session can go besides where it is:

- **Split view**: above.
- **New window** (desktop app): a window with only that session, no sidebar.
- **Cursor**, **VS Code**, **Finder** (desktop app, for sessions in a folder on this computer): opens the folder in that
  editor, or shows it in Finder (File Explorer on Windows; the menu label stays "Finder"). If an editor is missing you get
  "Couldn't open the folder in Cursor. Is it installed?".

## Windows, tabs and drafts

- **The tab you left.** Atelier opens in the tab you were last in: quit in Code and it starts on Code's home, otherwise on
  Chat (Cowork counts as Chat), remembered per window or browser. A link to a chat, an invite or Settings opens
  as it was.
- **Drafts.** Unsent text stays in its box when you leave and come back, per conversation, for 30 days
  and at most 50 boxes. The new chat and the new Cowork task share one box. See [Chat](/chat/#drafts).
- **Narrow windows** (under 768 px): the sidebar slides in over the page and closes when you pick something, press Esc,
  or swipe left.
- **Windows (desktop).** Only one copy of Atelier runs: opening it again brings the first window forward. On Windows and Linux, closing the last window quits Atelier; on macOS the app keeps
  running until you quit it, and clicking its icon opens a window again.
- **Updates.** When the desktop app has an update downloading, the sidebar shows "Downloading Atelier 0.1.10", which becomes "Update 0.1.10 is ready" with **Restart**. A server newer or older than the app gets a notice
  too. See [Updates](/updates/).
