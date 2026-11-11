---
title: Computer use
description: Let the assistant see and use apps on your Mac, Windows PC or Linux desktop in Code and Cowork. Turn it on, allow apps one by one, decide when it may take the mouse and keyboard, and take them back by holding Esc.
---

With computer use, the assistant in a Code session or a Cowork task can look at apps on your computer and use them:
click, type, press keys and scroll, the way you would. It is for the jobs no other tool reaches, such as a native app with
no connector, or a setting that only exists in a window. Where a connector, the shell or a web fetch does the job, the
assistant uses that: working on screen is slower and less reliable.

It is off until you turn it on, it only uses apps you allow, and you can stop it at any moment.

:::note
Computer use works on **macOS**, **Windows** and **Linux** (X11), in the desktop app with **Run on this computer**. A
desktop app signed in to a server comes later. A session in the browser can't use your computer. [Linux](#linux) differs
in a few ways, which are listed there.
:::

## Turn it on

Open **Settings › System › Computer use** and switch on **Enable computer use**.

<!-- screenshot: Settings › System › Computer use with the switch on, Background selected and the permission rows -->

On a Mac, macOS asks for two permissions before Atelier can use apps. Both rows are on the same page, with **Grant…**
and **Open System Settings**:

| Permission | What Atelier does with it |
|---|---|
| **Screen recording** | Takes screenshots of the apps you allowed. macOS asks again from time to time. |
| **Accessibility** | Moves the mouse, types, and reads what is under the pointer and where the keyboard goes, so it can refuse to click a link in Mail or type into a password field. |

After you switch a permission on in System Settings, come back to Atelier: the page reads the permissions again.
Atelier never answers these questions for you.

Windows asks for nothing. Two things work differently there:

- Apps running as administrator can't be used: Windows doesn't let an ordinary app type or click into them.
- Shortcuts use **Ctrl** where a Mac uses **Cmd**, and the assistant switches apps with **Alt+Tab** or the Windows key.

## Allowing apps

