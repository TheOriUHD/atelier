---
title: Install
description: Install the Atelier desktop app on macOS, Windows or Linux, and find out where it keeps its data, how it updates, and how to remove it.
---

The desktop app runs on macOS, Windows and Linux. If someone runs an Atelier server for you
([Self-hosting](/self-hosting/)), you can also use it from a browser with no installation.

## Where the downloads come from

- **[atelierhq.dev/download](https://atelierhq.dev/download/)** detects your system and lets you pick another build. It
  lists the newest stable release.
- **The [GitHub releases page](https://github.com/TheOriUHD/atelier/releases)** has every version, with release notes,
  plus the macOS `.zip` builds, `.blockmap` files and the `latest*.yml` update files the in-app updater reads. For a
  first install you only need the file below for your system.

| System | File | Notes |
|---|---|---|
| macOS, Apple silicon (M1 and later) | `Atelier-<version>-arm64.dmg` | |
| macOS, Intel | `Atelier-<version>.dmg` | |
| Windows 10 and 11 | `Atelier-Setup-<version>.exe` | One installer for x64 and ARM64. |
| Debian, Ubuntu and relatives, x86-64 | `Atelier-<version>-amd64.deb` | Preferred on Linux. |
| Debian, Ubuntu and relatives, ARM64 | `Atelier-<version>-arm64.deb` | |
| Any Linux, x86-64 | `Atelier-<version>.AppImage` | |
| Any Linux, ARM64 | `Atelier-<version>-arm64.AppImage` | |

The files are between about 100 and 250 MB. Atelier needs a model to be useful, and none is included: see
[Get started](/getting-started/#connect-your-first-model).

## macOS

macOS 13 (Ventura) or later. Not sure whether you have **Apple silicon** or **Intel**? **About This Mac** in the Apple menu
names the chip.

1. Open the disk image and drag Atelier to **Applications**.
2. Open Atelier from Applications.

**Signing.** The macOS builds are signed with a Developer ID and notarized by Apple, so they open without macOS's
"unidentified developer" or "can't check it for malicious software" warning; at most macOS asks once to confirm a
download from the Internet, and you choose **Open**. If you do get the malicious-software warning, the copy you have was
not notarized, for example one you built yourself or a package straight from CI: right-click Atelier, choose **Open**,
and confirm. If the app was quarantined by a download or copy, this also clears it:

```bash
xattr -dr com.apple.quarantine /Applications/Atelier.app
```

**Keep Atelier in Applications.** Atelier updates itself by replacing its own app. It downloads the new version as a
`.zip`, checks it, and unpacks it into its own profile folder. Once Atelier quits, a small helper moves the old app aside
and the new one into its place; **Restart** in the sidebar does this and opens the new version at once, and if you just
quit, the next start is the new version. That needs the app to sit where it can be replaced, as it does in Applications.
Run from the disk image, or from a quarantined copy in Downloads, Atelier can't replace itself: the sidebar then offers
**Download**, which saves the new disk image to your Downloads folder and shows it in Finder, and you drag it to
Applications yourself.

**A server on your local network.** The first time Atelier connects to one, macOS asks whether it may find devices on your
local network. Allow it, or Atelier can't reach the server: the "Connecting to …" screen then says macOS is blocking the
app and offers **Open Local Network settings** (System Settings › Privacy & Security › Local Network). The prompt reads
"Atelier connects to your local model servers, SSH hosts, and self-hosted services on your network."

## Windows

Windows 10 and 11, on 64-bit Intel or AMD and on ARM. Run `Atelier-Setup-<version>.exe`.

**The installer is not code-signed.** Windows SmartScreen may show "Windows protected your PC" and name an unknown
publisher. Choose **More info**, then **Run anyway**. Atelier's own updates are still checked against a signature made with
the publisher's key (see [Updates](/updates/)), but the first installer is only as trustworthy as where you got it, so
download it from the pages above.

The installer is a wizard:

1. **License:** the PolyForm Noncommercial License 1.0.0 (see [License](/license/)).
2. **Choose Installation Options:** **Only for me** or **Anyone who uses this computer (all users)**.
3. **Install location**, which you can change. A folder without "Atelier" in its name gets an `Atelier` folder added.

| | Only for me | All users |
|---|---|---|
| Installs to | `%LOCALAPPDATA%\Programs\Atelier` | `C:\Program Files\Atelier` |
| Needs administrator rights | No | Yes (Windows asks) |

The installer adds a desktop shortcut, a Start menu shortcut called **Atelier** and an entry in **Settings › Apps** for
uninstalling. For scripted installs, `Atelier-Setup-<version>.exe /S` runs it silently; add `/allusers` or `/currentuser`
to choose the mode, and `/D=<folder>` (last on the command line, without quotes) to choose the folder. Updates install
silently and start Atelier again.

Code runs commands with Git Bash when [Git for Windows](https://git-scm.com/download/win) is installed, and with Windows
PowerShell otherwise; its terminal opens PowerShell 7 if you have it, else Windows PowerShell. Windows is less tested than
macOS.

## Linux

| Package | For |
|---|---|
| `.deb` (x86-64, ARM64) | Debian, Ubuntu and their relatives. Preferred. |
| AppImage (x86-64, ARM64) | Any distribution. |

**The `.deb`.** Install it with your package manager:

```bash
sudo apt install ./Atelier-<version>-amd64.deb
```

It needs `sudo` because it installs into `/opt/Atelier`, links the `atelier` command into `/usr/bin`, adds a desktop
entry, sets the permissions of the browser sandbox helper and, where AppArmor supports it (Ubuntu 24 and later), installs
an AppArmor profile (`/etc/apparmor.d/atelier`). Start Atelier from your application menu or by running `atelier`.

**The AppImage.** Make it executable and run it:

```bash
chmod +x Atelier-<version>.AppImage
./Atelier-<version>.AppImage
```

- On Ubuntu 24.04 an AppImage needs FUSE 2: `sudo apt install libfuse2t64`.
- Ubuntu 24.04 also restricts the unprivileged user namespaces that Electron's sandbox runs in. The `.deb` installs an
  AppArmor profile that allows Atelier; an AppImage installs nothing, so it may refuse to start until you run it with
  `--no-sandbox`. That turns off the browser sandbox of the app's own window, so prefer the `.deb` where you can.

Atelier was built and its packages checked on Ubuntu 24.04; Linux is less tested than macOS. On update, an AppImage
replaces itself; a `.deb` downloads in the background and asks for your password to install (see [Updates](/updates/)).

## Where Atelier keeps its data

Atelier keeps data in two places: `~/.atelier`, which holds your chats, settings and memory in a configuration folder and
a data folder, and the app's own profile.

| | Location |
|---|---|
| Configuration, **Run on this computer** | `~/.atelier` (`/Users/<you>/.atelier`, `C:\Users\<you>\.atelier`, `/home/<you>/.atelier`): `settings.json`, the system `AGENTS.md`, `plugins`, and the `skills`, `commands` and `agents` folders if you fill them yourself |
| Data, **Run on this computer** | `~/.atelier/data`: the database `atelier.db`, `blobs`, `scratch-workspaces` (the **No folder** sessions), `chat-sandboxes`, and `screen-lock.json` if you set a screen lock |
| App profile | macOS `~/Library/Application Support/Atelier`, Windows `%APPDATA%\Atelier`, Linux `~/.config/Atelier` |

The app profile holds what belongs to this computer rather than to an account: your first-run choice (`connection.json`),
the sign-in for a server (encrypted with the operating system's secure storage), this computer's device id, the folders you
trusted, the update channel, and downloaded updates. **Settings › System** (desktop only) shows the **Data folder** and a
button that opens it: the data folder above when Atelier runs on this computer, the app profile when it is connected to a
server.

`ATELIER_CONFIG_DIR` and `ATELIER_DATA_DIR` in the environment Atelier starts in move the first two; see
[Environment variables](/environment-variables/). Provider keys and tokens in the database are encrypted with the system's
secure storage, so a copy of the data folder on another computer or user account can't read them: enter them again there.
A server keeps everything in one data folder instead ([Self-hosting](/self-hosting/), [Data and files](/data-and-files/)).

## Uninstall and remove your data

Uninstalling never deletes your chats. To remove them too, delete the folders above yourself, after exporting what you
want (**Settings › Privacy › Export your data** makes a zip). If **Launch at login** is on in Settings › System, turn it
off first.

- **macOS:** quit Atelier and drag it from Applications to the Trash. Then, to remove the data, delete `~/.atelier` and
  `~/Library/Application Support/Atelier`.
- **Windows:** **Settings › Apps**, choose Atelier and **Uninstall**. The uninstaller keeps your data; delete
  `%APPDATA%\Atelier` and `C:\Users\<you>\.atelier` to remove it.
- **Linux, `.deb`:** `sudo apt remove atelier` (if the name differs, `dpkg -l | grep -i atelier` shows it). This removes
  the `atelier` command and the AppArmor profile. For an AppImage, delete the file. Then delete `~/.atelier` and
  `~/.config/Atelier` to remove the data.

Skills an admin installs from GitHub in **Settings › Skills** go to `~/.agents/skills` when Atelier runs on this computer,
a folder shared with other agents, and stay there unless you delete them.

## Updates

The desktop app checks for a newer version when it starts and every 5 minutes, downloads it in the background, and
installs it when you quit Atelier or choose **Restart** (in the sidebar, or **Restart to update** in **Settings ›
System**). It installs only updates signed with the publisher's key, which is built into the app. **Settings › System**
also has **Check now**, an **Update channel** (**Stable**, or **Beta** to get new versions first) and **Check for
updates automatically**, which turns off the checks at start and every 5 minutes; **Check now** still looks, and an
update that is already downloaded still installs.

If Atelier is connected to a server whose admin set up updates, it takes them from that server first. Everything about
updates is on [Updates](/updates/), and the [FAQ](/faq/#how-do-i-stop-atelier-from-checking-for-updates) says what you can
turn off.

## Build it from source

You need:

| You need | Version | Why |
|---|---|---|
| **Node.js** | 24 or newer | the app and the server |
| **pnpm** | 11 (through Corepack) | the monorepo |
| **Go** | 1.27 | builds the runner, the one binary that touches your folders |
| **Git** | any recent | repositories; the GitHub CLI (`gh`) is optional, for pull requests and codespaces |
| **Docker** | optional | to run the server image |

**The desktop app:**

```bash
git clone https://github.com/TheOriUHD/atelier.git
cd atelier
corepack enable
pnpm install
pnpm runner:build   # the Go runner; needed to open folders for Code and Cowork
pnpm dev:desktop    # Electron, with the interface served by Vite (hot reload)
```

To build the installers for the system you are on (the output is in `apps/desktop/release`):

```bash
pnpm --filter @atelier/desktop package
```

Build each system's installers on that system. A build you make yourself is not signed or notarized; macOS signing needs
your own Developer ID certificate.

**The web app and server,** from the same checkout:

```bash
pnpm --filter @atelier/ui build
pnpm --filter @atelier/server build
node apps/server/dist/server.mjs   # http://127.0.0.1:7340, data in ./.atelier-data
```

The first start logs a one-time **setup token**; the browser asks for it when you create the admin account. Before you
expose it beyond your own machine, put it behind HTTPS.

**The Docker server** is covered in [Self-hosting](/self-hosting/).

Next: [Get started](/getting-started/).
