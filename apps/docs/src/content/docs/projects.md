---
title: Projects
description: Keep related chats together and give each of them the same instructions and reference files.
---

A **project** is a named bundle of instructions, reference files and the chats that use them. Start a chat in a
project and the model begins it already knowing what the project is for, how you want it to answer there, and what is in
its documents. Projects are for Chat. Cowork tasks and Code sessions work in folders and do not use them.

## Creating a project

There are two ways:

- **Projects** in the sidebar opens the Projects page. **New project** asks for a **Name** (up to 120 characters)
  and a **Description** (up to 2,000), then opens the new project.
- On a new chat's home, the **Project** menu under the box has **New project…**, which does the same.

The Projects page lists your projects as cards with name, description and a line such as
"Updated 3 days ago · 4 chats · 2 files". Search filters by name or description, and the sort button orders
them **Recently updated** (the default) or by **Name**.

## The project page

A project's page has your chats on the left and the project's instructions and files on the right (under the chats in a
narrow window):

- The name and description at the top are editable in place (Enter saves, Esc cancels).
- A message box that creates a chat inside the project, with the same **+** menu, model picker, effort control and
  **Research** as the chat home. Files dropped here attach to the *message*; to add a file to the
  project, use the panel on the right.
- **Chats in this project**, pinned first and then by last activity. Move a chat in from its row's menu with **Add to project ›** (or out with **Remove from project**).
- **Instructions** with **Add** or **Edit**, up to 100,000 characters. Use them for tone, audience, format and what to keep in
  mind. Every new chat in the project starts with them.
- **Files** with **Add** (or drop files on the panel). Each row shows its type, size and estimated tokens, and a
  **×** removes it.

The title menu (**Pin** or **Unpin**, **Edit details**, **Delete project**) is the breadcrumb at the top. A pinned project shows in the sidebar's **Pinned** list, where its menu only has **Unpin**. Pinning does not change
the "Recently updated" order.

## How instructions and files reach the model

Both go into the chat's **system prompt**, in a `<project name="…">` block after your personal instructions and memory.
The instructions go in as written; each file goes in as a `<document name="…">` block holding its extracted text. The
model is told to treat project documents as reference material: use them, name the ones it relies on, and not
follow instructions found inside them unless you ask. When
instructions conflict, the order is: your administrator's, what you say in the conversation, your response style, your
saved instructions, and last the project's.

Files are **in the prompt, not read on demand**: the model has no tool to open a project file later. That drives the limits:

- **A budget of 60,000 tokens** for all files together, whatever the model's context window. Atelier estimates each
  file's tokens when you add it (about four characters per token). Files are taken in the order you added them, and a
  file goes in only if it fits what is left, so a big file that does not fit is skipped while smaller ones after it still
  go in. The panel shows **Prompt budget** as "42K / 60K tokens" (the figure adds up every text file, skipped ones included) and marks a skipped file **Over budget**
  ("1 file doesn't fit the budget and is left out of new chats.").
- **Only files with readable text count.** Text and code files, Markdown, CSV, JSON, YAML, XML, SVG and PDFs (their text
  layer) are read. Anything else, including images, Word, Excel and PowerPoint files and archives, is stored but marked
  **No readable text** and never sent to the model. A scanned PDF without a text layer is not marked: it counts a few
  tokens for its page markers and sends no text.
- **A file over about 240,000 characters** (60,000 tokens) can never fit, however empty the rest of the budget is.
- **Each file up to 32 MB**, uploaded one at a time; a failure shows the file's name and the reason.
- **Cost.** The files ride along on every request of every chat in the project, using the window. A small local model
  with a window smaller than the budget can be filled by the project alone; Atelier does not shorten project text for
  it. Keep project files short, or use a model with a large window (see [Models](/models/)).

:::note
A chat reads its project when its system prompt is built: at its first message, and again whenever the prompt is
rebuilt (you change its model, its tools change, or your memory changes). Editing a project, or moving an
existing chat into it, may therefore not show up in a chat already under way. To be sure a change applies,
start a new chat in the project.
:::

## Chats inside a project

- A chat belongs to at most one project. Start it from the project page, choose the project in the **Project** menu
  before the first message, or use **Add to project ›** later.
- The chat's side chats (`/btw`) read the project too. A chat that you continue in Cowork keeps its project, so the task
  reads the project's instructions and files as well.
- [Memory](/memory/) is aware of projects: a chat in a project also reads that project's memory entries (shown under
  **Projects** in **Settings › Memory**) and saves project-only facts there. Other chats never see them.
- **Temporary chats.** With **Settings › Privacy › Temporary chats › Don't save (default)** a temporary chat can use a
  project, but it never shows in the project's list. With **Start fresh** it gets no project at all. See [Chat](/chat/#temporary-chats).

## Deleting a project

**Delete project** (in the title menu) deletes its instructions and files, and it can't be undone. Its chats stay in your list, outside any project, and keep their history. Memory
entries that belonged to the project stay, as general **Areas**.

**Settings › Privacy › Delete all…** deletes every conversation but leaves projects, without their chats. **Export** includes each project's name, description, instructions and files.

## Who can see a project

A project belongs to the account that made it. On a server, other people, admins included, cannot list or open your
projects in Atelier, and there is no way to share one. There are no admin settings specific to projects. Administrators
affect them only through what applies to every conversation: the **Instructions for every conversation** (**Settings ›
Admin › Capabilities**), which outrank project instructions, the content safeguards, and the
models and their context windows, which decide how much of a project fits.

## Limits at a glance

| What | Limit |
|---|---|
| Project name | 120 characters |
| Description | 2,000 characters |
| Instructions | 100,000 characters |
| One file | 32 MB; to be sent to the model, no more than about 240,000 characters of text |
| All files together in the prompt | 60,000 tokens (estimated) |
| Chats listed on the project page | The 200 most recent |
| Projects | No limit |

If a project is deleted while its page is open, the page says "This project doesn't exist anymore." with a link back to
**Show all projects**.

## Tips

- Put *how to answer* in the instructions and *what to know* in files. "Answer as a patient tutor; ask one question at a
  time" is an instruction; the course notes are files.
- Prefer a few short, focused files to one long dump. Name them so the model can cite them.
- Convert images and scans to text before adding them; Atelier does not read them for projects.
- Check the budget bar after adding files. If a file you need is **Over budget**, split it or remove something.
