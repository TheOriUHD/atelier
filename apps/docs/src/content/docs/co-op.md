---
title: Co-op
description: "Work in one session with up to three other people: the same conversation, the same folder, each typing and watching the agent work. Everyone answers with the host's models or their own. No account."
---

With co-op, up to four people work in one chat or Code session together. Everyone sees every reply as it is
written and every change as it lands, writes their own messages, and picks which model answers them.

The session stays where it is: on the computer of the person who started co-op (the **host**), or on your team's
server. Nobody needs an account with Atelier.

- **Between two computers**, the desktop apps meet through an encrypted relay at `coop.atelierhq.dev`. It passes the
  traffic on and can't read it. See [Privacy](#privacy).
- **On a team server**, the host adds teammates who have accounts there. Nothing leaves the server.

## Start co-op

Open the session and click **Co-op** (the two-person button) in its header.

**On your computer:**

1. Click **Copy invite link** and send the link to the people you want to work with, in a chat or by email.
2. They click it. Atelier opens on their computer with the join card, and they click **Join**.
3. You see **Ben wants to join** with four emoji. Ben sees the same four. Compare them, by voice or in another
   chat, and click **Let in**. If they don't match, someone else is in between: click **Decline**.

**On a team server:** pick people under **Teammates**, choose what they can do, and add them. They see the session in
their sidebar straight away.

The link lets new people ask to join for 24 hours. A new link replaces it, and the old one stops working. Someone you
let in before comes back to the session without a link and without asking again, even after the link expired, until
you remove them or end co-op.

## Join a session

Click the invite link someone sent you. It opens a page at `atelierhq.dev/join` that hands the invite to the app;
the page sends nothing anywhere. The join card says whose session it is, that it runs on their computer, and what
you share. Choose what answers your messages, then click **Join** and wait for the host to let you in.

If the link doesn't open Atelier (a Linux AppImage, for example, can't register it), open Atelier yourself and paste
the link into **File › Join a Co-op Session…** in the desktop app, **More › Join a co-op session…** in the sidebar,
or the same command in the command palette.

To join a session on another computer you need the desktop app in **Run on this computer** mode. A desktop signed in
to a server joins co-op sessions on that server only.

## Working together

- Each person's messages show their name and picture; **Ben is typing…** shows under the conversation.
- **Your turn and theirs.** While someone else's turn runs, what you send waits as yours, and is answered next. Click
  **Join this turn** to give it to the running turn instead; **Take back** returns it to your message box.
- **Stop** stops the running turn, whoever's it is. Everyone else's waiting messages stay.
- **Retry**, **Continue** and editing your own message run as you: your choice of model, your cost.
- Switching branches and rewinding are the host's.
- **Can chat** people write and run turns; **Can watch** people follow along and add reactions.
- **Your sidebar is yours.** A guest can pin the session, rename it, put it in one of their groups, archive it and
  mark it unread. Only they see that: the session keeps its name and place for the host and everyone else.
- **Sub-agents and tracks.** Everyone can open the transcript of a sub-agent or a track, and in Code the
  **Background tasks** pane with what runs in the background. Stopping and clearing them is the host's.

## Whose models answer you

Each person chooses under **Answer my messages with**:

- **The host's models**, while the host shares them (**Guests can use my models**). The host pays. The host can set
  how much each guest may use a day, in requests and in dollars for priced models. **Up to [50] requests a day each**
  is the default.
- **Your models**: your own providers, plans and keys, on your computer. The host's computer sends each request to
  yours; your keys never leave it. Your own limits apply, and the use shows on your own Usage page. The host agrees
  to it once with **Guests' own models read what the session reads**: a guest's model then reads what the session
  reads, the host's files included.

You can change it any time. For one message, type `@` and pick a model: it answers that message only. **Second
opinion** on a reply asks one of your models the same question; the answer appears beside the first, ‹ 1/2 ›.

If a guest answers with their own model and their computer goes offline, their turn stops with an error. It never
falls back to the host's models.

## Approvals

The host's folder, terminal and computer are the host's. In a guest's turn:

