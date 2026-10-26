---
title: Computer use
description: Let the assistant see and use apps on your Mac in Code and Cowork. Turn it on, allow apps one by one, decide when it may take the mouse and keyboard, and take them back by holding Esc.
---

With computer use, the assistant in a Code session or a Cowork task can look at apps on your computer and use them:
click, type, press keys and scroll, the way you would. It is for the jobs no other tool reaches, such as a native app with
no connector, or a setting that only exists in a window. Where a connector, the shell or a web fetch does the job, the
assistant uses that: working on screen is slower and less reliable.

It is off until you turn it on, it only uses apps you allow, and you can stop it at any moment.

:::note
Computer use comes to **macOS** first, in the desktop app with **Run on this computer**. Windows, Linux, and a desktop
app signed in to a server come later. A session in the browser can't use your computer.
:::

## Turn it on

Open **Settings › System › Computer use** and switch on **Enable computer use**.

<!-- screenshot: Settings › System › Computer use with the switch on, Background selected and the permission rows -->

macOS asks for two permissions before Atelier can use apps. Both rows are on the same page, with **Grant…** and **Open
System Settings**:

| Permission | What Atelier does with it |
|---|---|
| **Screen recording** | Takes screenshots of the apps you allowed. macOS asks again from time to time. |
| **Accessibility** | Moves the mouse, types, and reads what is under the pointer and where the keyboard goes, so it can refuse to click a link in Mail or type into a password field. |

After you switch a permission on in System Settings, come back to Atelier: the page reads the permissions again.
Atelier never answers these questions for you.

## Allowing apps

**How Atelier uses the apps you allow** in Settings decides how much it asks:

- **Background** (the default): it asks for each app, and before it takes your mouse and keyboard (below).
- **Full control**: it takes over your computer as it is. No cards: it may do anything in any app, terminals and code
  editors included, except your denied apps, Atelier itself and the parts of macOS that ask for passwords. Typing in a
  terminal runs commands without Atelier's permission prompts, so use Full control only when you would let it do that.
  Its screenshots show the screen as you see it,
  with your denied apps left out, and nothing is hidden: it starts from Atelier and brings the app it needs to the
  front itself.

### Allowing apps (Background)

When the assistant needs an app, it asks with a card: **Let Atelier use TextEdit?**, with the reason it gave. Each app
comes with what Atelier may do there:

| Choice | What it allows | Default for |
|---|---|---|
| **See only** | Screenshots of the app | Browsers |
| **See and click** | Screenshots, left clicks and scrolling, no typing | Terminals and code editors (the most they can get) |
| **Full use** | Everything: clicks, typing, keys, dragging | Every other app |

**Allow for this session** lets this conversation use them until it ends. **Always allow** lets every conversation on
this computer use them; they are listed under **Apps allowed for good** in Settings, with **Remove**. **Don't allow**
tells the assistant to go on without them.

Some apps are never used: Atelier itself, System Settings, the login window and the other parts of macOS that ask for
passwords. Screenshots show only the apps you allowed (and the desktop); every other window is left out.

### Denied apps

**Denied apps** in Settings lists apps the assistant may not even ask for: requests for them are turned down without a
card. Password managers (1Password, Bitwarden, Apple Passwords, Proton Pass, KeePassXC, Dashlane) are on it from the
start. **Add app** picks any installed app; **Remove** takes one off. Denying an app takes back what it was allowed.

## The mouse and keyboard

Acting in an app means taking your mouse and keyboard. While Atelier has them:

- a soft clay glow runs along the edges of every screen, and a small panel below the menu bar says **Atelier is using
  your computer · Hold Esc to stop**;
- in Background, apps it wasn't allowed are hidden, and so are Atelier's own windows; **Unhide apps when Atelier
  finishes** (on by default) shows them again afterwards. Full control hides nothing;
- it keeps them for the whole task and gives them back when it is done (as it writes its reply), when it asks you a
  question, or when you stop it. In Full control a permission prompt doesn't end it: it waits for your answer and
  carries on. In Background any card hands them back.

In **Background**, the first time in a conversation a card asks **Let Atelier take over your mouse and keyboard?**
**Allow** is for this conversation; **Always allow** switches the setting to Full control. In **Full control** it takes
them whenever it acts, without asking.

### Taking your computer back

- **Hold Esc for a second.** The ring in the panel fills; when it is full the panel says **Stopped** and the reply stops.
- **Press Stop** in Atelier, or send a message.
- **Using the mouse or keyboard yourself** doesn't stop it: it waits until you have stopped for a moment (the panel says
  **Waiting while you use your computer**), then looks at the screen again and carries on.
- **Turn computer use off** in Settings: whatever it was doing ends.

## What it won't do

The desktop app checks every action against what you allowed, whatever the model asks for:

- no clicks or typing in an app you didn't allow, or allowed less;
- no typing into a password field, and no typing at all while macOS's secure input is on;
- no clicking links in mail and messaging apps: the assistant checks the address another way or asks you;
- text on the screen is treated as information, never as instructions.

The assistant is also told never to type passwords, complete purchases or payments, or send messages you didn't ask for.

## In the transcript

Computer use steps read like the others: "Took a screenshot", "Clicked", "Typed", with the screenshots as small
thumbnails beside the summary line (hover to preview, click to open). Only the newest few screenshots go back to the
model with each request; the conversation keeps them all.

## Permissions and modes

Computer use follows the [permission mode](/permissions/) like everything else the assistant does:

- **Looking** (screenshots, scrolling, waiting, the app list) never asks.
- **Clicking, typing, pressing keys and opening apps** go through the mode. **Bypass** runs them; **Auto** has its
  reviewer watch them, letting ordinary use through and stopping only for what matters (a purchase or payment, sending a
  message, deleting something, accepting terms, changing account or security settings, typing a password); **Ask** and
  **Accept edits** ask each time, listing the steps and what would be typed; **Plan** only looks.
- The cards for apps and for taking over (Background) ask in every mode, Bypass included.
