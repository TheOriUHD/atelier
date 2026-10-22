# Updates and downloads

This file is for people who **publish** builds (the feed, signing, the release order). How updates look to the people who
use Atelier is on the documentation site: https://docs.atelierhq.dev/updates/.

Installed desktop apps update themselves the way most modern apps do: a new version downloads quietly in the
background while you work, and installs when you restart Atelier (a **Restart** button appears in the sidebar), or
simply the next time you start it. Where the files live is a small static host you control: a Cloudflare R2 bucket
behind a Worker (`deploy/cloudflare`). The project's own feed is on a custom domain, `updates.atelierhq.dev`. A domain is
optional: without one, set `workers_dev = true` in `deploy/cloudflare/wrangler.toml` (and remove its `routes`), and
Cloudflare gives the Worker a free HTTPS address on `workers.dev`.

## What each part does

| Part | Role |
|---|---|
| `electron-builder` | Builds the installers and writes `latest.yml` (Windows), `latest-mac.yml` and `latest-linux.yml`. |
| The bucket | Holds `stable/` and `beta/`: the packages and those update files. |
| The Worker | Serves them with byte ranges (updates resume) and a download page at `/`. |
| The app | Asks `<feed>/<channel>/latest.yml` at start and every 5 minutes (unless the person switched off Settings › System › Check for updates automatically), downloads a newer version, installs on quit. |

An app with an update downloaded and waiting for a restart keeps checking: a still newer version is downloaded (after
the same signature check) and replaces the waiting one, and the sidebar shows the download's progress. On a Mac the
newer bundle is unpacked beside the staged one, which stays ready if the newer download fails; on Windows and Linux
electron-updater drops the waiting installer when a download fails, so the app says so and the next check tries again.

The server image is published with the apps (`atelier`, `atelier-sandbox` and `atelier-updater`), so the version in
`stable/latest.yml` is the one an admin's **Update server** installs. The release command pushes the images before the
feed for that reason: a server updated in between would pull the previous image and stay on its version.
Apps compare their version with their server's and warn in the sidebar when they differ.

An Atelier **server** can still serve its own feed (`ATELIER_UPDATES_REPO`, see [self-hosting](self-hosting.md)).
Apps signed in to a server use that feed first and fall back to the public one when the server offers none.

