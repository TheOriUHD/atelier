---
title: Connectors
description: Give Atelier tools from other services with MCP servers. Add one, sign in or paste a token, decide which tools may run, and choose which conversations use them.
---

A connector is an [MCP](https://modelcontextprotocol.io) server: a program or web service that offers tools the model can
call. Cloudflare, GitHub, Notion, Linear, Brave Search and Home Assistant have ready-made entries; anything else that
speaks MCP can be added by its address or by the command that starts it. Once a connector is on, its tools sit beside
Atelier's own in Chat, Cowork and Code, and in sub-agents.

Connectors belong to the **backend**, not to each person. An admin adds them, signs them in and sets what their tools may
do; everyone on the server shares one connection and chooses per conversation which connectors it uses. If you run Atelier on your own computer, you are the admin.
On a server, everyone can also add [their own connectors](#your-own-connectors-on-a-server), with their own keys, that only
they use.

:::caution
Because the connection is shared, a connector acts as the account that signed in or whose token was pasted. Everyone on the
server who turns the GitHub connector on works with the admin's GitHub token. Give connectors the least access they need.
:::

## Add a connector

**Settings › Admin › Connectors** (also **Customize › Connectors**, for admins) lists the connectors and has **Add
connector**. Pick a service, or **Custom** ("Any MCP server, by its URL or the command that starts it").

### Ready-made entries

<!-- screenshot: the Add connector dialog with the ready-made entries and Custom -->

| Entry | Connects to | Needs | Sign in with OAuth |
|---|---|---|---|
| **Cloudflare** | Workers, DNS, R2, D1 and the rest of your account, at `https://mcp.cloudflare.com/mcp` | An API token. Grant only what you need; account tokens need "Account Resources: Read", and IP-filtered tokens don't work. | Yes |
| **GitHub** | Issues, pull requests, code search and Actions, at `https://api.githubcopilot.com/mcp/` | A personal access token (fine-grained works; classic ones need the `repo` and `read:org` scopes). GitHub's hosted server may need Copilot on your account. | No |
| **Notion** | Search, read and update the pages and databases shared with your integration | An integration secret, run with `npx -y @notionhq/notion-mcp-server` (needs Node.js, desktop app only); or sign in to Notion's hosted server at `https://mcp.notion.com/mcp` | Yes (the only way on a server) |
| **Linear** | Issues, projects and cycles, at `https://mcp.linear.app/mcp` | A personal API key | Yes |
| **Brave Search** | Web, news and image search through Brave's API | An API key, run with `npx -y @brave/brave-search-mcp-server` (needs Node.js, desktop app only) | No |
| **Home Assistant** | Devices, sensors and automations, at `<your address>/api/mcp` | The address of your Home Assistant (for example `http://homeassistant.local:8123`) and a long-lived access token from your profile; the "Model Context Protocol Server" integration must be enabled there | No |

Each form asks for a **Name** (up to 64 letters, digits, `-` and `_`; it becomes part of every tool's name, `mcp__name__tool`), then either the token
(with a link to where to create it) or **Sign in with {service}**, and then **Add connector** or **Add and sign in**. A pasted token is stored encrypted in the
secret store (**Settings › Admin › Keys & secrets**, with the id `mcp-<name>`), and the connector's settings only refer to
it as `${secret:mcp-<name>}`; it never appears in a settings file. On a server, Brave Search (which runs a program) is
disabled with "Only in the desktop app: it runs a program on your computer.", and Notion offers only its sign-in.

:::note
Brave Search as a connector gives the model a search tool of its own. Atelier already searches the web without one; to use
Brave for that, see [Web search](/web-search/#use-my-own-search-service).
:::

### Custom connectors

**Custom** asks for:

| Field | Meaning |
|---|---|
| **Name** | 1 to 64 letters, digits, `-` and `_`. Errors: "Give it a name.", "Use up to 64 letters, digits, - and _.", "There is a connector with this name already." |
| **Connects over** | **HTTP** (the current MCP transport; if a server only speaks the older HTTP+SSE protocol, Atelier switches to it), **SSE** (that older streaming transport, chosen outright) or **stdio** (Atelier starts the server as a program; desktop app only, greyed out on a server). |
| **URL** (HTTP, SSE) | The server's address, such as `https://example.com/mcp`. |
| **Sign in with OAuth** (HTTP, SSE) | For servers you sign in to instead of giving them a token; signing in starts once it is added. |
| **Command** and **Arguments** (stdio) | For example `npx` and `-y`, `@scope/mcp-server`, one argument per line. |
| **Headers** (HTTP, SSE) or **Environment variables** (stdio) | Name and value pairs. A value is plain text, a reference to a stored secret (`${secret:id}`) or to an environment variable of the backend (`${NAME}`), filled in only when connecting. The lock beside a value moves it into **Keys & secrets** when you save; names that look like credentials (token, key, secret, password, credential, auth) are locked automatically. `Authorization: Bearer …` keeps its scheme and stores only the token. |

The entry is saved as `mcpServers.<name>` in the backend's global settings file, in Claude Code's shape, so you can also
write it by hand:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${secret:mcp-github}" }
    },
    "notes": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/ada/notes"]
    },
    "wiki": { "type": "http", "url": "https://wiki.example.com/mcp", "auth": "oauth", "disabledTools": ["delete_page"] }
  }
}
```

`enabled` (default `true`), `disabledTools` and `preset` are the other keys. A stdio server needs a `command`, an HTTP or
SSE server a `url`, and only HTTP and SSE servers can use `"auth": "oauth"`.

:::caution
A stdio connector is a program that runs **as you** on your computer, with your files and network. `npx -y` downloads and
runs whatever is published under that name. Add only servers you trust. A web server never starts stdio servers.
:::

### Edit, switch off and remove

The list shows each connector's name, type, status, how many of its tools are on, and a switch (**Enable {name}**) that
turns the whole connector off for everyone. Click a row to open it. There, **Test connection** reconnects it and the
**⋯** menu has **Edit** (the same form; the name, switches and tool settings stay), **Sign out** (OAuth connectors) and
**Remove**. Removing a connector takes its tools out of every conversation and deletes its permission rules; the keys it
used stay in **Keys & secrets** until you delete them.

### Import from Claude Code and `.mcp.json`

On the desktop app, **Import from Claude Code** reads the connectors Claude Code already has: your user and per-project
servers in `~/.claude.json` and the `.mcp.json` files at the top of your folders on this computer. You choose which to
import; the credentials written into them move into the secret store, and a name that is already taken is marked "Already
added". HTTP, SSE and stdio servers are imported; WebSocket and SDK servers have no counterpart and are skipped.
`${VAR}` references work as they do in Claude Code.

Atelier does **not** load a project's `.mcp.json` by itself. Connectors are shared by everyone on the backend and are the
admin's decision, so a file in a repository can't add a server that runs on your computer. Import is also a one-time copy:
later changes to the file are not followed. On a server the button isn't offered ("Importing from Claude Code works in the
desktop app, where its settings live."); import them as [your own connectors](#your-own-connectors-on-a-server) instead.

## Your own connectors (on a server)

On an Atelier server, **Customize › Connectors** has **Your connectors** for everyone, admins included: connectors only you
use, with keys only you give. They sit beside the admin's in **+ › Connectors**, with the same switches per conversation.
Your own desktop app's backend has no such section; there, the connectors in **Settings › Connectors** are already yours.

**Add your own** asks for a **Name**, how it **Connects over** (**HTTP**, **SSE** or **stdio**), its **URL** (with **Sign
in with OAuth**) or its **Command** and **Arguments**, and **Headers** or **Environment variables**. Every value is kept
encrypted on the server as your own secret, never in your preferences and never shown again: editing a connector shows
"Unchanged" for a value you leave empty. **⋯** has **Edit**, **Sign in** (OAuth ones) and **Remove**, which forgets its keys
and sign-in.

Where each one runs:

| Connector | Runs |
|---|---|
| stdio (a program) | On your computer: the first one that is online, in the Atelier desktop app signed in to this server, and allows exactly that program. Adding it in the desktop app allows it there; on another computer, choose **Run on this computer** in its **⋯** menu. |
| HTTP or SSE at a public address | On the server. |
| HTTP or SSE at an address on your computer or its network (`localhost`, `192.168.…`, `*.local`) | Through your desktop app, which allows that address when you add it there (**Reach through this computer** elsewhere). |

A program runs in your home folder with a small set of your environment (`PATH`, `HOME`, `USER` and the like) plus the
variables you gave it; a value like `${GITHUB_TOKEN}` is filled in from your computer's environment when it starts, never
the server's. A connector can't set variables that change which code runs (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`,
`PYTHONPATH`, `PERL5LIB`, `npm_config_*`, `GIT_*` and the like). Your computer keeps a fingerprint of the command, its
arguments and its variables' names: if the connector changes, it says "It changed since you allowed it on {computer}:
allow it in Customize › Connectors in the Atelier desktop app there again." What the program writes to its error output
stays in your connector's log.

