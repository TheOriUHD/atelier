---
title: Environment variables
description: Every environment variable Atelier's server, desktop app and tools read, with defaults and what each does.
---

This is the complete list of environment variables the product reads. Variables that only tests, development builds or
the release scripts use are marked and kept at the end.

Where a table says **Server**, set the variable on the server's container or process: in `compose.yaml` under
`environment:`, or in the environment of the process when you run it from source. A `.env` file next to `compose.yaml`
only fills in `${NAME}` placeholders written in that file; it does not pass its variables to the container by itself.
Where a table says **Desktop**, it is read by the Atelier desktop app's own processes. See
[Setting a variable for the desktop app](#setting-a-variable-for-the-desktop-app).

:::note
Values are read once when the process starts. Change one, restart the server (`docker compose up -d` recreates the
container with the new value) or quit and start the desktop app.
:::

## Server: where it listens and where it keeps things

| Variable | Default | Meaning | Example |
|---|---|---|---|
| `ATELIER_DATA_DIR` | `/data` in the image; `.atelier-data` in the current directory when run from source | The data folder: database, attachments, `settings.json`, skills, `secret.key`. Keep it on a volume. On a server the config folder is this same folder. | `/data` |
| `ATELIER_HOST` | `127.0.0.1`; `0.0.0.0` in the image | The address the server listens on. Anything other than `127.0.0.1`, `::1` or `localhost` makes it log a reminder to put HTTPS in front. | `0.0.0.0` |
| `ATELIER_PORT` | `7340` | The port it listens on. | `7340` |
| `ATELIER_UI_DIR` | the built web app next to the source tree; `/app/ui` in the image | The folder holding the web app's build. If it is missing the server logs "UI build not found; serving the API only". | `/app/ui` |
| `ATELIER_RUNNER_DIR` | `/app/runner` in the image; unset from source | The folder with the runner builds and `checksums.json`, which the server puts into codespaces and its sandbox. Without it, codespaces and the chat sandbox cannot start a runner. After `pnpm runner:build` this is `runner/bin`. | `/app/runner` |

## Server: addresses, proxies and sign-in

| Variable | Default | Meaning | Example |
|---|---|---|---|
| `ATELIER_BASE_URL` | unset | The address people use to reach the server. When set, it decides what counts as "the same site" for sign-in, the live connection, passkeys and connector sign-ins, and whether cookies are marked Secure (when it starts with `https`). Only the origin is used; a path is dropped. An invalid URL stops the server from starting. | `https://atelier.example.com` |
| `ATELIER_TRUSTED_PROXIES` | unset | Comma-separated IP addresses or CIDR ranges of your reverse proxy. `X-Forwarded-For`, `-Proto` and `-Host` are believed only from these. Without it behind a proxy, every visitor looks like the proxy. An entry that is not an IP or CIDR stops the server from starting. | `172.16.0.0/12,192.0.2.10` |
| `ATELIER_SETUP_TOKEN` | a new random token at each start | The token needed to create the first admin. It is printed in the server's log while there are no accounts. Set it to choose your own. | `a-long-random-string` |
| `ATELIER_SECRET_KEY` | a key file `secret.key` in the data folder, made on first start | The key that encrypts stored secrets: exactly 32 bytes, as 64 hexadecimal characters or as base64. Anything else stops the server from starting. | `openssl rand -base64 32` |

## Server: chat sandbox

The Compose file sets `ATELIER_SANDBOX_HOST` and `ATELIER_SANDBOX_KEYS`; the port and the number of accounts have defaults.
Without `ATELIER_SANDBOX_HOST`, chats on the server have no sandbox. Each account logs in to the sandbox as a Unix user of its
own (`sbx000`, `sbx001`, …); see [the chat sandbox](/self-hosting/#the-chat-sandbox).

| Variable | Default | Meaning | Example |
|---|---|---|---|
| `ATELIER_SANDBOX_HOST` | unset | The sandbox container's name on the Compose network. | `sandbox` |
| `ATELIER_SANDBOX_KEYS` | unset | The file the server writes its public SSH key to, in the volume the sandbox reads its authorized keys from. It also tells the sandbox, in a folder `accounts/` next to it, which account each Unix user is for, so it is required. | `/sandbox-keys/authorized_keys` |
| `ATELIER_SANDBOX_PORT` | `2222` | The sandbox's SSH port. | `2222` |
| `ATELIER_SANDBOX_SLOTS` | `256` | How many accounts the sandbox can hold, 1 to 9999. Set the same number on the `atelier` service and, as an environment variable, on the `sandbox` service, then recreate both. | `512` |
| `ATELIER_SANDBOX_USER` | unset | For a sandbox container you built yourself, without the account users: every account logs in as this one user and shares its folders. Leave it unset with the Compose file's sandbox. | `dev` |

## Server and desktop: updates

| Variable | Applies to | Default | Meaning | Example |
|---|---|---|---|---|
| `ATELIER_UPDATE_FEED` | Server, Desktop | `https://updates.atelierhq.dev` | Where the newest version is looked up: the desktop app's public update feed, and the server's "newest version" check in **Settings › Admin › Server**. `off` removes that feed in both (test runs use it). The server ignores it for its check when `ATELIER_UPDATES_REPO` is set; with `off` and no repository, the **Server** page reads "Couldn't check for a newer version: No update feed is set." To stop a desktop app from checking by itself, use **Settings › System › Check for updates automatically** instead; see [Updates](/updates/#turning-the-check-off). | `off` |
| `ATELIER_UPDATES_REPO` | Server | unset | A GitHub repository (`owner/repo`) whose releases hold the desktop builds. It needs `ATELIER_UPDATES_TOKEN` as well to serve updates to desktop apps; alone it only decides which release the **Server** page calls the newest. A value that is not `owner/repo` stops the server from starting. | `acme/atelier-builds` |
| `ATELIER_UPDATES_TOKEN` | Server | unset | A GitHub token that can read that repository's releases (fine-grained, Contents: read-only). Never sent anywhere but GitHub's API. | `github_pat_…` |
| `ATELIER_UPDATER_URL` | Server | unset | The address of the updater service. Without it **Update server** is not offered and the page shows the manual command. | `http://updater:7341` |
| `ATELIER_UPDATER_SECRET` | Server, updater service | `/updater/secret` | The file holding the secret the server and the updater share. The server creates it on first use; the updater only reads it. | `/updater/secret` |
| `ATELIER_UPDATER_PORT` | Updater service | `7341` | The port the updater listens on. | `7341` |
| `ATELIER_IMAGE` | Server | set in released images | The registry image this build came from. Empty means built from source: Settings then tells the admin to update by rebuilding. | `ghcr.io/theoriuhd/atelier` |
| `HOSTNAME` | Updater service | the container's id | How the updater finds its own container, and through its labels the Compose project. Set by Docker. | |

## Desktop: where it keeps things

| Variable | Default | Meaning | Example |
|---|---|---|---|
| `ATELIER_CONFIG_DIR` | `~/.atelier` | The desktop's config folder: `settings.json`, skills, prompts overrides. | `/Volumes/Work/atelier` |
| `ATELIER_DATA_DIR` | `<config folder>/data` | The data folder of the built-in backend. | `/Volumes/Work/atelier-data` |

Both apply only to **Run on this computer**. Where the app keeps its own profile (sign-in, caches) is Electron's user
data folder; the standard Chromium switch `--user-data-dir=<folder>` on the command line moves it. See
[Data and files](/data-and-files/).

## Server and desktop: tools and models

| Variable | Default | Meaning | Example |
|---|---|---|---|
| `ATELIER_SSH` | `ssh` | The `ssh` program used to reach SSH hosts (desktop) and the server's sandbox container. | `/usr/local/bin/ssh` |
| `ATELIER_GH` | `gh` | The GitHub CLI used to connect to codespaces. | `/opt/gh/bin/gh` |
| `ATELIER_MODEL_IDLE_TIMEOUT_MS` | `900000` (15 minutes) | How long a request to a plain `http://` model server (Ollama, llama.cpp, LM Studio) may receive nothing before Atelier gives up with "sent nothing for too long" and retries. Raise it for models that go quiet for a long time while they write a large tool call. Servers reached over `https://` are not affected. | `1800000` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | unset | Only looked for, never used on their own: when one is set in the backend's environment and no provider of that type has been added yet, **Settings › Admin › Providers** offers it as a one-click suggestion under **Detected on this machine**. Adding the provider then stores a reference (`${ANTHROPIC_API_KEY}`), not the key. | |
| any `${NAME}` in `settings.json` | | A provider key, connector header or environment, or search key written as `${NAME}` or `${NAME:-fallback}` is read from the backend's environment when it is used. | `"apiKey": "${OPENROUTER_KEY}"` |

## Set by Atelier for what it starts

You do not set these. They are what the processes Atelier starts receive.

| Variable | Set for | Meaning |
|---|---|---|
| `ATELIER_PROJECT_DIR`, `CLAUDE_PROJECT_DIR` | hooks | The root of the folder the session works in. |
| `GH_TOKEN`, `GH_PROMPT_DISABLED` | `gh codespace ssh` | The signed-in person's GitHub token, and no interactive prompts. |
| `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `DISPLAY`, `ATELIER_ASKPASS_LOG`, `ATELIER_ASKPASS_TRUST`, `ATELIER_ASKPASS_PASSWORD`, `ATELIER_ASKPASS_PASSPHRASE` | `ssh` to a saved SSH connection | The helper that answers `ssh`'s questions (a new host's key, a saved password or key passphrase) and the log of the questions it was asked. |
| `GIT_CEILING_DIRECTORIES` | the runner of a scratch folder | The scratch folder's parent, so Git does not find a repository around it. |
| `ATELIER_RUNNER_DIR`, `ATELIER_TRUSTED_FOLDERS` | the desktop app's backend and connection processes | Where the bundled runner builds are, and the file listing the folders you trusted. Overwritten by the app. |

Other variables are read for platform reasons: `PATH` and `SHELL` (Atelier asks your login shell for its `PATH`, so
tools you installed are found even when Atelier starts from the Dock), `HOME`, `DISPLAY` (so `ssh` can ask for a password
with a helper), `XDG_CONFIG_HOME` (the Linux launch-at-login entry, and the runner's global Git ignore file) and
`APPIMAGE` (Linux launch at login), and on Windows `ComSpec`, `ProgramFiles`, `ProgramW6432`, `ProgramFiles(x86)`,
`LocalAppData` and `PROCESSOR_IDENTIFIER` (finding the shell and Git Bash, and describing the CPU). The server image sets `HOME=/data/home` and
`NODE_ENV=production`.

## Development, tests and release scripts

These are for people working on or building Atelier. In normal use they do nothing useful, and some make the app behave
oddly.

| Variable | Used by | Meaning |
|---|---|---|
| `ATELIER_DEV_URL` | desktop, development | Loads the window from a dev server (`http://localhost:5199`) instead of the built web app. |
| `ATELIER_HIDE_WINDOW` | desktop, tests | Keeps the window hidden and unthrottled, and the Dock icon away on macOS. |
| `ATELIER_SHOW_WINDOW` | end-to-end tests | Shows the window of a test run that would otherwise be hidden. |
| `ATELIER_E2E_APP` | end-to-end tests | Path of a packaged app to test instead of the development build. |
| `ATELIER_CHATGPT_CALLBACK_PORT` | tests | Port of the short-lived listener on `127.0.0.1` that receives the ChatGPT Plan sign-in's return (default `1455`). Tests set `0` to pick a free port. |
| `ATELIER_SEARCH_BASE` | tests | Replaces the search engines' addresses with a local fake, and turns result-page reading off. |
| `ATELIER_LOOP_MIN_INTERVAL_MS` | tests | The shortest loop interval, instead of one minute. |
| `ATELIER_LIVE_ANTHROPIC_MODEL`, `ATELIER_LIVE_OPENAI_MODEL`, `ATELIER_LIVE_OLLAMA_URL`, `ATELIER_LIVE_OLLAMA_MODEL`, `ATELIER_LIVE_LLAMACPP_URL`, `ATELIER_LIVE_COMPAT_URL`, `ATELIER_LIVE_COMPAT_KEY`, `ATELIER_LIVE_COMPAT_MODEL` | live provider tests | Which real model servers the opt-in provider tests talk to. The tests are skipped without them. |
| `ATELIER_PROMPT_CORPUS` | prompt originality check | Folders to compare Atelier's prompts against. |
| `ATELIER_UPDATE_KEY` | `deploy/cloudflare/publish.mjs` | Path of the Ed25519 update-signing private key (default `~/.atelier-release/update-signing.key`). See [Updates](/updates/#publishing-updates). |
| `ATELIER_RELEASES_BUCKET` | `deploy/cloudflare/publish.mjs` | The R2 bucket name (default `atelier-releases`). |
| `APPLE_KEYCHAIN_PROFILE` | `package:mac` | The notarization login saved in the keychain (default `atelier-notary`). |
| `ATELIER_VERSION` | Docker build argument | The version stamped into the runner builds in the image. |

## Setting a variable for the desktop app

An app started from the Dock, Launchpad or Start menu does not see variables you set in a shell profile. Use one of:

- **macOS:** start it from Terminal for that run, `ATELIER_DATA_DIR=/Volumes/Work/atelier-data /Applications/Atelier.app/Contents/MacOS/Atelier`,
  or set it for every app you start from now until you log out with `launchctl setenv ATELIER_DATA_DIR /Volumes/Work/atelier-data`.
- **Windows:** add a user environment variable (System Properties › Environment Variables, or `setx
  ATELIER_DATA_DIR D:\atelier-data`), then quit and start Atelier again. Programs already running do not see it.
- **Linux:** start it with the variable in front (`ATELIER_DATA_DIR=/data/atelier atelier`), or put `env
  ATELIER_DATA_DIR=/data/atelier` in front of the program in the `Exec=` line of a copy of its `.desktop` file.
