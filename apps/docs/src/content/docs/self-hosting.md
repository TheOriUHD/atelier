---
title: Run a server
description: An operator's guide to running the Atelier server with Docker or from source, behind HTTPS, with backups, updates and a hardening checklist.
---

The Atelier server is the same backend the desktop app runs inside itself, reached from a browser and from desktop apps
set to **Connect to a server**. Run one when you want the web app, several people on one install, or one place for
your chats and settings.

## What the server is, and what it is not

- **One process, one data folder.** A single Node.js process keeps everything in one folder (SQLite and files). Do not
  run replicas; run one server per data folder.
- **It never runs commands on its own machine.** Code and Cowork sessions run in a folder on a person's desktop app (lent
  over a secure link, the device link), in a GitHub codespace, or, for Chat only, in a separate sandbox container. If the server cannot reach a runner, a session says so, for example
  "This server does not run commands on its own machine. Open the desktop app to add a folder on your computer."
- **The models run elsewhere.** The server forwards prompts to the providers an admin configured. It needs network access to them, not a GPU.
- **It is not a multi-tenant service.** Admins configure providers, instructions and connectors for everyone. Treat the
  people you invite as members of one team. See [Accounts](/accounts/) and [Security](/security/).

## Install it with the setup wizard

On a Linux or macOS machine, one line starts a full-screen wizard:

```bash
curl -fsSL https://updates.atelierhq.dev/install | sudo sh
```

The script downloads `atelier-setup` for your system, checks its checksum against the one written into the script, and
starts it. To read it first, or to check it against the checksum on the release page, download it with
`curl -fsSLO https://updates.atelierhq.dev/install` and run `sudo sh install`.

`sudo` lets the wizard fix Docker by itself on Linux: when Docker is missing it installs it with Docker's own installer
(get.docker.com), when it is stopped it starts it, and when the Compose plugin is missing it adds it, each on a screen
of its own. Without `sudo` it works the same where Docker already runs for your user, and otherwise says what to run.
On a Mac, install Docker Desktop or OrbStack first.

The wizard:

1. **Looks at the machine:** Docker and Compose (and, with `sudo`, installs or starts them), disk, memory, and whether
   Ollama or Tailscale are there. If it set up
   Atelier here before, it says so and offers to reinstall over it (keeping accounts and chats), remove it, or leave it.