| Status | Meaning |
|---|---|
| **Ready on {computer}** | It runs on (or through) that computer. |
| `It runs a program on your computer: allow it in Customize › Connectors in the Atelier desktop app there.` | No computer of yours that is online allows it. |
| `Offline on {computer}: it runs there.` | The computer it ran on went offline; it starts again when one comes back. |
| `An admin's connector is also called {name}: rename yours.` | The admin's connector of that name is used instead. A new connector can't take an admin's name. |

**Import from Claude Code** is offered in the desktop app signed in to a server: it reads Claude Code's connectors on
that computer (as above), shows each one's exact command line, and adds the ones you choose as yours, allowed on that
computer. The server can read those settings only for two minutes after you open the import there.

## Sign in with OAuth

Some services are signed in to instead of given a token. Adding Cloudflare, Linear or Notion offers **Sign in with …**, and
a custom HTTP or SSE connector has the **Sign in with OAuth** switch.

1. Choose **Add and sign in** (or **Sign in** on a connector that shows "Not signed in"). The service's sign-in page opens:
   in your system browser on the desktop app, in a new tab on a web page. The connector shows "Waiting for sign-in", with
   **Open it again** and **Cancel**. Atelier waits ten minutes.
2. Sign in and allow access. The browser comes back to Atelier and the page says "Signed in". On the desktop it returns to
   a listener on `127.0.0.1` that exists only for this sign-in; on a server, to `/oauth/callback` on the address you reached
   the server at, which must be the same browser where you started, signed in to Atelier as yourself.
