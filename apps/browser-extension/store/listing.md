# Chrome Web Store listing

What goes into the Chrome Web Store's developer dashboard for Atelier for Chrome. Build the upload with
`pnpm --filter @atelier/browser-extension build:store` (`out/atelier-for-chrome-<version>.zip`, the manifest without its
`key`). Screenshots, the promo tiles and the icon are in `store/images/` (`node apps/browser-extension/store/render.mjs` draws them from `store/shots.html`).

## Store listing

**Name:** Atelier for Chrome (from the manifest)

**Summary** (from the manifest): Lets Atelier work in web pages for you, in tabs of its own, while you keep using your
browser.

**Category:** Productivity › Tools. **Language:** English.

**Description:**

Atelier for Chrome connects your browser to Atelier, the AI workspace for your desktop, so the assistant can do things on
the web for you: look something up across a few sites, compare products, fill in a form you asked it to, or read a page
you're signed in to.

It works in tabs of its own, in the background, in an orange tab group named after the chat. Your own tabs stay yours:
it never reads them and never takes the front of your screen. Its tabs stay open after a reply, for you to look at and for
the next question, and close when you delete the chat. You keep working while it works, and you can watch: the tab it
works in glows orange, and a label at the bottom left says what it is doing right now ("Reading page…").

How it works
• The assistant opens a page in its own tab, reads its text and its links, buttons and fields, and clicks, types, chooses
  from lists and scrolls by name.
• Everything it reads goes only to the Atelier desktop app on the same computer, through Chrome's native messaging. The
  extension makes no network requests of its own, has no analytics and loads no code from anywhere.
• It never types passwords or completes a purchase, and it asks in the chat before it accepts terms or sends anything.
  Permission rules you set in Atelier for the browser apply.
• While it acts in a page, Chrome shows a bar saying Atelier started debugging the browser; Cancel there stops it.

Requires the Atelier desktop app (macOS, Windows or Linux) from https://atelierhq.dev. Works in Chrome, Brave, Edge and
Arc.

**Homepage:** https://atelierhq.dev
**Support:** https://docs.atelierhq.dev/computer-use/#web-pages-atelier-for-chrome (contact@atelierhq.dev)

## Privacy practices

**Single purpose:** Lets the Atelier desktop app open web pages in tabs of the extension's own, read them and act in
them, for tasks the person gives Atelier.

**Permission justifications:**

| Permission | Why |
|---|---|
| `nativeMessaging` | The extension's only connection: it talks to the Atelier desktop app on the same computer, which registers the native host `dev.atelier.browser`. |
| `tabs` | Opens its own background tabs, reads their title, address and loading state, navigates them and closes them when the task ends. It never uses the person's own tabs. |
| `tabGroups` | Keeps each chat's tabs together in a collapsed orange group named after the chat, apart from the person's tabs. |
| `debugger` | Sends trusted clicks, typing and scrolling to pages in its own tabs and takes screenshots of those tabs while they are in the background (the DevTools Protocol's Input and Page domains). Only in its own tabs; Chrome shows its "started debugging" bar meanwhile. |
| `scripting` | Reads a page's text and its links, buttons and fields in its own tabs, makes links there that would open a new tab open in the same tab, so nothing comes to the front, and shows the orange glow and the label with its current step in the tab it works in. |
| `webNavigation` | Notices a new page loading in one of its own tabs, to apply that same-tab rule and show the glow and the label again. |
| `storage` | Remembers which tabs are its own (session storage, which the browser clears when it closes), so it keeps track after its service worker restarts. |
| `alarms` | Tries to reach the desktop app again once a minute while the app isn't running. |
| Host permission `<all_urls>` | The person can ask Atelier to work on any site; the extension acts only in tabs it opened itself. |

**Remote code:** No. All code is in the package.

**Data usage** (what was ticked): **Website content**, **Personally identifiable information**, **Financial and payment
information** and **Personal communications**: it reads the pages it works in, and a page the person is signed in to can
show their name and address, orders or messages, which go on to their model. Not ticked: health, authentication (it
never reads or types passwords), location, web history and user activity (it never watches the person's own browsing).

**Certifications:** all three: not sold or transferred to third parties outside the approved use cases (the page content
goes to the desktop app, and from there to the model provider the person chose, which is the extension's purpose); not
used for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://docs.atelierhq.dev/privacy/#atelier-for-chrome

## Distribution

Public, all regions. Free.

## In the store

Item `efpchbhecdgeeadmefahpgidnfplajln` (publisher dashboard, account theoriuhd), submitted for review on 2026-11-13 as
0.1.0, non-trader, contact contact@atelierhq.dev. Its id is in `BROWSER_EXTENSION_IDS` in
`packages/protocol/src/browser.ts`, so the desktop app's native host lets the store build connect; the unpacked build
keeps its own id. Google reviews every update; keep the permissions as they are so updates stay on the quick review
(broad host access already means an in-depth review for the first one).
