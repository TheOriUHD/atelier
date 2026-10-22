---
title: Memory
description: What Atelier remembers about you across chats, how it searches your earlier conversations, which model does the work, and how to see, change, export or switch off any of it.
---

Atelier can do two separate things for you across conversations:

- **Remember lasting facts about you** (how you want answers, who you are, the people and projects in your life) and use
  them in later chats.
- **Search your earlier conversations** when you refer to something you discussed before.

Both are per person: on a shared server nobody else sees your memory or your chats in the app. They are on by default,
work in Chat and Cowork only (see [Where memory applies](#where-memory-applies)), and live in **Settings › Memory**.

## What Atelier remembers

Your memory is a list of entries in six sections:

| Section | What it holds |
|---|---|
| **Preferences** | One entry: how you want Atelier to respond (tone, format, length, language, things to always or never do). It becomes your standing instructions. |
| **Profile** | One entry: who you are: your name, where you live, family, languages, education and career. |
| **Topics** | A hobby or interest with some depth, one entry each. |
| **Areas** | Larger ongoing things of your own, such as an app you are building or a business you run. |
| **People** | Someone in your life, one entry each. |
| **Projects** | Notes that belong to one of your Atelier [projects](/projects/). |

Preferences and Profile always exist (under the heading **You**); the other sections show up once they have an entry.

An entry is a **title** (a few words, at most 120 characters), a one-line **summary** (at most 300) and **details**: single
facts, one per line, close to how they were said, with the date when it is known ("Greenhouse heater installed March 3,
2026"). Details can be up to 24,000 characters. Entries grow:

- New facts are added as new lines; nothing is rewritten or shortened behind your back.
- A line is replaced only when a newer fact supersedes it, and removed only when you ask Atelier to forget it.
- A mistake is corrected by adding a line "CORRECTION: …", not by quietly changing the old one.

## Where memory applies

| Conversation | Reads memory | Saves to memory | Searches past chats |
|---|---|---|---|
| Chat | Yes | Yes | Yes |
| Cowork | Yes | Yes | Yes |
| Code | No | No | No |
| Sub-agents | No | No | No |
| Side chats (`/btw`, in Chat and Cowork) | Yes | No | Yes |
| Temporary chat, **Don’t save** | Yes | No | Yes |
| Temporary chat, **Start fresh** | No | No | No |

Code works from your project's instructions and doesn't use memory (see [Customize](/customize/)). Past-chat search
does find Code sessions and Cowork tasks, though, when you search from Chat or Cowork. Temporary chats are covered [below](#temporary-chats).

## How the model uses it

At the start of a conversation Atelier gives the model a short digest. Your **Preferences** go in as standing
instructions, followed in every reply from your first message. Your **Profile** and the list of your other entries
(title, summary and id) go in as background: the model uses them when relevant, without reciting them or bringing up
memory unless you ask. Inside a project, that project's own notes are included too. The list shows at most 40 entries
(4,000 characters), section by section, most recently updated first; the rest can be found by search. Models Atelier
doesn't recognize as frontier models (most local models) get a shorter digest (900 characters of Preferences, 500 of
Profile, 8 listed entries) so it fits a small context window.

When it needs more, the model has these tools; each shows as a step in the conversation, linking to the entry or chat:

| Tool | What it does | In the transcript |
|---|---|---|
| `MemorySearch` | Finds entries by words in their title, summary or details (best first, at most 8, with the start of their details). | **Looked at memories** |
| `MemoryView` | Shows the full details of up to 5 entries by id. | **Looked at memories** |
| `MemoryUpdate` | Creates, changes or deletes one entry. | **Saved a memory**, **Updated a memory**, **Forgot a memory** |
| `ChatSearch` | Searches your past conversations. | **Searched past chats** |
| `ChatRead` | Reads a few messages around a hit. | **Read a past chat** |

The model saves something when you tell it something lasting about yourself, how you want it to respond, your people,
interests or endeavours, or when you ask it to remember or forget something; not small talk, one-off tasks,
anything true only today, or credentials. The exact wording is on [Shared prompts](/prompts/shared/#memory)
and, for the background update, [Side prompts](/prompts/side-prompts/#memory-update).

## Search and reference chats

With this on, the model in Chat and Cowork can search your past conversations when you refer to something you discussed
before ("what did we decide about the venue?"). Search matches words, not meaning: it ranks conversations by the words in your messages, the replies and the chat
titles, and gives the model the best matches (up to 8, 6 by default) with a snippet of about 220 characters each. To read more it opens a window of at most 6 messages around a hit, each cut at 3,000 characters, and
reads on if needed. It never loads whole conversations.

It searches your own conversations in every mode (Chat, Cowork and Code). It does not see temporary chats, the
conversation you are in, or the work of sub-agents and side chats.

## Generate memory from chats

With this on, Atelier keeps lasting details from your chats in your memory without being asked. About ten minutes after a
conversation goes quiet, or as soon as you start a new one, it reads what is new (the newest
16,000 characters of your messages and the replies, not tool output) together with your current memory, on the model
that does memory work (see [Which model does the work](#which-model-does-the-work)). It keeps only lasting facts, never
passwords, keys, tokens or account numbers, and nothing it isn't sure about. Sub-agents, side chats and temporary chats are never read this way. There is no
notification when it saves something; the page shows when each entry was last updated.

Each conversation that went quiet costs one extra model request, on your Small model if you set one, so choose a cheap
one on a paid provider. A weak small model keeps worse notes; if the entries are poor, turn this off.

When it is off, nothing is saved unless you explicitly ask Atelier to remember something, and nothing is read in the background. What is already in your memory is still used. To stop
Atelier using memory at all, delete the entries, or use a temporary chat with **Start fresh**.

## Sensitive topics

**Include sensitive topics in memory** is off by default. While it is off:

- Atelier doesn't keep details about your health, religious or political beliefs, sexuality, ethnicity or finances. The
  background update is told not to, and when the model saves an entry it marks as private, the save is refused
  ("The person's settings don't allow remembering health, beliefs or similar private topics, so this wasn't saved.").
- Entries already marked as sensitive aren't used in conversations or found by search. You still see them in Settings
  and can delete them.

Turn it on to have those remembered and used too. The marking is the model's judgment, so it can miss: if something
doesn't belong in memory, delete the entry. Editing an entry that is already marked as sensitive, from its own page,
works either way.

## Your memory

<!-- screenshot: Settings › Memory with the three switches, Start import, the list of entries and the bar at the bottom -->

Below the switches, the page lists **You** (Preferences, Profile), then **Topics**, **Areas**, **People** and **Projects**.
Each row shows the title, the summary and when it was last updated. Project notes are grouped under their
project; click the project's row to expand it. Click an entry to open it:

- **Delete** forgets the entry after a confirmation. For Preferences and Profile the button is **Clear**, which empties
  the entry.
- **Edit** changes the title, summary and details directly (one fact per line). It is there only when your
  administrator turned on **Let people edit memory by hand**; otherwise memory changes only through Atelier.
- The bar at the bottom, "Tell Atelier what to change", edits that entry in your words ("He's five now"). It can only
  change the entry you are on.

The bar at the bottom of the list ("Tell Atelier something to remember") takes anything to remember, change or forget
across your whole memory: "Keep lists under five things", "Forget my old job". A line under it
says what happened, for example "Updated Preferences", "Saved Beans and 2 more" or "Nothing to change in memory". A request can be up to 4,000 characters.

The model menu in the bar and the import dialog picks the model for that request (see [Which model does the
work](#which-model-does-the-work)); a pick is kept until you close the window.

## Areas and projects

**Areas** are for larger ongoing things of your own, such as an app you are building. They are general
memory: every chat can see them.

**Projects** notes belong to one Atelier project. Chats in that project read them, and save facts that only matter to the
project there. Chats outside the project, and chats in other projects, never see them. Notes of a project you delete
aren't deleted: they stay and show up as **Areas**.

## Temporary chats

A [temporary chat](/chat/) never appears in your history, search or lists, and is deleted when you leave it. What it does
with memory is chosen in **Settings › Privacy › Temporary chats**:

- **Don’t save (default):** the model may use your memory and your instructions, but nothing from the chat is written to
  memory, and the chat can't be found by past-chat search.
- **Start fresh: also ignore memory and personal instructions:** the model gets no memory, no personal instructions, no
  name and no project, and cannot search your past chats. Administrator instructions and safeguards still apply.

Start one with the ghost button at the top right of the new-chat page, **File › New Temporary Chat**, or ⇧⌘N
(Ctrl+Shift+N). It is Chat only.

## Which model does the work

Background saving, the bars, imports and hand-written requests all use a model to turn text into changes. Which one, in
order:

1. The model you picked in the bar or import dialog, if any (it must be one you can use).
2. Otherwise the first of these that works: the **Small model** (**Settings › Admin › Models**; on a server that holds one
   model at a time, the conversation's model instead, to avoid swapping), the model of the conversation, your own
   **Default model** (**Settings › General**), **Default model for everyone** (**Settings › Admin › Models**), and finally
   the first available model.

A model that can't answer (its provider removed or off, the model hidden) is skipped. If none is available, you see
"Memory couldn't be updated: No model is available to update memory. Add a model provider first." A request is given up
after ten minutes. Background updates have the lowest priority on a model server, behind your own conversations; the
bars and the import go ahead of the queue.

## Import memory

To bring what another assistant knows about you into Atelier, choose **Start import**:

<!-- screenshot: the Import memory to Atelier dialog -->

1. Copy the prompt (**Copy**) into a chat with your other assistant. It asks for everything that assistant has stored
   about you, word for word where possible, in sections (Instructions, Identity, Career, Interests, People, Projects,
   Preferences), one entry per line as `[YYYY-MM-DD] - Entry`, inside one code block.
2. Paste the answer back and choose **Add to memory**. A model sorts every line into your memory and merges it with what is
   there: instructions and preferences into Preferences, identity and career into Profile, interests with some depth
   into Topics, larger endeavours into Areas, people into People, and projects that match one of your Atelier projects
   by name into that project's notes (other projects become Areas).

A long export is read in parts of about 6,000 characters, cut at section headings, and each part sees what the earlier
ones wrote. The dialog shows its progress ("Adding 3 of 7… This can take a few minutes.") and ends with what it did:
"Added 4 entries, updated Profile and Preferences." Check the result in the list and correct anything wrong with the
bar. An import adds lines, and replaces one only when the export has a newer version of the same fact; it never deletes an entry or removes a line. If it stops part-way, the message says what was added before the error.
"Nothing in it could be added to memory. Check that you pasted the whole answer." means the model found nothing it
could use.

## Controls

| Control | Where | Default |
|---|---|---|
| **Search and reference chats** | **Settings › Memory** | On |
| **Generate memory from chats** | **Settings › Memory** | On |
| **Include sensitive topics in memory** | **Settings › Memory** | Off |
| **Import memory from other AI providers** (**Start import**) | **Settings › Memory** | |
| **Temporary chats** | **Settings › Privacy** | **Don’t save** |
| **Let people edit memory by hand** | **Settings › Admin › Capabilities › Memory** (admins) | Off |
| **Small model** | **Settings › Admin › Models** (admins) | Same as the chat |

Each switch is personal and takes effect from the next message. There is no administrator switch that turns memory off for
everyone; each person decides for themselves. On **Run on this computer** you are the administrator.

## Your data

Memory is stored in Atelier's database with your account and goes with it if the account is deleted. **Settings › Privacy ›
Export** includes it as `memory.json`. **Delete all conversations** and the history retention period delete chats but
leave your memory alone; delete entries on the Memory page. Memory goes to whichever model provider handles the
conversation or the memory request, like anything else you write; see [Privacy](/privacy/).

## When something goes wrong

| Message | What it means |
|---|---|
| `Memory couldn't be updated: …` | The bar, import or hand edit failed; the rest of the message says why. |
| `No model is available to update memory. Add a model provider first.` | No usable model exists. Add a provider in **Settings › Admin › Providers**. |
| `The chosen model isn’t available. Choose another one, or Default.` | The model you picked in the menu is gone or hidden. |
| `That memory no longer exists.` | The entry was deleted in another window. |
| `Editing memory by hand is turned off. An administrator can turn it on in Settings.` | **Let people edit memory by hand** is off. |
| `An entry needs a title.` | A hand edit left the title empty. |

If the model never seems to use your memory, check that you aren't in Code or a **Start fresh** temporary chat, and that
the entry isn't marked sensitive while **Include sensitive topics in memory** is off.