3. The connector connects. Every session now uses this one sign-in.

Atelier discovers the service's authorization server, registers as a public client (PKCE, no client secret), asks only for
access to that server's resource, and checks that the answer comes from the server it started with. The sign-in page must
use https (http is accepted for a loopback address only). The access and refresh tokens are kept as one encrypted secret
(named "Sign-in for {name}", an "OAuth token" in **Keys & secrets**) and refreshed on their own. If the service refuses the refresh, or the sign-in is revoked, Atelier
forgets it and the connector shows **Sign in** instead of an error. **Sign out** in the **⋯** menu forgets the sign-in
on purpose, and so does removing the connector, turning OAuth off for it or changing its URL.

| Message | Meaning |
|---|---|
| `This sign-in has expired or was used already. Start it again in Settings › Admin › Connectors.` | The one-use link was used or timed out. |
| `Finish signing in in the browser where you started it, signed in to Atelier as yourself.` | The return came from another browser or person. |
| `The sign-in page must use https, but it is http://…` | The service offered an insecure page. |
| `The server didn’t ask to sign in.` | The server doesn't use OAuth, or already accepts the request. |
| `The sign-in was refused or didn’t finish.` | You declined, or the service returned no code. |
| `The sign-in came back from another authorization server than the one it started at.` | A mismatch the check refused. |

## Tools and permissions

<!-- screenshot: a connector's page with its tools, each with Always allow, Ask and Block and a Use switch -->

Open a connector to see its **Tools**: each with its description, a **Read-only** badge when the server says the tool
doesn't change anything (a hint Atelier never trusts for permissions), and two controls.

- **Use {tool}** (the switch) keeps the tool from the model when off; the list shows the count ("3 of 5").
- **Always allow**, **Ask** or **Block** decides when it may run:

| Setting | What happens when the model calls the tool |
|---|---|
| **Ask** (the default) | In Chat, a prompt asks you each time. In Cowork and Code it follows the session's permission mode: you are asked in **Ask** and **Accept edits** modes; in **Auto** mode, the reviewing model decides first and hands the decision to you when it is unsure. See [Permissions](/permissions/). |
| **Always allow** | It runs without asking, in any mode except plan mode. |
| **Block** | It is refused, and the model is told the person's settings rule it out. |

Behind the control is a permission rule on the tool's name: **Always allow** adds `mcp__{connector}__{tool}` to **Settings
› Admin › Code › Allow rules**, **Block** adds it to **Deny rules**, and **Ask** removes both. You can write
`mcp__github` (every tool of a connector) or `mcp__github__*` yourself in those lists. When a prompt appears, **Always
allow** there makes a personal or per-project rule instead. In plan mode a connector tool runs only if the server marks it
read-only (and then follows its setting); the others are refused. Bypass mode allows everything that no **Block** rule
stops. Removing a connector removes its rules.

A connector's rules cover every mode: they are the one permission that applies in Chat as well.

## Choose connectors per conversation

In the composer, **+ › Connectors** lists every connector with a checkbox and a count ("2 on"); one that can't be used
reads "Not connected" or "Switched off by an admin". Unchecking a connector keeps its tools out of that conversation
only; the choice is saved with the conversation, applies from its next message, and can be made before the first message
of a new conversation. A sub-agent uses the connectors its parent has on.

When you change the selection mid-conversation the model is told once: "The github connector is now on
for this conversation; its tools are available." or "… is now off for this conversation; its tools are gone." (see
`connector-on` and `connector-off` in the [context updates](/prompts/context-updates/)).