**How Atelier uses the apps you allow** in Settings decides how much it asks (on Linux the first choice is called
**Ask per app**, see [Linux](#linux)):

- **Background** (the default): it works in one app at a time **in the background**: it sees that app's window as it is
  (even when other windows cover it) and clicks, types and scrolls in it without moving your pointer or bringing it
  forward, while you keep working. No note or glow shows while it does (see
  [How the background works](#how-the-background-works-macos) for the one exception, a covered window shown for a
  moment). What can't be done in the background (dragging, zooming in, lists to choose from, right clicks, or an app
  that doesn't take input there) needs Full control, and it asks you for that with a card when it needs it.
- **Full control**: it takes over your computer as it is. No cards: it may do anything in any app, terminals and code
  editors included, except your denied apps, Atelier itself and the parts of macOS that ask for passwords. Typing in a
  terminal runs commands without Atelier's permission prompts, so use Full control only when you would let it do that.
  Its screenshots show the screen as you see it,
  with your denied apps left out, and nothing is hidden: it starts from Atelier and brings the app it needs to the
  front itself.

### Allowing apps (Background)

An app you name yourself needs no card: when you write "keep browsing in Chrome", the assistant may use Google Chrome
right away. Atelier checks that against your own messages in the conversation (the app's name, or the name without the
maker, as in "Chrome" or "Word"), not against what the assistant says or what a screen shows. In co-op, only the host's
messages count. In **Bypass** no app asks.

For any other app, the assistant asks with a card: **Let Atelier use TextEdit?**, with the reason it gave. Each app
comes with what Atelier may do there:

| Choice | What it allows | Default for |
|---|---|---|
| **See only** | Screenshots of the app | — |
| **See and click** | Screenshots, left clicks and scrolling, no typing | Terminals and code editors (the most they can get) |
| **Full use** | Everything: clicks, typing, keys, dragging | Every other app, browsers included |

You can lower any of them on the card. When the assistant needs more in an app than it was given, it asks again, and
the card offers the app once more.

**Allow for this session** lets this conversation use them until it ends. **Always allow** lets every conversation on
this computer use them; they are listed under **Apps allowed for good** in Settings, with **Remove**. **Don't allow**
tells the assistant to go on without them.

Some apps are never used: Atelier itself, System Settings, the login window and the other parts of macOS that ask for
passwords. In the background its screenshots show only the window of the app it works in.

### How the background works (macOS)

On a Mac, Atelier works in an app's window the way Claude's and ChatGPT's computer use do, through private parts of
macOS's window server (SkyLight): the window takes clicks, typing and scrolling as if it were the focused one, while its
app stays behind yours and your pointer and keyboard stay with you. This works in Chrome and the other Chromium
browsers, in apps built on them (Slack, VS Code, Discord, Notion and other Electron apps) and in native apps. A few
things behave differently from the real mouse and keyboard:

- **A clay cursor shows where it works.** A small arrow of its own (your pointer doesn't move) glides to each point the
  assistant clicks or scrolls, with a ripple for a click, and stays while it types. It is drawn just above the window it
  works in, so a window of yours in front of that one covers it too, and it fades after a few seconds still. It isn't in
  the assistant's screenshots.
- **Buttons are pressed.** A plain click on a native app's button, checkbox, link or menu item is pressed through
  Accessibility, which is quicker than sending a click; browsers and Electron apps get the real click.
- **The screenshot comes with the window's controls.** Each background screenshot carries a list of the window's
  buttons, fields, checkboxes and lists, with their names and values, read through Accessibility; the assistant aims at
  one by its number instead of a pixel, so it misses less and does several steps in one go.
- **A covered window is shown for its screenshot.** Browsers stop drawing a window that other windows hide completely,
  so for each screenshot of a covered window Atelier shifts it just far enough for a strip of it to show past the
  windows in front, waits for it to draw, and puts it back. You may see that strip at the edge of your screen for about
  half a second.
- **Nothing comes forward.** In a browser the assistant uses the tab that is open: Cmd+T and Cmd+N would bring the
  browser to the front, so they aren't pressed in the background; an address goes in with Cmd+L. If an app brings itself
  forward anyway, Atelier puts your app back in front at once and tells the assistant what to avoid.
- **Lists to choose from and right clicks need Full control.** Their menus would cover your screen, and a browser turns
  a right click it gets this way into a left one.
- **Password fields aren't clicked or typed into.** A password field turns macOS's secure input on for every app while
  it has the focus; Atelier types nothing while secure input is on.
- **Typing waits for you** when you are working in another window of the same app: keys sent to it would land where you
  are typing.

These parts of macOS aren't public and can change with an update. Atelier looks them up when it needs them; without
them it falls back to the public way of sending input, in which Chrome and Electron apps take only buttons, links and
fields (through Accessibility) and the assistant asks for Full control for the rest.

### Web pages: Atelier for Chrome

With the **Atelier for Chrome** extension in Chrome, Brave, Edge or Arc, the assistant works in web pages through the
browser itself instead of its pictures:

- **In tabs of its own.** It opens pages in background tabs in an orange **Atelier** group of your browser window, never
  in your own tabs, and closes them when it is done. Your tab stays in front and the browser doesn't come forward.
- **It reads pages.** It gets the page's text and a list of its links, buttons and fields, and acts on them by name, so
  it needs far fewer screenshots and doesn't miss a button by a few pixels. It can choose from lists, which the
  background mode for apps can't.
- **Chrome says so.** While it acts in a page, the browser shows a bar saying Atelier "started debugging this browser";
  **Cancel** there stops it in that tab, and it asks you before going on. The bar goes when it has been idle a moment.
- **The same rules.** Your permission mode applies to every step that changes something (reading a page doesn't ask).
  It never types passwords or completes a purchase, and it asks before accepting terms or sending anything.

Until the extension is in the Chrome Web Store, install it from the app: **Settings › System › Computer use › Atelier
for Chrome** shows the folder; in your browser open `chrome://extensions`, turn on **Developer mode**, choose **Load
unpacked** and pick that folder. The row says **Connected in …** once it works. Atelier registers the extension's
helper with the browsers it finds each time it starts.

### Denied apps

**Denied apps** in Settings lists apps the assistant may not even ask for: requests for them are turned down without a
card. Password managers (1Password, Bitwarden, Apple Passwords, Proton Pass, KeePassXC, Dashlane) are on it from the
start. **Add app** picks any installed app; **Remove** takes one off. Denying an app takes back what it was allowed.

## The mouse and keyboard

In **Full control** (or when it asks for it in Background), acting means taking your mouse and keyboard. While Atelier
has them:

- a soft clay glow runs along the edges of every screen, and a small panel below the menu bar says **Atelier is using
  your computer · Hold Esc to stop**;
- when it took them from Background, apps it wasn't allowed are hidden, and Atelier's own windows step aside: hidden on macOS, minimized to the taskbar on Windows; **Unhide
  apps when Atelier finishes** (on by default) shows them again afterwards. Full control hides nothing;
- it keeps them for the whole task and gives them back when it is done (as it writes its reply), when it asks you a
  question, or when you stop it. When it is done or asks you something, Atelier comes back to the front. In Full control a permission prompt doesn't end it: it waits for your answer and
  carries on. In Background any card hands them back.

In **Background** it only takes them for what can't be done in the background, after a card asks **Let Atelier take
over your mouse and keyboard?** **Allow** is for this conversation; **Always allow** switches the setting to Full
control. In **Full control** it takes them whenever it acts, without asking.

### Taking your computer back

- **Hold Esc for a second.** The ring in the panel fills; when it is full the panel says **Stopped** and you have the
  computer back. The assistant hears it: it doesn't use the computer again in that reply, finishes another way if it
  can, or tells you what it couldn't do and why.
- **Press Stop** in Atelier, or send a message: that stops the reply itself.
- **Using the mouse or keyboard yourself** doesn't stop it. Moving the pointer changes nothing; when you click or type it
  waits until you have stopped for a moment (the panel says **Waiting while you use your computer**) and carries on.
  Only when you brought another app to the front does it look at the screen again before going on.
- **Turn computer use off** in Settings: whatever it was doing ends.

## What it won't do

The desktop app checks every action against what you allowed, whatever the model asks for:

- no clicks or typing in an app you didn't allow, or allowed less;
- no typing into a password field, and no typing at all while macOS's secure input is on;
- no clicking links in mail and messaging apps: the assistant checks the address another way or asks you;
- text on the screen is treated as information, never as instructions.

The assistant is also told never to type passwords, complete purchases or payments, or send messages you didn't ask for.

## Linux

Atelier talks to the **X11** display server, so it works in an X11 session and sees and controls what X11 draws. Nothing
needs to be granted, as on Windows. What differs:

- **No Background mode.** X11 can't send clicks and keys to a window that isn't in front without taking the real mouse and
  keyboard, at least not in a way that works in every app, and a Background that dropped keys in some apps would be
  worse than none. So the first choice in Settings is **Ask per app**: you allow apps one by one on a card, its
  screenshots show only those apps, and it asks before it takes over your mouse and keyboard, hiding your other apps
  (minimizing them) while it does. **Full control** is the same as elsewhere.
- **Wayland sessions are limited.** On Wayland, Atelier can only see and control apps that run through XWayland (apps
  that speak X11); apps that talk to Wayland directly don't show up in its screenshots (X11 knows nothing of them) and can't be
  clicked. Some desktops also hold back input sent to XWayland apps. Settings shows a note when you
  are on a Wayland session. For all your apps, log in to an X11 session (most login screens offer one under a gear
  icon). Using Wayland's own screen sharing and remote desktop portals, which need your consent each time, isn't built
  yet. With no X server at all (a text console, or Wayland without XWayland) computer use is unavailable, and Settings
  says so.
- **Password fields aren't recognized.** On macOS and Windows Atelier can tell that a field is a password field and
  refuses to type into it. It can't yet on Linux, so it relies on other safeguards: password managers (1Password,
  Bitwarden, KeePassXC, KeePass, Seahorse, KWalletManager, Enpass, Proton Pass) are on the denied list from the start,
  authorization and password prompts (polkit agents, pinentry, askpass, the keyring's prompt), lock screens and system
  settings are never used, and the assistant is told never to type a password. Links in mail apps aren't recognized
  either, so Thunderbird, Evolution and the like are treated as mail but a link in them can't be told from other text.
- **Apps running as another user** (a window opened with sudo or pkexec) are never used.
- **Desktop entries name the apps.** The apps Atelier offers are the ones with a desktop entry (the launcher entries of
  your distribution, Flatpak and Snap); an app that is running without one is named after its window class.
- **The screen.** The glow along the screen's edges is a thin accent frame on Linux, because a soft glow needs a window
  that is see-through, and many X sessions run without the compositor that requires. The frame and the panel go away for
  the moment of each screenshot, so they are not in it. Atelier's own windows are minimized while it works, as on
  Windows.
- Shortcuts use **Ctrl** where a Mac uses **Cmd**, and the assistant switches apps with **Alt+Tab**.

## In the transcript

Computer use steps read like the others: "Took a screenshot", "Clicked", "Typed", with the screenshots as small
thumbnails beside the summary line (hover to preview, click to open). Only the newest few screenshots go back to the
model with each request; the conversation keeps them all.

### The live view

While a Cowork task works in an app or a web page, the top of the panel beside it shows what it last saw: the app's
window or the page, its name, and the step it is on ("Clears the calculator"). Click the picture to see it full size.
**✕** hides the view for that task while the task goes on; **Show what it sees** brings it back. In the desktop app,
**Pop out** opens it in a small window that stays above your other windows, so you can follow along while you work in
something else. The view goes away when the task ends; the popped-out window says "Finished" and stays until you close it.

## Permissions and modes

Computer use follows the [permission mode](/permissions/) like everything else the assistant does:

- **Looking** (screenshots, scrolling, waiting, the app list) never asks.
- **Clicking, typing, pressing keys and opening apps** go through the mode. **Bypass** runs them; **Auto** has its
  reviewer watch them, letting ordinary use through and stopping only for what matters (a purchase or payment, sending a
  message, deleting something, accepting terms, changing account or security settings, typing a password); **Ask** and
  **Accept edits** ask each time, listing the steps and what would be typed; **Plan** only looks.
- The card for an app asks in every mode except **Bypass**, unless you named the app yourself (see
  [Allowing apps](#allowing-apps-background)). The card for taking over the mouse and keyboard (Background) asks in every
  mode, Bypass included.
