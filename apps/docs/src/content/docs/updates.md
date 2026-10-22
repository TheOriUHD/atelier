---
title: Updates
description: How the desktop app and the server find, verify and install new versions, how to switch the checks off, and how to publish updates yourself.
---

The desktop app and the server update separately. The desktop app downloads new versions by itself and installs them when
you restart it. The server updates when an admin presses **Update server**, or when you run `docker compose pull`.

## The desktop app

### When it checks

Atelier asks for the newest version when the app starts, after you sign in to a server, and **every 5 minutes** after that.
A check reads one small file. **Settings › System › Updates › Check now** asks immediately. Changing the **Update channel** also checks once.

**Settings › System** (desktop app only) has, under **This app**:

| Row | What |
|---|---|
| **Updates** | The state in words, and the button for what comes next: **Check now**, **Download**, **Restart to update** or **Releases page**. |
| **Check for updates automatically** | On by default. Off: the app asks no feed anything by itself, only **Check now** does. |
| **Update channel** | **Stable** or **Beta**. "Beta gets new versions before they’re released as stable." |

### Where updates come from

| You use | The app asks |
|---|---|
| **Connect to a server** whose admin set up a feed ([Serving desktop updates](/self-hosting/#serving-desktop-updates-from-your-server)) | The server's `/updates/<channel>/`, with your sign-in token (sent to that server only). |
| **Connect to a server** with no feed | The server answers 404, and the app uses the public feed instead. Without a public feed too, **Updates** reads "The server doesn’t offer updates for this computer yet. Its admin sets them up with ATELIER_UPDATES_REPO." |
| **Run on this computer** | The public feed, `https://updates.atelierhq.dev/<channel>/`. |

The `ATELIER_UPDATE_FEED` environment variable of the desktop process replaces the public feed's address with yours, or
with `off` to remove it. With the public feed removed and no server feed, **Updates** says "This copy has no update
source, so it can’t check for new versions. Get them from the Releases page." and the channel below it is greyed out.

### Channels

**Settings › System › Update channel** is a setting of this computer, kept in `updates.json` in the app's profile folder.

- **Stable** is the default: released versions.
- **Beta** gets new versions before they are stable. On Atelier's public feed that is whatever is published to the `beta`
  folder; on a server's feed it is the newest release including prereleases (a tag containing `-`, such as
  `v0.3.0-beta.1`).
- Atelier never downgrades. Moving from Beta to Stable while the beta is newer keeps you on the beta until a stable version
  passes it.

### What happens when a version is found

1. **Available.** The state reads "Atelier 0.1.10 is available. Downloading…".
2. **Downloading.** The sidebar shows "Downloading Atelier 0.1.10".
   Before anything is downloaded, the update's signature is checked (see [What is verified](#what-is-verified)).
3. **Ready.** The sidebar shows "Update 0.1.10 is ready" with **Restart**; Settings says "Atelier 0.1.10 is ready. It
   installs when you quit Atelier, or restart now." and offers **Restart to update**. The update installs when you quit
   Atelier, or the next time you start it.

While an update waits, the app keeps checking. If a still newer version appears, it is downloaded (after the same checks)
and replaces the waiting one, so you never restart into an older update. The same version is never downloaded twice. If the
newer download fails, the one that waits stays offered.

<!-- screenshot: the sidebar with "Downloading Atelier …" and its progress bar, and the "Update … is ready" Restart notice -->

### What's new

The first time you open a new version, a **What's new in Atelier** dialog lists what changed: the changes that matter, then
the smaller ones, with a link to the full changelog. It shows once per person and not on a new install. Open it again from
**More › What's new** in the sidebar.

### What each platform does

| | How it updates |
|---|---|
| **macOS** | Downloads the zip for your Mac's architecture, checks its hash and signature and unpacks it next to the app. When Atelier quits (or on **Restart**), a helper script replaces the old app and clears the quarantine flag; on **Restart** it also starts the new one. Needs Atelier to be installed where it can replace itself, normally in Applications. |
| **macOS, cannot replace itself** | If Atelier runs from a disk image, from a quarantined Downloads copy, or somewhere it cannot write, the sidebar and Settings offer **Download** instead: it saves the new disk image to your Downloads folder, checked against the feed's hash, shows it in Finder, and you drag Atelier to Applications. |
| **Windows** | Downloads in the background and runs the installer when you quit or restart. Windows builds are not code-signed, so the update signature below is what protects them. |
| **Linux, AppImage** | Downloads in the background and replaces the AppImage file. |
| **Linux, `.deb`** | Downloads in the background; installing asks for your password. |
| **Other Linux packages and unpackaged builds** | Do not update: "This copy of Atelier can’t update itself. Install it from the releases page to get updates." with a **Releases page** button. |

### What is verified

Every package is signed by the publisher. Before downloading anything, the app fetches `<package>.sig` from the same feed and
checks that it is an Ed25519 signature, by the key whose public half is built into the app, over this exact message:
`atelier-update:v1`, the package's file name, and the package's SHA-512 as the update file states it. A package with no
signature, or one made with another key, is refused:

- "Atelier 0.1.10 is not signed, so it was not downloaded."
- "Atelier 0.1.10 is not signed with Atelier's key, so it was not downloaded."
- "Couldn’t check the signature of Atelier 0.1.10."
- "Atelier 0.1.10 points outside its feed." (an update file naming a file elsewhere)

After the download the app checks the package against the hash in the update file ("the file is damaged" otherwise), and on
macOS that the unpacked app has this app's bundle identifier. The feed's address and your token are never sent anywhere
but the feed itself. So a compromised update server, bucket or account cannot hand out an update of its own: it would need
the publisher's private key, which stays off the server. Differential downloads are off, so every update is a full
download, about the size of the installer.

What this does not do: it does not make the downloads secret (the feed has to be readable by the app), and it does not help
if the publisher's private key is stolen. macOS builds are Developer ID signed and notarized, so the first install opens
without a Gatekeeper warning; Windows builds are not signed, so SmartScreen warns on first install.

### Turning the check off

**Settings › System › Check for updates automatically**, on by default. Switched off, the app asks no feed
anything by itself: not when it starts, not after you sign in, not every 5 minutes. It remembers the choice in
`updates.json`. **Check now** still looks, changing the **Update channel** looks once, and an update that was already
downloaded still installs. With it off and nothing ever checked, **Updates** says "Automatic checks are off. Check now looks
for a new version."

To remove the public feed as well, start the app with `ATELIER_UPDATE_FEED=off` (see
[Environment variables](/environment-variables/#setting-a-variable-for-the-desktop-app)); a copy connected to a server
still asks that server. What an update check sends is in [What leaves your machine](/privacy/#update-checks).

### With no internet, or when something fails

- Without a connection the check fails and **Updates** shows the error (the first line of what went wrong). The next check, 5
  minutes later or on **Check now**, tries again.
- A failed download keeps an update that was already waiting. On Windows and Linux, electron-updater empties its download
  folder when a download fails, so the waiting update is dropped, the app says so, and the next check starts again.
- "The server didn’t accept your sign-in. Sign in again to get updates." means the server's feed answered 401.
- Nothing published yet on the public feed is not an error: the app reports that it is up to date.

### Release notes

The app does not show release notes. Changes are listed per version in `CHANGELOG.md` in the repository, and on the
[releases page](https://github.com/TheOriUHD/atelier/releases) next to the packages.

### Rolling back

There is no rollback in the app. To go back, install the older version's installer over the newer one (the releases page
lists every version). Installing does not touch your data, but the database only moves forward: a newer version migrates it
when it starts, and nothing stops an older version from opening it afterwards. **Back up your data folder before
updating** and restore it when you roll back
([Data and files](/data-and-files/#backing-up-and-restoring)). If the feed would offer the newer version again, switch the
checks off first.

## The server

The server tells admins in **Settings › Admin › Server**: its version, the newest one, and what to do.

- With the Compose file's `updater` service, **Update server** pulls the new images and recreates the server and the sandbox.
  Everyone is disconnected for a minute or so and reconnects by themselves.
- Without it: `docker compose pull && docker compose up -d` on the host, in the folder with `compose.yaml`. Your data
  volume is kept.
- A server built from source is updated by rebuilding it.

Details, the updater's security trade-off and pinning a version are in
[Run a server](/self-hosting/#updating). After a server update:

- **Desktop apps** that are older than the server show a notice in the sidebar: "The server runs Atelier 0.1.9, newer
  than this app. Some features may not work as intended." An app newer than its server tells admins: "The server runs an
  older version (0.1.7). Update it in Settings › Admin › Server."
- **A web page** left open shows "The server was updated to Atelier 0.1.10." with **Reload**.

The server only looks up the newest version when an admin opens the Server page or presses **Check now**; it never updates
itself.

## Publishing updates

For people who build and distribute their own copy of Atelier. Atelier's own releases follow the same steps.

### How the pieces fit

| Part | Role |
|---|---|
| `electron-builder` | Builds the installers and writes `latest.yml` (Windows), `latest-mac.yml` and `latest-linux.yml`. |
| The release workflow (`.github/workflows/release.yml`) | On a `v*` tag, builds the macOS, Windows and Linux packages on GitHub's runners and attaches them, with the update files, to the tag's release. A tag with `-` is a prerelease. |
| The server image workflow (`.github/workflows/server-image.yml`) | On the same tag, builds the server, sandbox and updater images for amd64 and arm64. |
| The public feed (`deploy/cloudflare`) | A Cloudflare Worker over an R2 bucket that serves `stable/` and `beta/` with byte ranges (downloads resume) and a download page. |
| `deploy/cloudflare/publish.mjs` | Signs each package and uploads packages first, update files last. |
| A server's feed (`ATELIER_UPDATES_REPO`) | Mirrors a GitHub release for the apps connected to that server. |

### Your own key

Apps install only what is signed by the key whose public half is `APP.updatePublicKey` in `packages/protocol/src/app.ts`,
and the address they ask is `APP.updateFeed`. A fork that ships its own builds makes its own key pair and builds with both
changed; builds made with Atelier's key can only be signed by whoever holds that key.

```bash
openssl genpkey -algorithm ed25519 -out ~/.atelier-release/update-signing.key
# the raw public key, base64: this is the value for APP.updatePublicKey
openssl pkey -in ~/.atelier-release/update-signing.key -pubout -outform DER | tail -c 32 | base64
```

Back the private key up. If it is lost, apps already installed cannot be updated: people have to install a build that
carries a new public key.

### A feed on Cloudflare

Once, with a Cloudflare account (`wrangler` runs through `npx`):

```bash
cd deploy/cloudflare
npx wrangler login
npx wrangler r2 bucket create atelier-releases
npx wrangler deploy
```

Set the Worker's custom domain in `wrangler.toml` (`routes`) and put the same address in `APP.updateFeed`. For each version,
with the packages and their `latest*.yml` files collected in one folder (for example `gh release download <tag>`):

```bash
node deploy/cloudflare/publish.mjs installers stable     # or: beta
```

Build all of an OS's targets in one run: a Linux `latest-linux.yml` must list both the AppImage and the `.deb` or a copy
installed from the other kind finds nothing to update to (the script warns). Publish the feed **after** the server image is
pushed, or a server updated in between pulls the previous image. Apps pick the new version up at their next check, within 5
minutes. `curl https://<feed>/stable/latest.yml` shows what is published.

### A feed from your server

Set `ATELIER_UPDATES_REPO` and `ATELIER_UPDATES_TOKEN` on the server. The apps connected to it then update from the newest
GitHub release of that repository. Apps require a signature for every package, so each package needs a `<package>.sig` file next to it as a release
asset. The release workflow makes them when the repository has an `UPDATE_SIGNING_KEY` secret;
otherwise run `node deploy/cloudflare/sign-release.mjs <folder with the packages>` with the key and upload the `.sig` files
(`gh release upload <tag> <folder>/*.sig`). A signature is the base64 Ed25519 signature of the message described above;
`deploy/cloudflare/signing.mjs` has the code (`signPackage`, `sha512Of`, `loadKey`). Without them, apps report "Atelier … is not signed, so it was not downloaded." Details:
[Run a server](/self-hosting/#serving-desktop-updates-from-your-server).

### Signing the macOS build

The base build config signs nothing. A signed and notarized Mac build is made on a Mac that has a Developer ID Application
certificate and a saved notarization login (`xcrun notarytool store-credentials`), with:

```bash
pnpm --filter @atelier/desktop package:mac             # sign arm64 and x64, send both to Apple, stop
pnpm --filter @atelier/desktop package:mac --status    # what does Apple say?
pnpm --filter @atelier/desktop package:mac --finish    # when both are accepted: staple, check, make the .dmg and .zip and latest-mac.yml
```

Apple's first notarizations for a new account can take hours, so the script never waits. Replace the CI's unsigned macOS
files on the release with the finished ones before publishing the feed. The update signature is a separate layer and still
applies to every package. The full procedure, with every file involved, is `docs/updates.md` in the repository.