macOS updates install in place with or without a Developer ID (see the table below), so signing is about the **first
install**: a build signed with a Developer ID and notarized by Apple opens without macOS's "unidentified developer"
warning. [Signing the macOS build](#signing-the-macos-build) below makes one.

## Who can install an update

Only updates you have signed. The key pair is made once: the private key stays on your Mac in
`~/.atelier-release/update-signing.key` (back it up: if it is lost, apps already installed cannot be updated and
people have to install a build that carries a new public key), and the public key is built into the app
(`APP.updatePublicKey`). `publish.mjs` signs every package and uploads `<file>.sig` beside it (`sign-release.mjs` only writes the files, for a GitHub release); the app asks for that
signature before it downloads anything and refuses a package with no signature or one made with another key. So even
someone who got into the Cloudflare account could not hand out an update of their own.

What this is not: a lock on the downloads. The packages and the download page are public so that testers can get the
first install; the key only decides what the app will install. (The update files cannot be made secret from people
who have the app, since the app has to be able to fetch them.)

## What updates itself, per platform

| | Updates | Notes |
|---|---|---|
| **Windows** | in the background, installed on restart or the next start | The NSIS installer's own updater; the signature above is what protects it while there is no code-signing certificate. |
| **Linux, AppImage** | the same: the AppImage file is replaced | |
| **Linux, `.deb`** | downloaded in the background; installing asks for your password (`pkexec dpkg -i`) | Needs `latest-linux.yml` to list the `.deb`: build the AppImage and the `.deb` in one run. |
| **macOS** | in the background too: the zip is downloaded, checked and unpacked beside the app, and swapped in when Atelier quits or on Restart | Works with or without a Developer ID (released builds are signed and notarized): Atelier replaces its own bundle from a small helper script (`apps/desktop/src/bundle-swap.ts`); what the app downloads itself carries no quarantine flag, so Gatekeeper never judges it. It needs Atelier to be installed where it can write (Applications, from the disk image). Run from a disk image or a quarantined Downloads copy it cannot replace itself, and the sidebar offers the disk image instead. |
| **The server** (Docker) | from Settings › Admin › Server, with the compose file's `updater` service | **Update server** pulls the new images and recreates the server and the sandbox (see [self-hosting](self-hosting.md#updating-the-server)). Without the updater: `docker compose pull && docker compose up -d`. A server built from source is updated by rebuilding it. The newest version shown is the public feed's `stable/latest.yml`. |

## Set it up once

You need a Cloudflare account. `wrangler` is run through `npx`; nothing is installed globally.

```bash
cd deploy/cloudflare
npx wrangler login                                  # opens the browser once
npx wrangler r2 bucket create atelier-releases
npx wrangler deploy                                 # on the domain in wrangler.toml's routes (or workers.dev, above)
```

The feed's address is `APP.updateFeed` in `packages/protocol/src/app.ts` (it is `https://updates.atelierhq.dev` from 0.1.1
on, the Worker's custom domain; `ATELIER_UPDATE_FEED` overrides it per run). A feed of your own without a domain is the
Worker's `workers.dev` address:

```ts
updateFeed: 'https://atelier-updates.<you>.workers.dev', // without a domain of your own
```

When you later move to a domain, add it to the Worker (Workers & Pages › atelier-updates › Settings › Domains) and change
that one line; apps built with the old address keep working for as long as the `workers.dev` address stays on.

## Signing the macOS build

The base build config signs nothing (CI, Windows, Linux and quick local builds). A signed and notarized Mac build is made
on a Mac that has the certificate, by `apps/desktop/electron-builder.signed.yml` through `scripts/package-mac.mjs`. Apple's
notarization takes minutes normally, but **hours or days for a new account's first submissions**, so the script never waits
for it: it signs both architectures, sends them to Apple, and stops. The Mac can sleep or go offline in between; Apple works
on its own side.

```bash
pnpm --filter @atelier/desktop package:mac             # sign arm64 and x64, send both to Apple, stop
pnpm --filter @atelier/desktop package:mac --status    # what does Apple say?
pnpm --filter @atelier/desktop package:mac --finish    # when both are accepted: staple, check, make the .dmg and .zip files and latest-mac.yml
```

`--finish` also says so when Apple isn't done (exit code 2: just run it again later). The submissions are kept in
`apps/desktop/release-mac/notarization.json`, and a second `package:mac` refuses to send the same builds again, because
duplicates only lengthen Apple's queue (`--force` overrides it). Once accepted, the ticket is stapled into the apps, they are
checked with `codesign`, `spctl` and `stapler`, and the disk images and zips are made from those very apps without signing
again (a second signing would change the signature the ticket belongs to). A signed app opens on any Mac without a warning.
`latest-mac.yml` (what the updater reads) is written from the finished files and lists both architectures (`--feed` rewrites it alone). Apple's verdict on a rejection is printed from `notarytool log`.

**Once per Mac** (the Apple Developer Program, 99 USD a year, is the account for both):

1. **A "Developer ID Application" certificate** in the login keychain: Xcode › Settings › Accounts › your team (not a
   "Personal Team") › Manage Certificates › **+** › Developer ID Application. Or on developer.apple.com › Certificates,
   IDs & Profiles › **+** › Developer ID Application, with a request made in Keychain Access (Certificate Assistant). Only
   the Account Holder can make it. `security find-identity -v -p codesigning` lists it.
2. **A notarization login** saved in the keychain, so no password sits in a file or in CI: make an app-specific password
   at appleid.apple.com › Sign-In and Security, then
   `xcrun notarytool store-credentials "atelier-notary" --apple-id <your Apple ID> --team-id <your team id>`
   (it asks for the password). Another name: set `APPLE_KEYCHAIN_PROFILE`.

The release command (below) runs `package:mac`, waits for Apple and finishes it for you. The certificate and the
notarization login stay on this Mac; GitHub's own macOS job builds unsigned packages and is not used for releases.

## Releasing

`pnpm release <version>` (for example `pnpm release 0.1.11`) is the whole release, run on your Mac, on your own machines.
`deploy/ship/release.mjs` is the script; `--help` lists its flags.

| Step | Where |
|---|---|
| Checks: on `main`, nothing uncommitted, the version is newer, the changelog has entries, the "What's new" notes exist for it, every machine and login answers | this Mac |
| `typecheck`, `lint` and the unit tests | the Linux build machine |
| `APP.version` and `apps/desktop/package.json` raised, the changelog's Unreleased section cut into the version, the commit `release: <version>` and the tag | this Mac (local only) |
| Linux packages (AppImage and deb, x64 and arm64), the server images (built, not yet pushed) and the whole end-to-end suite (browser and Electron, under a virtual display) | the Linux build machine |
| The Windows installer (x64 and arm64) | the Windows build machine |
| The macOS apps, signed and notarized, in a clean checkout of the tag | this Mac |
| Every file checked against its update file (sha512 and size), signatures made | this Mac |
| **The question:** what will be pushed and published; you type `publish` | |
| Server images pushed, then `git push` of `main` and the tag, the GitHub release and the update feed, the website's download list, the documentation | |
| What is live, checked: the feed's files and signatures, the release's assets | |

The three builds run side by side; Apple's notarization is usually the longest wait. When a step fails the command stops and
says why; run the same command again and finished steps are skipped (the state, the logs and the built files are in
`~/.atelier-release/builds/<version>/`). Nothing leaves your Mac before the question. `--build-only` builds and checks
everything and publishes nothing; `--skip qa,e2e,linux,windows,mac,image,docs` leaves parts out; `--yes` publishes without
asking; `--trailer` adds a line to the commits it makes.

**The build machines** are reached by `ssh` with a key, by the names `atelier-linux` and `atelier-win`
(`ATELIER_RELEASE_LINUX`, `ATELIER_RELEASE_WINDOWS`, and `ATELIER_RELEASE_WINDOWS_ROOT` for the folder on the Windows
machine). The Linux machine runs Ubuntu 24.04 with Node 24, pnpm (the version in `package.json`), Go 1.27 and Docker with
buildx: make a user for it with your key, then run `deploy/ship/linux-builder-setup.sh` there as root once. It needs
no credentials but one: for the server images, a `docker login ghcr.io` there (without it the images are
built to prove they build, and not pushed). The Windows machine has `tools\node` (Node and pnpm) in its build folder. The
update-signing key (`~/.atelier-release/update-signing.key`), the Apple certificate and the notarization login stay on this
Mac, and so do your `gh` and `wrangler` logins.

The GitHub workflows `Package` and `Server image` no longer run on tags: they are a fallback, started by hand
(Actions › Run workflow, choosing the tag), for when the machines are not available. `CI` still runs on every push to `main`.

## Publish a version by hand

The command above does all of this; the steps are here for when you need one of them alone.

1. Raise the version in `apps/desktop/package.json`, build the installers on each OS
   (see the README's Install section) and collect them, with their `latest*.yml` files, in one folder.
2. Upload:

```bash
node deploy/cloudflare/publish.mjs installers stable     # or: beta
```

The packages go first (each with its signature) and the update files last, so an app never reads a file that points at
a package that is not there yet or not signed. Build all of an OS's targets in one run (`electron-builder --linux`),
or its `latest*.yml` will list only some of them; the script warns about a Linux feed that lacks the AppImage or the
`.deb`. Apps pick the new version up at their next check (within 5 minutes), or at once from
Settings › System › Updates › Check now.

Differential downloads are off (the feed holds only the newest version), so each update is a full download, about
the size of the installer.

3. Point the website's download page at the feed's copies and deploy it:
   `node apps/site/scripts/releases.mjs <tag> && npx wrangler@4 deploy -c apps/site/wrangler.jsonc`. Each build links to
   the feed when its copy there has the same size, else to
   GitHub; the script names any build still on GitHub. The release command runs this step after the feed is filled.

Servers that mirror a GitHub release as their update feed (`ATELIER_UPDATES_REPO`) need the packages' `.sig` files on the
release; the release command makes and uploads them (`node deploy/cloudflare/sign-release.mjs <folder>` does it alone). All
six Mac, Windows and Linux downloads on the website must be the new version before step 3.

## Check what is published

```bash
curl -s https://updates.atelierhq.dev/stable/latest.yml          # or your own feed's address
node --test deploy/cloudflare/src/latest.test.mjs         # the Worker's file-name logic
```