- Everything that would ask the host asks the host, in every mode: the host's **Always allow** rules, Auto mode and
  Bypass don't apply to guests' turns. A guest's turn edits files at most as far as **Accept edits** would, and an edit
  to what configures git, shells, editors or the agent (`.git/`, `.claude/`, `.atelier/`, `.vscode/`, shell startup
  files and the like) asks the host even then.
- A guest's message that joins the host's turn (**Join this turn**) makes the rest of that turn a guest's turn too.
- The question shows **Waiting for Ada to approve…** to everyone else. Nobody answers it within 5 minutes: it is
  declined, and the agent is told.
- **Trust with approvals** lets a guest answer these questions in the host's place, for this session only. They can't
  make rules that last beyond it.
- Only the host's own answers can set **Always allow** or project rules.

A guest can lend their own connectors to their turns with **Use my connectors in my turns**. Each call then asks that
guest, and their computer runs only the calls they allowed, once each.

## Navigator

Turn on **Review edits with my model (navigator)** and your model looks over each edit the agent makes in the others'
turns. When something looks wrong, a short note from you joins the edit's result: the agent reads it and can fix it.
One person at a time is the navigator. It uses your model and your share of the host's, like your own turns.

## Parallel tracks

In a Code session whose folder is a git repository on the host's computer, **Start a track…** gives an agent a task to
work on for you, beside the conversation, in its own copy of the repository (a git worktree on its own branch, kept in
Atelier's data folder). When it finishes, the conversation hears about it.

**View changes** shows what it changed, and the **Background tasks** pane shows its transcript as it works. The host
clicks **Merge** to merge its branch into the folder, or **Close** to stop it and remove its copy. A track that doesn't merge cleanly is refused, and the folder stays as it was.

## Reactions

Hover a message and pick an emoji. Everyone sees who reacted.

## Leaving and ending

- **Leave** takes you out of a session you joined.
- The host can **Remove** anyone. Their turn stops, their waiting messages and open questions go, and the work they
  started in the background stops.
- **End co-op** ends it for everyone. The session is the host's alone again.
- **Guests keep a copy when co-op ends** (on by default) gives each guest the conversation as a session of their own.

## When the host's computer is away

While a session has co-op on, the host's computer stays awake (its screen may still turn off). If it goes to sleep or
offline anyway, guests see that it is away, and the session goes on when it is back. The screen lock hides the host's
own windows only; guests carry on, and questions for the host wait and time out as above.

## What a shared session leaves out

A co-op session is the same for everyone in it, so it doesn't carry anything personal:

- no memory, no "call me", no personalization and no personal instruction files (the folder's own instruction files
  still apply), and no [project](/projects/)'s files or instructions;
- no tools that reach outside the session: other sessions, moving to another folder, adding connectors, computer use,
  usage figures and memory search;
- connectors are those of the person whose turn it is: the host's in the host's turns, a guest's own if they lend them;
- the stricter safeguards setting of everyone in it applies.

Each message reaches the model with its writer's name, added by Atelier, so the model knows who asked what. Text that
looks like such a name tag inside a message is that person's own text.

## Privacy

Between computers, the traffic goes through the relay end to end encrypted (Noise, with the invite's secret and each
computer's device key), only while co-op is on. The relay sees the computers' IP addresses, the room's id, when
people connect and how much they send. It sees no names, messages, files or emoji, and keeps nothing.

The part of the invite link after `#` is the secret: browsers don't send it to any server, and the relay never sees
it. Anyone with the link can ask to join for 24 hours, so send it to the people you mean; you still let each one in.

Everyone in a session sees everything in it: messages, replies, tool calls, the changes the agent made in the
host's folder, and attachments. They see nothing else of the host's: no other sessions, settings, files beyond the
session's changes, terminal or connectors.

See [Privacy](/privacy/) and [Security](/security/).

## Your own relay

The relay is in the repository (`deploy/coop/`, a Cloudflare Worker), and a self-hosted server can run one too:

- On a server, set `ATELIER_SERVE_COOP_RELAY=1`; it serves the relay at `/api/coop`.
- On every desktop that takes part, set `ATELIER_COOP_RELAY` to that address (`https://atelier.example.com/api/coop`).
  The host and every guest must use the same relay. An empty value switches co-op between computers off.

See [Environment variables](/environment-variables/).
