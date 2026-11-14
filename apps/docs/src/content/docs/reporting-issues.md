---
title: Reporting issues and requesting features
description: "Send a problem or an idea to the Atelier developer from the app: what goes with it, what never does, and where it ends up."
---

*(next release)* Atelier has a built-in way to tell its developer about a problem or ask for a feature. Reports and
requests land in separate inboxes on the developer's side, together with what is needed to understand them, so there's no
need to collect versions and screenshots by hand.

## Sending one

- Press **F1** anywhere in the desktop app (change it in **Settings › Shortcuts**). The report opens with a picture of the
  window as it was when you pressed it. Take the picture out if you don't want it sent.
- Or use **Help › Report an Issue…** or **Help › Request a Feature…** in the desktop app's menu, **More** in the sidebar,
  the search palette (**Report an issue…**), or **Settings › Privacy › Reports**.
- In the terminal app: `/bug <what happened>` or `/feature <what you'd like>` ([CLI reference](/reference/cli/)).

Write a title and a sentence or two about what happened and what you expected, or what you'd like and how you'd use it.
Atelier asks for a little more when the text is too short to act on, and refuses padding like a row of repeated letters.

**Contact** is optional: an email address or GitHub name if you'd like an answer. After sending, you get an id such as
`I-7F3K2Q` (issues) or `F-4M9W1D` (feature requests). Mention it if you also write about it elsewhere.

## What can go with it

Each of these is shown before you send it: press **Show** to see exactly what goes.

| Attachment | Issue | Feature request | What it holds |
|---|---|---|---|
| **Diagnostics** | on | off | See [below](#diagnostics). |
| **A conversation** | off | off | One chat or Code session you pick: its messages with tool calls, results, thinking and context notes. A long one keeps how it started and its newest messages, with the gap named. Very long parts are shortened in the middle. Sub-agents come with their last few messages. Pictures and files in it are only named. |
| **Pictures** | the window, with F1 | none | Up to 4, pasted, dropped or added. Each is scaled to at most 2560 pixels on its longest side and compressed (WebP, or JPEG where the browser can't write WebP) to under 2.5 MB. |

Atelier's version, whether it runs on this computer, a server or in a browser, and the window's size and theme go with every
report, so it can be matched to a release.

### Diagnostics

- **This computer:** the system and its version, processor, memory, graphics cards with their memory and driver, the free
  space on the disk of Atelier's data, and the monitors. On a server, the server's too, and whether it runs in a container.
- **Atelier:** the version, update channel, the Electron, Chrome and Node versions, and the sizes of its database.
- **Settings and your preferences**, with keys, header values, addresses, paths and anything written in your own words left
  out. Your name, personal instructions, Git identity and SSH connections are left out entirely.
- **Providers:** each one's type, where it is (`api.openai.com`, `localhost:11434`, or just `private network` / `other
  host`), whether a key is set (never the key), its models and its last status.
- **Local model servers** you set up (Ollama, llama.cpp, LM Studio and other OpenAI-compatible servers, ComfyUI): the
  version, the models installed, which are loaded now and how much memory they take.
- **Connectors:** their kind, state, number of tools and last error. **Computer use:** available and on or off.
- **The end of the desktop app's log** (200 lines) and the last error the window hit, redacted line by line the way
  [Copy diagnostics](/troubleshooting/#reporting-a-bug) does.

## What never goes

API keys, tokens, passwords, private keys and secret references are taken out of everything, a conversation included:
known key formats, `Bearer` and `Basic` credentials, passwords in addresses, and values of fields named like a secret
(`password: …`, `API_KEY=…`). Your home folder is shown as `~`, and your account and computer names are hidden wherever they
appear. The report server scrubs again before it stores anything.

A conversation you attach is sent with its text, because that is what makes it useful: don't attach one with something in
it you wouldn't send.

## Where it goes

Reports go to `reports.atelierhq.dev`, a collector run by the Atelier developer on Cloudflare. Only the developer can read
them. They are deleted after a year at the latest. The collector keeps no IP addresses: to limit how many reports one
address can send in a day, it keeps a keyed hash of the address and the day, and deletes it after two days. Each report
carries a small proof of work, so that flooding the collector costs real computing time. The
[Datenschutzerklärung](https://atelierhq.dev/datenschutz/) has the details.

## Turning it off

An admin can switch off **Settings › Privacy › Allow reports to the Atelier developer** for everyone on a server or on this
computer. The report buttons then say so, and nothing can be sent. An older server that predates reports also can't send
them.

If you'd rather report on GitHub, [Copy diagnostics](/troubleshooting/#reporting-a-bug) still puts the same kind of
summary on your clipboard, and nothing is sent until you paste it. For a security problem, see
[Security](/security/#reporting-a-security-problem) instead.