## How tools reach the model

Each tool becomes a tool named `mcp__{connector}__{tool}`; anything outside letters, digits, `_` and `-` becomes `_`, and
the whole name is cut at 64 characters (a clash keeps the first). Its description is the server's, cut at 2,048 characters
and escaped so it cannot pose as an Atelier instruction; for models with a small window only its first sentence is kept.
A conversation keeps the tool definitions it first saw, so a server that rewrites its tools mid-conversation doesn't
break the cache; the set refreshes when tools are added or removed.

A conversation through **ChatGPT Chat**, the experimental desktop-only way to use a ChatGPT plan, lists
connector tools on request: the model sees only each tool's name and the start of its description until it asks for the
ones it needs (`ToolSearch`, three at a time), which keeps the prompt small.

Results come back as text (up to 100,000 characters, then `[Output truncated: showing 100000 of N characters.]`; an empty
one reads `(no output)`). PNG, JPEG, GIF and WebP images are passed on as images; audio, other media and resource links are
summarized as a line. Anything that looks like a credential the connector was given is masked (`••••`) in its output,
errors and logs.

### Questions from a connector

A server can stop a tool call to ask you something. A form shows as a card titled "{connector} asks for information" with
**Submit**, **Decline** and **Cancel**; a request to open a page shows "{connector} asks you to open a link" with the full
address, **Open link**, **Accept** and **Decline**. Links never open by themselves. The call's 60-second timer pauses while
you answer.

### Timing and limits

| | |
|---|---|
| Connecting | On first use, or when a status is asked for (opening the Connectors page). Gives up after 30 seconds. |
| Retrying | After a drop or a failed connection: 1 s, 2 s, 4 s … up to every 5 minutes. A connector that needs a sign-in waits for an admin instead. |
| Starting a conversation | A run waits up to 10 seconds for connectors still connecting, then starts without their tools. |
| One call | 60 seconds, then it is cancelled. Time spent waiting for your answer does not count. |
| Protocol | MCP 2026-07-28 where the server supports it, the earlier `initialize` handshake otherwise (the connector's page says which: "MCP 2026-07-28" or "MCP 2025 or earlier"). Tool changes the server announces are followed. |
| Settings change | The connector restarts; switching tools on or off doesn't reconnect it. |

## Security

A connector gives the model hands outside Atelier, and what it returns is text from a third party.

- **Prompt injection.** A tool result, like a web page, can contain instructions. The model is told to treat connector
  output as data and to tell you when it tries to steer it, but that is a rule for the model, not a guarantee. Grant
  **Always allow** only to tools whose worst misuse you can live with, and leave write and delete tools on **Ask** or
  **Block**. In Auto mode, a call that is not allowed by rule is reviewed by another model; see [Permissions](/permissions/).
- **Shared credentials.** A token or sign-in belongs to the backend and serves every person on it. Your own connectors'
  keys and sign-ins are yours: nobody else's sessions use them, and admins don't see them.
- **Programs.** Only the desktop app starts stdio servers, and they run with your privileges: an admin's on the desktop's
  own backend, your own ones on your computer when its desktop app allows them.

Tokens are kept in the encrypted secret store and masked in output, errors and the connector log. See
[Security](/security/) for the larger picture.

## Troubleshooting

A connector's status is **Connecting**, **Ready**, **Error**, **Off**, **Not signed in** or **Waiting
for sign-in**. **Test connection** on its page reconnects it. **Settings › Admin › Developer** has **Connector logs**
(everything the connector printed and its connections and failures, last 200 lines, credentials masked) and **Reload
connectors and extensions**, which reconnects every connector.

| Message | What to do |
|---|---|
| `Missing the secret "mcp-github".` or `Missing the environment variable NAME.` | The settings refer to a secret or variable that doesn't exist. Add it in **Keys & secrets**, or fix the reference. |
| `This server runs a program on this machine (stdio), which only the desktop app does. …` | Use the service's HTTP address instead, or run the desktop app. |
| `The github connector is not connected: …` | It dropped. Atelier reconnects by itself; open its page and choose **Test connection** to try now. |
| `The wiki connector is signed out. An admin needs to sign in to it again in Settings › Admin › Connectors.` | Its sign-in was revoked or expired. |
| `The tool did not finish within 60 seconds and was cancelled.` | The server was too slow. Try a smaller request. |
| `The server ended the connection.` / `The connection closed.` | The server went away; it is retried with growing pauses. |
| `Signing in failed: …` | Read the rest of the message; start again with **Sign in**. |
| A token that worked stops working | The token expired or lost its scopes. Create a new one and use **Rotate** on its secret in **Keys & secrets**. |
