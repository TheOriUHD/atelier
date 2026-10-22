---
title: Accounts and roles
description: How people join an Atelier server, what admins and users can do and see, how sign-in sessions work, and the Account and Users pages control by control.
---

Every Atelier backend has accounts. On a [server](/self-hosting/) there are as many as you invite; inside the desktop app
with **Run on this computer** there is exactly one, yours, with no password.

## The first admin

- **On a server**, the first account is created on the sign-in screen with the **setup token** the server prints in its
  log (`docker compose logs atelier | grep setupToken`). That account is the **admin**. The token works only while the
  server has no accounts. See [Run it](/self-hosting/#run-it).
- **With Run on this computer**, the first screen asks only for your name. Atelier derives a username from it, gives the
  account a random password nobody sees, and signs you in by itself on every start.

## Roles

| Role | Can |
|---|---|
| **Admin** | Everything a user can, plus the **Admin** group in Settings: **Providers**, **Models**, **Capabilities** (web, instructions for everyone, memory editing, content safeguards), **Code** (permission rules and the system AGENTS.md for everyone), **Connectors**, **Plugins**, **Keys & secrets**, **Users**, **Server** and **Developer**. |
| **User** | Their own conversations, projects, memory, files and preferences: **General**, **Account**, **Privacy**, **Memory**, **Usage**, **Code**, **Folders**, **Cloud** and **Skills** in Settings. They see and can use whatever providers, models, connectors and plugins an admin set up, but cannot change them. |
| **Pending** | A person who asked for an account while sign-up was open and waits for an admin. They cannot sign in. |

A server needs at least one active admin. The last one cannot be demoted, disabled or deleted ("This is the only admin.
Make someone else an admin first."), and nobody can change their own role or delete themselves on the Users page.

### What admins can and cannot see

Every request to the backend is scoped to the signed-in account, so the screens for conversations, projects, files,
memory and artifacts show only your own.

What an admin **can** see in Atelier:

- The list of accounts: name, username, role, status and when each was last active.
- **Settings › Usage › Everyone**: requests, tokens and cost by day, provider, model and mode, added up across all
  accounts. It is not broken down by person.
- Which settings and connectors use a stored secret (**Keys & secrets**), though never the secret's value.
- **Developer**: each connector's log, and, only while **Record provider requests** is on, the web address, status,
  timing and size of the requests the server sent to model providers, with credentials masked. Prompts and replies are
  never recorded there. It is not attributed to people.

What an admin **cannot** do in the app: read, search or open another person's conversations, memory or files; or see
another person's personal GitHub token or saved SSH passwords (these are hidden from admins).

What an admin **can** do to a person: reset their password. Whoever signs in first with the temporary password chooses
the new one, so an admin can take over an account and read what is in it. The person notices, since they are signed out
everywhere and their old password stops working, but it is possible. Likewise anyone who runs the server's host can read
the database. Treat admins as people you would trust with that, and see [Security](/security/) and
[What leaves your machine](/privacy/#who-can-see-what).

Admins also shape what models are told: **Instructions for every conversation** and the system **AGENTS.md** apply to
everyone, and **Content safeguards** can be switched on for everyone or per person.

## Adding people

There are three ways, and you can use all of them together.

### Invite codes

**Settings › Admin › Users › Create invite code**, then choose the **Role** the new account gets and **Create code**. The
code looks like `A1B2-C3D4-E5F6-G7H8`. It is shown once, with **Copy**: give it to the person privately.

- It creates **one account** and works **once**, for **7 days**.
- The person opens the server and chooses **I have a code** under the sign-in form, enters the code (**Join with a
  code**), then fills in name, username and password. It signs them in.
- Case, dashes and spaces do not matter. Codes never contain I, L, O or U, so a typed I or L counts as 1 and O as 0.
- The server stores only a hash of the code. The **Invite codes** list shows each open code as `••••-••••-••••-XXXX`
  with its role, creation and expiry, and **Revoke**. Used and expired codes drop out of the list.
- In a desktop app on **Run on this computer**, **Create invite code** only says "Invite codes need an Atelier server",
  because nobody else can reach that backend.

### Sign-up with approval

**Settings › Admin › Server › Sign-up** has two values: **Invite only** (the default) and **Open, with approval**. With
it open, the sign-in screen offers **Create an account**; the person fills in the form (**Request account**) and then sees
"Waiting for approval". The request appears under **Settings › Admin › Users › Waiting for approval**:

- **Approve** makes them a **User**. (Make them an admin afterwards from the role menu.) They sign in with the username and
  password they chose.
- **Reject** deletes the request.

There is no throttle on sign-up requests themselves, so an open server can collect pending requests from anyone who can
reach it. Leave sign-up on **Invite only** unless you need otherwise.

### Add user

**Settings › Admin › Users › Add user** asks for **Full name**, **Username** and **Role** and creates the account at once.
Atelier shows a **Temporary password** once: give it to the person. They sign in with it and are asked to **Choose a new
password** before anything else.

Usernames are 2 to 32 characters: lowercase letters, digits, dots, dashes and underscores, starting with a letter or
digit. Atelier lowercases what is typed. Passwords are 8 to 256 characters and are stored as scrypt hashes.

## The Users page

**Settings › Admin › Users** lists everyone who can sign in:

| Column | What |
|---|---|
| **Name** | Full name and username, with **You** on your own row. |
| **Role** | **User** or **Admin**. You cannot change your own. |
| **Safeguards** | **Default (on)** / **Default (off)** (follows **Settings › Admin › Capabilities › Content safeguards**), **On**, or **Off**, for this person. |
| **Status** | **Active**, **Disabled**, or **Temporary password** (the person has not yet chosen their own). |
| **Last active** | How long ago, or **Never**. |

Each row other than yours has a menu (**⋯**):

- **Reset password…** signs the person out everywhere and gives you a new temporary password, shown once. They must choose
  their own when they sign in with it.
- **Disable** / **Enable**: a disabled account cannot sign in, is signed out at once and shows "This account is disabled.
  Ask an admin to re-enable it." Nothing is deleted.
- **Delete…** removes the account and everything it owns: its chats, projects, files, memory, devices and passkeys. This
  cannot be undone. Usage records stay, no longer tied to a name. Scratch folders on disk are not deleted.

## Signing in

- **Password**, from the sign-in screen (**Welcome back**).
- **Passkeys**, in a browser, from **Sign in with a passkey**: your device's screen lock or a security key instead of a
  password. They need an HTTPS address with a hostname; they are not offered on IP addresses or in the desktop app. Add one
  in **Settings › Account › Passkeys**.
- **An invite code** or **Create an account** (above) for new people.
- The desktop app signs in with a password and keeps the sign-in in the system's secure storage (Keychain, Credential
  Manager, Secret Service). On a computer where Atelier can't use that, it signs you in for the session and says "You're
  signed in for now: This computer has no secure storage Atelier can use, so it can't keep you signed in."

### Sign-in sessions

Each sign-in is a session. A browser holds it in a cookie that scripts cannot read, marked Secure on HTTPS. The desktop
app holds a token in secure storage. Only a hash of the token is stored on the server.

- **Lifetime.** A session lasts 30 days from its last use; each use pushes the end out. A browser's cookie lasts 30 days
  from sign-in and is not renewed, so in a browser you sign in again after 30 days. An expired session stops working at
  once and is deleted when the server next starts.
- **Log out** (**Settings › Account › Account**) ends this sign-in. In the desktop app it also revokes the app's sign-in
  on the server, deletes the saved one and returns to the first-run choice. **Switch…** (the **Server** row) does the same
  after asking, so you can pick another server or **Run on this computer**.
- **Log out everywhere** ends every sign-in of your account, this one included.
- **Change password** keeps you signed in here and signs you out everywhere else.
- A password reset by an admin, disabling or deleting an account, and revoking a session end the sessions concerned at
  once; the open windows show the sign-in screen.

**Active sessions** (**Settings › Account**) lists every browser and app signed in to your account: **Device** (such as
"Chrome on macOS" or "Atelier Desktop on Windows", with **Current** on this one), **IP address**, **Created** and **Last
seen**. **Revoke** signs one out. The IP address is the one Atelier sees; behind a proxy that needs
`ATELIER_TRUSTED_PROXIES` to be the visitor's, not the proxy's (see [Run a server](/self-hosting/#atelier_base_url-and-atelier_trusted_proxies)).

### Rate limits and lockouts

- **Wrong passwords:** after 8 failures for the same username from the same address within 15 minutes, further attempts
  are refused with "Too many attempts. Try again in a few minutes." (HTTP 429), whether or not the password is then right.
  The count is kept in memory, so restarting the server clears it.
- **Wrong invite codes:** the same limit, counted per address.
- **Unknown usernames** cost the same time as wrong passwords, so the sign-in screen does not reveal which usernames exist.
- **The screen lock** on a computer running its own backend has its own limit: 5 wrong tries, then waits of 30 seconds
  doubling up to an hour, also across restarts. See [Security](/security/#screen-lock-on-this-computer).

## Settings › Account

On a server (in a browser or in a desktop app connected to one), top to bottom:

| Section and row | What it does |
|---|---|
| **Profile › Profile photo** | **Upload** / **Change** / **Remove**. PNG, JPEG, GIF or WebP, up to 5 MB. |
| **Full name** | Shown in the sidebar and to admins. |
| **What should Atelier call you?** | Used in greetings and shared with the model. Your full name is used when empty. |
| **Instructions** | Preferences the model keeps in mind, added to the system prompt of every new chat (up to 20,000 characters). |
| **Personality** | A style preset for new conversations, or your own **custom mode** (**Add custom mode**, **Edit mode**, **Delete mode**: up to 20, each with a name and up to 4,000 characters of style instructions). Style only, not a different model. |
| **Response style** | **Default**, **Concise**, **Explanatory** or **Formal**. |
| **Content safeguards** | Appears only when an admin switched safeguards on for you: "On, set by your administrator", with what they cover. Read-only. |
| **Instructions for Code and Cowork › Your ATELIER.md** | Your own conventions for Code sessions and Cowork tasks and their sub-agents, in Markdown (up to 60,000 characters), saved on the server so it works from every device. Where a project's ATELIER.md disagrees, yours wins. |
| **Session access › Remote control** | On by default. Whether your other browsers and devices can open this account's conversations. See [Remote control](/remote-control/). |
| **Account › Username** | What you sign in with. Fixed. |
| **Password › Change password** | Asks for the current password and a new one (8 characters or more). |
| **Log out** | See above. In the desktop app it also offers **Switch…**. |
| **Log out of all devices › Log out everywhere** | Ends every sign-in, after confirming. |
| **Passkeys** | Browser only. **Add passkey** names it and asks your browser where to keep it. The list shows **Name**, **Added** and **Last used**; removing one here does not delete it from your device or password manager. |
| **Devices** | Computers running the Atelier desktop app for your account: **Name**, **Platform**, **Added**, and **Online** or when last seen. **This computer** marks the one you are on; the others can be removed. |

On **Run on this computer** the page is shorter, because there is no sign-in to manage: **Profile**, **Instructions for
Code and Cowork**, **Screen lock** and **Setup** (**Change setup…**, which returns to the first-run choice without
deleting anything).

Related pages in Settings: **Privacy**, **Memory**, **Usage** and **General**. See
[What leaves your machine](/privacy/) and [Data and files](/data-and-files/).

## Screen lock

On **Run on this computer** only, **Settings › Account › Screen lock** sets a PIN (4 to 8 digits) or a password (6
characters or more) that Atelier asks for when it starts and whenever you lock it: **Lock now** in Settings, or **Lock
Atelier** in the File menu, the sidebar's profile menu and the command palette (⇧⌘L on a Mac, Ctrl+Shift+L elsewhere). **Lock when inactive** can lock after 5, 15, 30 or 60 minutes without
typing or clicking in any Atelier window. What it does and does not protect is in
[Security](/security/#screen-lock-on-this-computer).

## Devices

When you sign in on a desktop app connected to a server, the app registers its computer as one of your **devices**. A
device lends the folders you trusted on it to your sessions on that server: in a browser, choose **Remote Control** in the
environment menu above the Code or Cowork composer, and pick the computer. Devices belong to your account, so a shared
computer shows up once per person who signs in on it. A device shows **Online** while its app is open and linked.
Removing a device from the list forgets it; it registers again the next time its app connects.

The desktop refuses to open any folder you did not pick in its own folder picker, but a trusted folder lets the server's
sessions run commands there as you. See [Run a server](/self-hosting/#connecting-browsers-and-desktop-apps) and
[Code](/code/).

## One person on this computer

**Run on this computer** is a single-owner mode. The built-in backend has no network socket; only the app's own windows can
talk to it, and it signs the owner in without a password. You can add accounts under **Settings › Admin › Users**, but
nobody can sign in with them: the app always signs in the owner. If several people need accounts, run a
[server](/self-hosting/) and connect to it.

<!-- screenshot: Settings › Admin › Users with the invite codes list and the row menu open -->