2. **Asks how people will reach the server:** by default **this machine's address** (`http://192.168.x.x:7340`, no
   domain, nothing else to set up); a domain with HTTPS handled by Caddy in the same Compose project (needs ports 80
   and 443 free); **your own reverse proxy** (Caddy, nginx, Traefik, Nginx Proxy Manager or a Cloudflare Tunnel: it
   writes Atelier's side and gives you the exact settings for yours, saved in `proxy/` in the install folder); or
   Tailscale.
3. **Shows every file before writing it,** then writes `compose.yaml` and `.env` (a copy of anything it replaces is kept
   as `.bak-<time>`), pulls the images and starts them.
4. **Tests the address like a browser would:** DNS, the certificate, the server, the live WebSocket connection and a
   sign-in request. A failure comes with one sentence naming what to change.
5. **Creates your account** in the terminal, so you never handle the setup token.

Afterwards, in the same program:

| Command | What it does |
|---|---|
| `atelier-setup doctor` | Runs the address test again, shows the container state and any refusals from the server's log. Use it first when a page loads but spins. `--url` tests another address. |
| `atelier-setup update` | Pulls newer images and recreates what changed. |
| `atelier-setup status` | Shows the containers. |
| `atelier-setup plan --mode … --url …` | Prints the files and steps for answers given as flags and changes nothing. `install --yes` with the same flags installs without the wizard. |

The wizard does not touch a server that is already running; it finds it, says where it lives and installs next to it only
if you choose another folder and port. To put an existing server on the released images, see
[Images and tags](#images-and-tags).

## Run it

You need Docker with the Compose plugin, a host that stays on, and a hostname that points at it.

1. Copy `deploy/compose.yaml` and `deploy/Caddyfile` from the repository to the host. Put your hostname in both:
   `ATELIER_BASE_URL` in the Compose file and the site address at the top of the Caddyfile.
2. Start it: `docker compose up -d`. The first start downloads four images and takes a minute.
3. Read the **setup token** from the log: `docker compose logs atelier | grep setupToken`. It is one JSON line:
   `No accounts yet. Create the admin in the browser with this setup token`.
4. Open `https://your-hostname/`. A fresh server asks for **Setup token**, **Full name**,
   **Username** (2 to 32 characters: letters, digits, dots, dashes, underscores) and **Password** (at least 8
   characters). That account is the first admin.
5. Add a model: **Settings › Admin › Providers**. See [Providers](/providers/).

The token is random at every start unless you set `ATELIER_SETUP_TOKEN`, and it works only while the server has no
accounts. If you lose it, restart the container and read the new one. Without the token nobody can claim a fresh server
("That setup token is wrong. It is printed in the server log."), and once an admin exists the server refuses any second
setup ("This server already has an admin. Sign in instead.").

From here: invite people ([Accounts](/accounts/#adding-people)), open **Settings › Admin › Server** to choose whether sign-up is
**Invite only** (default) or **Open, with approval**, and read the [hardening checklist](#hardening-checklist).

### What the Compose file runs

| Service | Image | What it does |
|---|---|---|
| `atelier` | `ghcr.io/theoriuhd/atelier` | The server. Listens on 7340 inside the Compose network and is not published to the host. Data in the `atelier-data` volume at `/data`. |
| `sandbox` | `ghcr.io/theoriuhd/atelier-sandbox` | A small Debian container with Git, Python, Node and build tools, where Chat runs commands, each account as a Unix user of its own. Limited to 2 CPUs, 2 GB of memory and 512 processes. |
| `updater` | `ghcr.io/theoriuhd/atelier-updater` | Optional. Lets an admin press **Update server**. It holds the Docker socket; see [the updater](#the-updater-service). |
| `caddy` | `caddy:2` | Gets and renews the certificate, terminates HTTPS on ports 80 and 443, and forwards to `atelier:7340`. Certificates live in the `caddy-data` volume. |

The server image has a health check; `docker compose ps` shows `healthy` once it is up.

### Images and tags

Each release publishes the three images for **linux/amd64 and linux/arm64**, as `ghcr.io/<owner>/<name>:<tag>` and `:latest`
(a prerelease gets only its tag):

| Image | Contents |
|---|---|
| `ghcr.io/theoriuhd/atelier` | The server, the web app, the Linux runner builds and the GitHub CLI (for codespaces). Node 24. |
| `ghcr.io/theoriuhd/atelier-sandbox` | The Chat sandbox. |
| `ghcr.io/theoriuhd/atelier-updater` | The optional updater service. |

- The tag is the Git tag, including the `v`: `:v<version>`, not `:<version>`.
- `:latest` moves with **every** `v*` tag, including prereleases such as `v0.3.0-beta.1`. If you do not want to follow
  prereleases, pin a release tag in the Compose file.
- To build the server yourself from the repository root: `docker build -f apps/server/Dockerfile -t atelier .`
  (`--target sandbox` and `--target updater` build the other two). It needs BuildKit, the default in Docker 23 and later.
  An image built this way has no registry name, so **Settings › Admin › Server** tells you to update by rebuilding it.

## Connecting browsers and desktop apps

**Browsers** need nothing: open the address and sign in. The sign-in cookie lasts 30 days and is not renewed.

**Desktop apps** choose **Connect to a server** on first run (or **Settings › Account › Switch…** later) and enter the
**Server URL**. Accepted forms:

- `atelier.example.com`, `192.0.2.20:7340`, or a full `https://atelier.example.com`. Without a scheme, Atelier tries
  `https://` first and, if nothing answers within 4 seconds, `http://`. Plain `http://` is accepted only for this
  computer, private network ranges (10.x, 172.16 to 31.x, 192.168.x), link-local and Tailscale addresses (100.64.0.0/10),
  single-word names such as `nas`, and names ending in `.local`, `.localhost` or `.ts.net`. For anything else you get
  "Use https:// for … Plain http:// is only allowed for this computer, your local network and Tailscale (*.ts.net)."
- The server must answer `GET /api/health` with `{"ok":true,"app":"atelier",…}`. If it does not, you see "No Atelier
  server answered at …".

Under the field, **Found on your network** lists servers the app finds by asking every address in the private /24
networks of this computer's interfaces (at most two networks; VPN, Tailscale, container and virtual interfaces skipped)
for `http://<address>:7340/api/health` within about three seconds. It always checks this computer too.

- Only servers on **port 7340** over plain HTTP are found. A server behind Caddy on 443 that does not publish 7340 to
  the network is not listed; type its address.
- It sends only a health check, and only on the local network.
- On macOS the first scan makes the system ask whether Atelier may find devices on your local network. Answer yes, or
  see [Troubleshooting](/troubleshooting/#macos-and-a-server-on-your-local-network).

After you sign in, the desktop app registers itself as one of your **devices** (**Settings › Account › Devices**) and
keeps a link to the server open. While it is up, your sessions on the server can use the folders you trusted on that
computer; the desktop refuses any folder you did not open in its own folder picker. **Trusting a folder lets the server's sessions run commands as you on that computer**, and so
could the server if it were compromised. A different feature, [Remote control](/remote-control/), decides
whether your own other devices can open your conversations.

## Addresses, HTTPS and proxies

### `ATELIER_BASE_URL` and `ATELIER_TRUSTED_PROXIES`

Atelier decides what "the same site" means from two settings:

- **`ATELIER_BASE_URL`**: the address people type, for example `https://atelier.example.com`. When set, it is the answer:
  only its origin (scheme, host and port) is used.
- **`ATELIER_TRUSTED_PROXIES`**: a comma-separated list of IP addresses or CIDR ranges of your reverse proxy. Atelier
  believes `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For` only on connections that come from these.

Without `ATELIER_BASE_URL`, the origin is taken from the request: the `Host` header, with the scheme and host from the
proxy's headers if the proxy is trusted. The client's address (used for rate limits and the **Active sessions** list) is
the connection's address, or, through a trusted proxy, the nearest address in `X-Forwarded-For` that is not itself a
trusted proxy.

The Compose file sets both: the public address, and `172.16.0.0/12`, the range Docker uses for its networks. Check yours
with `docker network inspect` and adjust if your Compose network is outside it.

Set both whenever there is a proxy. Without `ATELIER_TRUSTED_PROXIES` every visitor appears to come from the proxy, so
wrong passwords for one username from anyone count together and anyone can lock that username out (see
[Accounts](/accounts/#rate-limits-and-lockouts)).

### What breaks when they are wrong

| If | You see |
|---|---|
| The address people use differs from `ATELIER_BASE_URL` (a different host, `http` against `https` in either direction, a missing port, the server's IP address on your LAN instead of its name) | In a browser, sign-in answers **Cross-site request refused.** and the live connection is refused with HTTP 403 ("Cross-site WebSocket refused."): the page loads and then spins. The server refuses requests whose `Origin` it does not recognise. |
| No `ATELIER_BASE_URL`, a TLS-terminating proxy, and the proxy is not in `ATELIER_TRUSTED_PROXIES` | The same, because Atelier sees an `http` request while the browser says `https`. |
| The hostname in `ATELIER_BASE_URL` changes after people added passkeys | The passkeys no longer work: they are bound to the hostname (see below). |
| A connector (an MCP server) signs in with OAuth through your server | The sign-in returns to `<ATELIER_BASE_URL>/oauth/callback`. If that address is not reachable from the admin's browser, the sign-in cannot finish. An authorization server that reads Atelier's client metadata fetches `<ATELIER_BASE_URL>/oauth/client-metadata.json`, so that address has to be reachable from it. |
| `ATELIER_TRUSTED_PROXIES` is missing behind a proxy | Rate limits and the sessions list see only the proxy's address. |

Desktop apps send no `Origin` header, so a wrong `ATELIER_BASE_URL` does not stop them, but a proxy that does not pass
WebSockets does. The server refuses to start with an invalid `ATELIER_BASE_URL`, or with a `ATELIER_TRUSTED_PROXIES` entry
that is not an IP address or CIDR range (`ATELIER_TRUSTED_PROXIES: "x" is not an IP address or CIDR range.`).

To test a proxy without a browser, open a WebSocket to `/api/ws` with `Origin` set to your public address: `101` means
accepted, `403` means refused.

### Passkeys need a hostname

Passkeys (WebAuthn) are offered only in a browser, over HTTPS (or on `localhost`), on an address with a **hostname**:
not on an IP address such as `https://192.0.2.20`. The relying party is the hostname of the server's public address, so
every device that uses a passkey must reach the server at that hostname. Changing the hostname orphans the passkeys; people sign in with their password and add them again. The desktop
app signs in with a password.

### Reverse proxies other than Caddy

Caddy needs no extra configuration. Anything else must:

- **Pass WebSockets** on `/api/ws` (the app) and `/api/devices/link` (desktop devices). Without this, the page loads and
  spins, and desktop apps say "The server answers, but refuses the live connection."
- **Keep the connection open.** The app's live connection carries every reply as it streams and has no ping of its own
  between replies. A proxy that closes idle connections after 60 seconds (nginx's default `proxy_read_timeout`) cuts it
  and interrupts replies in flight. Use an hour or more. The device link pings every 10 seconds and is not affected.
- **Forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`**, and not strip `Origin` or `Authorization`.
- **Not buffer or rewrite** the responses, and not add a second `Content-Security-Policy` (see
  [Security](/security/#the-web-servers-headers)). Uploads travel inside the WebSocket as base64 (up to 32 MB per file), so
  request-body limits do not apply to them.

An example for nginx:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
  listen 443 ssl;
  server_name atelier.example.com;
  # ssl_certificate and ssl_certificate_key here

  location / {
    proxy_pass http://127.0.0.1:7340;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

Set `ATELIER_BASE_URL=https://atelier.example.com` and put nginx's address in `ATELIER_TRUSTED_PROXIES`. If the proxy runs
on the same host and you publish the port for it, publish it on loopback only (`127.0.0.1:7340:7340`).

On a **tailnet**, use the machine's `*.ts.net` name; Tailscale and Caddy can get a certificate for it
(`tailscale cert`).

### On a LAN without HTTPS

For a home network you control, plain HTTP works. Publish the port instead of using Caddy, and leave `ATELIER_BASE_URL`
unset, or set it to exactly the address people type (`http://192.0.2.20:7340`):

```yaml
services:
  atelier:
    image: ghcr.io/theoriuhd/atelier:latest
    restart: unless-stopped
    ports: ['7340:7340']
    volumes: [atelier-data:/data]
volumes:
  atelier-data:
```

What you give up: passwords, sign-in cookies and every conversation cross the network in clear text, and passkeys are not
available. Browsers on other computers can use it; desktop apps accept `http://` for private addresses. Do not
expose this to the internet.

## The secrets key

Provider API keys, connector tokens and other secrets are encrypted at rest with AES-256-GCM. The key is **exactly 32
bytes**:

- **`ATELIER_SECRET_KEY`** (recommended): 64 hexadecimal characters or base64 of 32 random bytes. `openssl rand -base64 32`
  makes one. Anything else, a shorter passphrase included, stops the server from starting with "ATELIER_SECRET_KEY must
  encode 32 bytes (hex or base64)". The check only counts bytes: a typed passphrase of 43 or 44 letters and digits also
  decodes to 32 bytes and is accepted as a key, so generate the key instead of choosing one.
- **Without it**, the server makes a key on first start and keeps it in `/data/secret.key` (base64, mode 0600).

Consequences:

- The key and the secrets it protects are in the same volume unless you set the variable. A copy of the volume is then a
  copy of your API keys. Setting `ATELIER_SECRET_KEY` from a secret store, or encrypting backups, keeps them apart.
- **Restoring a backup on another host needs the same key.** Restore the volume with its `secret.key`, or set the same
  `ATELIER_SECRET_KEY`. A different key does not damage anything else; stored secrets simply cannot be read and are
  entered again in **Settings › Admin**.
- Setting `ATELIER_SECRET_KEY` on a server that already has a `secret.key` makes the variable win from then on: secrets
  encrypted with the file's key cannot be read until you set the variable to the same value (the file is base64 of the
  key).
- A damaged `secret.key` (not 32 bytes after decoding) stops the server from starting with "Secret key must be 32 bytes".

## Environment

The variables you will most often set on a server. The complete list, including every default, is
[Environment variables](/environment-variables/).

| Variable | Default | Meaning |
|---|---|---|
| `ATELIER_DATA_DIR` | `/data` in the image | Database, files, settings and the secrets key. Keep it on a volume. |
| `ATELIER_BASE_URL` | none | The address people use. Origin checks, passkeys, connector sign-ins and Secure cookies follow it. |
| `ATELIER_TRUSTED_PROXIES` | none | IPs or CIDRs of your reverse proxy. `X-Forwarded-*` is believed only from these. |
| `ATELIER_HOST`, `ATELIER_PORT` | `0.0.0.0`, `7340` in the image; `127.0.0.1`, `7340` from source | Where it listens. |
| `ATELIER_SECRET_KEY` | a key file in the data folder | See [The secrets key](#the-secrets-key). |
| `ATELIER_SETUP_TOKEN` | random at each start | The one-time token for creating the first admin. |
| `ATELIER_SANDBOX_HOST`, `ATELIER_SANDBOX_KEYS`, `ATELIER_SANDBOX_PORT`, `ATELIER_SANDBOX_SLOTS`, `ATELIER_SANDBOX_USER` | none, none, `2222`, `256`, none | The chat sandbox and how many accounts it holds. Leave out the host and chats have no sandbox. |
| `ATELIER_UPDATES_REPO` and `ATELIER_UPDATES_TOKEN` | none | Serve desktop updates from a GitHub repository's releases. Both are needed. |
| `ATELIER_UPDATER_URL` | none | The updater service, for **Update server**. |
| `ATELIER_UPDATE_FEED` | `https://updates.atelierhq.dev` | Where the server looks up the newest version; `off` stops the lookup, unless `ATELIER_UPDATES_REPO` is set. |
| `ATELIER_IMAGE` | set in released images | What image this is; empty means built from source. |

Put a value in `compose.yaml` under `environment:`, or write a placeholder there and keep the value in a `.env` file next to
it, which is how Compose fills in `${NAME}`:

```yaml
    environment:
      ATELIER_SECRET_KEY: ${ATELIER_SECRET_KEY}   # the value is a line in .env: ATELIER_SECRET_KEY=...
```

A `.env` file alone passes nothing to the container. Prefer it to your shell: the updater recreates services from the files
in that folder, and a value that lived only in your shell would be lost.

## The chat sandbox

Chat can use a sandbox: the model gets **Bash** and **Read** in a folder of its own, under fixed rules and without
permission prompts, to clone repositories and run code. On a server that folder is in the `sandbox` container. It:

- holds none of the server's data or secrets;
- is reached by the server over SSH with a key the server makes itself the first time a chat needs it (in
  `/data/sandbox`, published to the shared `sandbox-keys` volume);
- keeps each chat's folder under `chats/<account>/` in its own volume (`sandbox-home`);
- is shared by everyone on the server, but each account runs as a Unix user of its own in it (`sbx000`, `sbx001`, …), with a
  home and chat folders that only that user can enter, so one person's commands cannot read or change another's folders.
  Its sshd runs as root only to log each account in as its user, and the compose file takes away every other root power;
- has normal outbound network access and sits on the same Compose network as the server.

**Accounts and users.** The first time an account's chat needs the sandbox, the server gives it the lowest free user, for
good, keeps that in `sandbox/slots.json` in the data folder, and tells the sandbox which account the user is, through the
`sandbox-keys` volume (where the accounts themselves cannot read it). The sandbox remembers the first account each user was
given to, in `.slots/` in `sandbox-home`, and refuses logins as a user the server later hands to another account, so a lost
`slots.json` cannot give one account another's folders: restore `sandbox/slots.json` from your backup (back it up with the data
folder) or, if you mean to start over, remove the files in `/home/sandbox/.slots`. The pool has 256 users. For more accounts
set `ATELIER_SANDBOX_SLOTS` to the same number on the `atelier` and the `sandbox` service and recreate both; an account that
finds the pool full gets a message that says so. A deleted account keeps its user and its folders, so the pool counts every
account that ever used the sandbox.

**Updating from a version where all accounts shared one user.** Pull and recreate both images together
(`docker compose pull && docker compose up -d`, or **Update server**). The compose file you already have keeps working; the new
one only adds hardening you can copy (`security_opt`, `cap_drop` and `cap_add` of the `sandbox` service). Chats made before keep
their folders and their paths: when the new sandbox starts, everything the old shared user left in `sandbox-home` is locked to
root, so nobody can read it, and the first time an account's chat uses the sandbox again its `chats/<account>/` folder is handed
to that account's user, files and all. The folders of accounts that never come back stay locked. What else sat in the old shared
home (caches, old runner copies, anything outside `chats/`) is locked too; delete it when you no longer want it, for example
`docker compose exec sandbox sh -c 'cd /home/sandbox && rm -rf .cache .npm .atelier'`. If only one of the two containers was
updated, chats fail with "Permission denied" from the sandbox; update both. `ATELIER_SANDBOX_USER` (for a sandbox container you
built yourself, without account users) makes everybody log in as that one user, as before, without any of this separation.

Leave out the `sandbox` service and the `ATELIER_SANDBOX_*` variables and chats simply have no sandbox. See
[Security](/security/#the-chat-sandbox) for its limits.

## Code in the browser

Code and Cowork need somewhere to run commands, and the server never offers its own machine. A browser session can use:

- **A desktop app's folders.** Your signed-in desktop app, online, lends the folders you trusted. In the browser,
  choose **Remote Control** in the environment menu above the composer and pick the computer.
- **A codespace.** In **Settings › Cloud**, people connect GitHub with a personal access token (scopes `codespace` and
  `repo`), or, if an admin sets **GitHub OAuth app** (the client id of an OAuth app with device flow enabled), with a
  device code. Then **Cloud** in the environment menu lists their codespaces. Codespaces have not been verified against a
  real account.

Without either, a browser can still use Chat (including its sandbox), but Code and Cowork have no folder to open: their
start page says "Open the desktop app to work in a folder on your computer, or use a codespace."

## Data, backup and restore

Everything is in the data folder (`/data` in the image): the SQLite database, attachments and files, `settings.json`, the
secrets key. Back up the `atelier-data` volume with the server stopped. The exact commands, what to keep together, and how
to restore are in [Data and files](/data-and-files/#a-server).

## Updating

**Settings › Admin › Server** shows the server's version, and the newest one it knows of ("Atelier 0.1.10 is
available." or "Up to date. Checked 2 minutes ago."). The newest version comes from `stable/latest.yml` on the public
update feed, or, with `ATELIER_UPDATES_REPO` set, the newest non-draft, non-prerelease GitHub release of that repository.
The answer is cached for 10 minutes; **Check now** skips the cache. The server asks only when an admin opens the page or
presses **Check now**; with no internet it keeps showing the last version it saw.

What the page offers depends on how the server was installed:

| Install | What **Settings › Admin › Server** does |
|---|---|
| The Compose file with the `updater` service | **Update server** pulls the new `atelier` and `sandbox` images and recreates those two containers. Everyone is disconnected for a minute or so and reconnects by themselves; replies being written stop. Your volumes are kept. |
| Compose without the updater | Shows the command to run on the host, in the folder with `compose.yaml`: `docker compose pull && docker compose up -d`. |
| An image built from source (no registry name) | "This server was built from source; update it by rebuilding its image." |

Desktop apps and open browser tabs say so when their version and the server's differ; the messages are in
[Updates](/updates/#the-server).

Back up before updating. Database migrations run when the new version starts and only move forward; Atelier has no
rollback, and does not stop an older version from opening a database a newer one has migrated.

### The updater service

A container cannot replace itself, so the Compose file has a small optional service, `updater`. It gets the Docker socket,
which is **root on the host**, so it is deliberately limited:

- It answers only `GET /status` and `POST /update`, on the Compose network (port 7341, not published).
- Both need a secret the server makes on first use in the `updater-secret` volume (mode 0600; the updater mounts it
  read-only). It is never in an environment variable or a committed file.
- An update runs `docker compose pull` and `docker compose up -d --no-deps` for the `atelier` and `sandbox` services of the
  updater's own Compose project, using the Compose file and `.env` from the folder mounted read-only at `/project`.
  Nothing in a request names another command, image, service or project.
- The server itself never gets the socket.

If that trade is not for you, delete the `updater` service and `ATELIER_UPDATER_URL` from the Compose file; everything
else works, and the Server page shows the manual command. Things to know:

- It updates the images the Compose file names. With `:latest` that means the newest; with a pinned tag (`:v<version>`) it
  pulls the same tag again and nothing changes. To move a pinned server, edit the tag and run `docker compose up -d`.
- It does not update itself. `docker compose pull && docker compose up -d` on the host updates it with the rest.
- With private images, the updater needs a registry login: mount the host's `~/.docker/config.json` at
  `/root/.docker/config.json:ro`.
- A server on host networking cannot reach `http://updater:7341`. Publish the updater on loopback only
  (`ports: ['127.0.0.1:7341:7341']`) and set `ATELIER_UPDATER_URL=http://127.0.0.1:7341`.
- When it cannot do its job, the Server page says why: "The updater refused this server’s secret: both must mount the
  same `updater-secret` volume.", "The updater can’t be reached at …", "The updater found no `atelier` service in its
  compose project.", "The compose file … is outside the project folder the updater can see."

### Serving desktop updates from your server

Desktop apps connected to your server can update from it instead of from Atelier's public feed. Set both:

```yaml
ATELIER_UPDATES_REPO: your-org/atelier-builds     # owner/repo whose Releases hold the desktop builds
ATELIER_UPDATES_TOKEN: github_pat_...             # fine-grained, Contents: read-only on that repository
```

The server then serves electron-updater's feed at `/updates/stable/` and `/updates/beta/`, mirroring the files of that
repository's newest release (stable skips prereleases, beta includes them, drafts never count). The release list is cached
for five minutes, and only signed-in people get files. The log says "Serving desktop updates from GitHub releases".

- **Both variables are required.** With only `ATELIER_UPDATES_REPO`, the feed answers **404**: "This server has no update
  feed: set ATELIER_UPDATES_REPO and ATELIER_UPDATES_TOKEN to serve one." (To signed-out callers it answers 401.) A
  desktop app that gets a 404 from its server falls back to Atelier's public feed.
- **Every package needs a signature.** Apps install only packages with a valid `<file>.sig` next to them, made with the
  key whose public half is built into the app (see [Updates](/updates/#what-is-verified)). The release workflow
  creates them when the repository has the `UPDATE_SIGNING_KEY` secret; otherwise
  run `node deploy/cloudflare/sign-release.mjs <folder>` on the packages and attach the `.sig` files to the release as
  extra assets, or the app reports "Atelier … is not signed, so it was not downloaded." A fork that builds its own apps uses its own key pair; the steps are in [Updates](/updates/#publishing-updates).
- The repository's release workflow (`.github/workflows/release.yml`) builds the macOS, Windows and Linux packages for
  each `v*` tag and attaches them with their `latest*.yml` files. A tag containing `-` becomes a prerelease.

## Docker without Compose

The server alone, behind a proxy you run yourself:

```bash
docker run -d --name atelier --restart unless-stopped \
  -p 127.0.0.1:7340:7340 \
  -v atelier-data:/data \
  -e ATELIER_BASE_URL=https://atelier.example.com \
  -e ATELIER_TRUSTED_PROXIES=<your proxy's address as the container sees it> \
  -e ATELIER_SECRET_KEY=<64 hex characters or base64 of 32 bytes> \
  ghcr.io/theoriuhd/atelier:latest
```

Without the other services there is no chat sandbox and no **Update server** button; update with `docker pull` and
recreate the container. To see your proxy's address as the container sees it, open **Settings › Account › Active sessions**: the **IP address**
column shows it.

## Running from source

You need Node.js 24 or later and pnpm.

```bash
pnpm install
pnpm --filter @atelier/ui build
pnpm --filter @atelier/server build
node apps/server/dist/server.mjs     # http://127.0.0.1:7340, data in ./.atelier-data
```

- It listens on `127.0.0.1:7340` and keeps data in `.atelier-data` in the current directory unless you set
  `ATELIER_HOST`, `ATELIER_PORT` and `ATELIER_DATA_DIR`. Setting `ATELIER_HOST` to anything but loopback logs "Listening on
  … Put Atelier behind HTTPS (a reverse proxy such as Caddy) before exposing it beyond your machine."
- The web app is found next to the source tree; `ATELIER_UI_DIR` points elsewhere. Without a build the server serves only
  its API.
- For codespaces, build the runners (`pnpm runner:build`, needs Go) and set `ATELIER_RUNNER_DIR=runner/bin`. Chat's sandbox
  needs the Compose setup.
- `pnpm dev:web` rebuilds and restarts the server as you edit.
- Keep it running with whatever you use for services. A minimal systemd unit:

```ini
[Service]
User=atelier
WorkingDirectory=/opt/atelier
Environment=ATELIER_DATA_DIR=/var/lib/atelier ATELIER_HOST=127.0.0.1
EnvironmentFile=/etc/atelier.env
ExecStart=/usr/bin/node apps/server/dist/server.mjs
Restart=on-failure
```

An install from source has no `ATELIER_IMAGE`, so **Settings › Admin › Server** tells you to update by rebuilding it.

## Sizing and limits

Atelier does not publish measured requirements. What is known:

- **The server itself is light:** one Node.js process and a SQLite database; the models run on other machines. Memory
  and CPU grow with the number of people active at once and with long conversations.
- **Disk is the thing that grows.** Conversations, attachments, tool outputs and file versions for Rewind (30 days by
  default) accumulate in `/data`. **Settings › Privacy** can delete old conversations per person. The `sandbox-home`
  volume grows with the repositories chats clone.
- **Containers in the Compose file:** the sandbox is capped at 2 CPUs, 2 GB and 512 processes, the updater at 256 MB. The
  server has no limit.
- **One data folder, one process.** Do not point two servers at the same folder: SQLite will wait up to five seconds for
  its lock and then fail.
- **Limits that matter to people:** uploads are 32 MB per file (avatars 5 MB); a device can run up to 32 workspaces at
  once; a session lasts 30 days from last use, but a browser's cookie ends 30 days after sign-in; an invite code lasts 7 days; 8 wrong passwords for one username from one
  address, or 8 wrong invite codes from one address, in 15 minutes are refused for a while; temporary chats that nobody
  left open are removed after a day.

## Hardening checklist

- [ ] HTTPS in front, with `ATELIER_BASE_URL` set to the exact public address. Add `Strict-Transport-Security` at the proxy.
- [ ] `ATELIER_TRUSTED_PROXIES` set to your proxy only.
- [ ] `ATELIER_SECRET_KEY` set, kept in a secret store, and not stored in the backup it protects.
- [ ] Sign-up left on **Invite only** unless you want strangers able to request accounts.
- [ ] The first admin created, and a second admin added, so that losing one account does not lock you out of
  administration. The last admin cannot be demoted, disabled or deleted.
- [ ] Port 7340 not published to the internet: only the proxy is.
- [ ] Backups tested by restoring them.
- [ ] Docker's `updater` service kept only if you accept the Docker socket trade-off.
- [ ] Image tags pinned if you want to decide when updates happen.
- [ ] Providers' keys scoped and spend-limited at the provider; everyone on the server shares them.
- [ ] Admin account sign-ins reviewed under **Settings › Account › Active sessions**.
- [ ] Consider putting the `sandbox` container on a network of its own: by default it shares the Compose network with
  the server and can reach it.

## Troubleshooting a server

| Symptom | Cause and fix |
|---|---|
| The page loads and then spins | The live connection is refused. Check `ATELIER_BASE_URL` against the address in the browser's bar, and that the proxy passes WebSockets. See [what breaks](#what-breaks-when-they-are-wrong). |
| Sign-in works and you are signed out at once | The browser blocks cookies for the site. |
| "Too many attempts. Try again in a few minutes." | 8 failures for one username from one address in 15 minutes. Wait, or check that `ATELIER_TRUSTED_PROXIES` is set so one person's failures do not count against everyone. |
| The container exits at start with "ATELIER_SECRET_KEY must encode 32 bytes (hex or base64)" | The key is not exactly 32 bytes. Generate one with `openssl rand -base64 32`. |
| It exits with `ATELIER_TRUSTED_PROXIES: "…" is not an IP address or CIDR range.` | One entry is a hostname or has a typo. |
| It exits with `ATELIER_UPDATES_REPO must be owner/repo` | The value has a different shape. |
| It cannot write `/data` | The volume or bind-mounted folder must be writable by the container's `atelier` user (`docker compose exec atelier id`). |
| "UI build not found; serving the API only" in the log | `ATELIER_UI_DIR` points at a folder without a build. |
| No setup token in the log | The server already has an account, so none is printed. There is no command-line password reset: another admin resets a forgotten password in **Settings › Admin › Users**, and a passkey still signs you in. If the only admin forgot the password and has no passkey, the app offers no way back in, so keep a second admin. |
| Chats say they have no sandbox | `ATELIER_SANDBOX_HOST` is not set, or the `sandbox` service is down. `docker compose logs sandbox`. |
| Chats say "The sandbox can't be reached: … Permission denied" | The `sandbox` container is older than the server (update both), or it refused the account's user because the server gave it to a different account than before (`docker compose logs sandbox` says which; see [the chat sandbox](#the-chat-sandbox)). |
| Chats say "The sandbox has no free account left" | Every user of the sandbox is taken; raise `ATELIER_SANDBOX_SLOTS` on both services. |
| "This app has no runner builds to put into a codespace." | `ATELIER_RUNNER_DIR` is not set (only from source; the image sets it). |
| **Update server** is missing, or the page says "This server has no updater service." | The button appears only when a newer version exists and the updater answers. Otherwise `ATELIER_UPDATER_URL` is not set, or the updater is down. |
| A desktop app says "The server doesn’t offer updates for this computer yet. Its admin sets them up with ATELIER_UPDATES_REPO." | The server's feed is off (it answers 404) and the app has no public feed to fall back to (`ATELIER_UPDATE_FEED=off` on the desktop). See [Serving desktop updates](#serving-desktop-updates-from-your-server). |
| A desktop app cannot connect | See [Troubleshooting](/troubleshooting/#cant-reach-the-server). |

Look at the server's log first: `docker compose logs -f atelier`. It is mostly one JSON object per line, with `level`,
`message` and sometimes `error`.
