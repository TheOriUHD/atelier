---
title: Remote control
description: The account switch and per-conversation toggle that decide whether your other browsers and devices can open your conversations on a server, and how it differs from the Remote Control environment in Code.
---

**Remote control** decides whether the conversations you start on a server can be opened from your other
sign-ins: another browser, another computer's desktop app, a phone's browser. It is **on by default**: sign in anywhere
and your chats are there. You can switch it off for the whole account, or for single conversations, when you want a
conversation to stay on the device where you started it.

Nobody else's account can open your conversations either way, and admins cannot (see
[Accounts](/accounts/#what-admins-can-and-cannot-see)). It only concerns the sign-ins of **your own account**.

:::caution[Not the Remote Control environment]
Code and Cowork also have an environment called **Remote Control**, in the menu above the composer next to Local, Cloud
and SSH. That one chooses *where a session runs*: in a folder on another of your computers, through its desktop app. This
page is about *who can open the conversation*. See
[Two things called Remote control](#two-things-called-remote-control).
:::

## What it covers

When remote control is on for a conversation, every browser and desktop app signed in to your account can:

- see it in the sidebar and in search, and open it;
- watch a reply or a Code session as it streams;
- continue it: send messages, stop it, answer its permission prompts and questions, rename or delete it.

Conversations include Chat, Cowork and Code, their sub-agents and side chats. A conversation's artifacts follow it: another
sign-in cannot open them when remote control is off (see the limits under [Security model](#security-model)).

When it is off for a conversation, **only the sign-in that created it** can see it. To every other sign-in of yours it is
absent from the lists, cannot be opened ("That conversation is unavailable on this device."), and its live updates stop at
once, in windows that already had it open too.

## The two switches

### For the whole account

**Settings › Account › Session access › Remote control.**

Switch it off and every conversation becomes visible only to the sign-in it was made in. A conversation with no recorded
origin is tied to the sign-in you switch it off from. Switch it on again and conversations that allow it are shared with
all your sign-ins again.

### For one conversation

Click the conversation's title in its header to open its menu. The item reads **Remote control: On** or **Remote control:
Off**; choosing it flips the setting for this conversation only. When the account switch is off, it reads **Remote control
disabled in account** and cannot be changed. It is in Chat, Cowork and Code conversations on a server, not in temporary
chats.

New conversations start with remote control on. Sub-agents and side chats follow the conversation they belong to.

<!-- screenshot: the conversation title menu open, showing "Remote control: On" -->

## Where it applies

| Where you use Atelier | Remote control |
|---|---|
| A browser signed in to a server | Yes. |
| The desktop app connected to a server (**Connect to a server**) | Yes. |
| The desktop app on **Run on this computer** | Not offered: one backend, one owner. The row in **Settings › Account** and the menu item do not appear. |

## What "the sign-in that created it" means

The unit is the **sign-in**, not the device or the browser. Each time you log in you get a new one; each browser and each
desktop app has its own. Consequences:

- Two tabs in the same browser share one sign-in, so they see each other's private conversations. Two browsers, or a
  browser and a desktop app, do not.
- **If you log out, or the sign-in expires** (30 days for a browser's cookie), a conversation that was private to it can no
  longer be opened by anything. Switching the account setting back on makes conversations that individually allow remote
  control visible again. One you switched off individually stays unreachable, since no sign-in of yours can flip its
  switch; it is still in the database, **Settings › Privacy › Export** includes it, and **Delete all…** removes it.
- So switch a single conversation off only when you mean to keep using it from the sign-in you are in now.

## Security model

- It is access control between **your own sign-ins**, enforced in the server: the conversation list, opening, every
  action on a conversation, and the live event stream all check it. It is not enforced for people who can read the server's
  database or files, nor for anyone with your password, a passkey, or an unlocked signed-in device. See
  [Security](/security/).
- It does not hide everything a conversation left behind. The **Artifacts** page of another sign-in still lists the titles of
  a private conversation's artifacts (opening one fails). Files are fetched by their id or content hash, which this setting
  does not check. Memory that Atelier built from a private conversation belongs to the account and is read in all your
  sign-ins.
- By default every sign-in sees everything; the switch only narrows that.
- **There is no admin setting** for it; each person decides for their own account.
- If a device you no longer trust is signed in, **revoke it** in **Settings › Account › Active sessions** (or **Log out
  everywhere**). Remote control is not a substitute for that.

## Two things called Remote control

| | Remote control *(this page)* | Remote Control (environment in Code and Cowork) |
|---|---|---|
| Where | **Settings › Account › Session access**, and a conversation's title menu | The environment menu above the composer: **Local**, **Cloud**, **Remote Control**, **SSH** |
| What it decides | Who among your sign-ins can open a conversation | Which computer a session works on |
| Needs | An account on a server | A desktop app, signed in to the same server, online, with a folder you trusted |
| On the desktop's own backend | Not offered | Shown, but lists "No other computers" until you connect to a server |
| Turned off by | The account switch or the conversation menu | Choosing another environment |

They are independent. Switching the account's remote control off does not take away the **Remote Control** environment,
and using that environment does not need the account switch to be on. A Code session you run in a folder on your desktop
from a browser is a conversation like any other: whether *other* devices can open it follows the switches above, while
the work still happens on the desktop through its own link. How that link works, and why trusting a folder
lets a server's sessions run commands as you on that computer, is in [Run a server](/self-hosting/#connecting-browsers-and-desktop-apps)
and [Code](/code/).
