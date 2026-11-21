# addons.mozilla.org listing: Atelier for Firefox

What goes into addons.mozilla.org (AMO) for Atelier for Firefox, and how to submit it. Build the upload and its source
package with `node apps/browser-extension/scripts/build.mjs --firefox --store`:

- `apps/browser-extension/out/atelier-for-firefox-<version>.zip`: the add-on
- `apps/browser-extension/out/atelier-for-firefox-<version>-source.zip`: the source AMO's reviewers build it from
  (`npm install && npm run build` gives the same `worker.js` byte for byte; `store/firefox-source-readme.md` is its README)

Screenshots: `store/images/firefox-1.jpg`, `firefox-2.jpg`, `firefox-3.jpg` (1280×800; `node apps/browser-extension/store/render.mjs`
draws them from `store/shots.html`). The icon is the manifest's `icon-128.png`.

## The manifest, and why

- `browser_specific_settings.gecko.id`: `atelier@atelierhq.dev`, the id the desktop app's native messaging host allows
  (`FIREFOX_EXTENSION_ID` in `packages/protocol/src/browser.ts`). It must not change, or the app stops reaching it.
- `strict_min_version` `140.0`: 139 brought tab groups to extensions, 140 the built-in data consent.
- `data_collection_permissions.required`: `websiteContent`, `personallyIdentifyingInfo`, `financialAndPaymentInfo`,
  `personalCommunications`. The add-on sends the pages it works in to the desktop app (native messaging counts as
  transmission in AMO's policy), and from there they go to the model the person chose; such pages can show a person's
  details, payments and messages. Firefox shows these in the install prompt. (The same four were ticked for Chrome.)
- Permissions: the Chrome build's without `debugger` (Firefox has none for extensions: input happens inside the page).

## Submit (the steps)

1. Sign in at https://addons.mozilla.org/developers/ (the account that should own the add-on; the developer agreement
   once, if AMO asks).
2. **Submit a New Add-on** › **On this site** (listed, reviewed by Mozilla) › Firefox (desktop) only, not Android.
3. **Upload** `atelier-for-firefox-0.3.0.zip`. AMO runs its validator; it should pass with no errors.
4. **Source code**: answer **Yes** (the worker is bundled) and upload `atelier-for-firefox-0.3.0-source.zip`.
5. Fill in the listing with the fields below (name, add-on URL, summary, description, categories, support, license,
   privacy policy), add the three screenshots, and paste the **Notes to reviewer**.
6. **Submit Version**. The status shows **Awaiting review**; AMO emails when it is approved. Listed add-ons are reviewed
   by people, which can take from a day to a couple of weeks for a new add-on with these permissions.

Keep the add-on URL `atelier-for-firefox`: the desktop app's Settings and profile menu link to
`https://addons.mozilla.org/firefox/addon/atelier-for-firefox/`.

## Listing

**Name:** Atelier for Firefox

**Add-on URL:** `atelier-for-firefox`

**Summary** (from the manifest, 250 characters at most): Lets Atelier work in web pages for you, in tabs of its own,
while you keep using your browser.

**Description:**

Atelier for Firefox connects your browser to Atelier, the AI workspace for your desktop, so the assistant can do things on
the web for you: look something up across a few sites, compare products, fill in a form you asked it to, or read a page
you're signed in to.

It works in tabs of its own, in the background, in an orange tab group named after the chat. Your own tabs stay yours: it
never reads them and never takes the front of your screen. Its tabs stay open after a reply, for you to look at and for
the next question, and close when you delete the chat. You keep working while it works, and you can watch: the tab it
works in glows orange, and a label at the bottom left says what it is doing right now ("Reading page…").

How it works
• The assistant opens a page in its own tab, reads its text and its links, buttons and fields, and clicks, types, chooses
  from lists and scrolls by name.
• Everything it reads goes only to the Atelier desktop app on the same computer, through Firefox's native messaging. The
  add-on makes no network requests of its own, has no analytics and loads no code from anywhere. Its source is public.
• It never types passwords or completes a purchase, and it asks in the chat before it accepts terms or sends anything.
  Permission rules you set in Atelier for the browser apply.
• Clicks and typing happen inside the page. Almost every site takes them; a few that need real input (drag and drop, file
  pickers, some editors and anti-bot checks) may not, and the assistant tells you then.

Requires the Atelier desktop app 0.10.7 or later (macOS, Windows or Linux) from https://atelierhq.dev.

**Categories:** Other; Tabs

**Homepage:** https://atelierhq.dev

**Support email:** contact@atelierhq.dev

**Support site:** https://docs.atelierhq.dev/computer-use/#atelier-for-firefox

**License:** Custom: PolyForm Noncommercial License 1.0.0, https://polyformproject.org/licenses/noncommercial/1.0.0/
(free for noncommercial use; the same as the Atelier app, https://docs.atelierhq.dev/license/)

**Privacy policy** (AMO takes the text; the same is at https://docs.atelierhq.dev/privacy/#atelier-for-firefox):

Atelier for Firefox lets the Atelier desktop app work in web pages for you. It works only in tabs it opened itself (an
orange tab group named after the chat), never in your own tabs.

What it reads: the text, links, buttons and fields of a page in those tabs, and a picture of it, when the assistant asks.
It doesn't read your other tabs, your history or your bookmarks.

Where that goes: only to the Atelier desktop app on the same computer, through Firefox's native messaging (a local program
the app registers; no network port). The app adds it to your conversation, so it reaches the AI model provider you chose
in Atelier, like any other tool result. That is why Firefox asks you to allow website content, and the personal details,
payment information and messages such pages can show, when you add it: the add-on can't work without it.

What it sends itself: nothing else. The add-on makes no network requests of its own, carries no analytics and loads no
code from anywhere.

What it stores: the numbers of its own tabs and its chats' tab groups, in the browser's session storage, which Firefox
clears when it closes.

Your sign-ins: pages in its tabs load with your browser's cookies, so the assistant can see what you see there when you
are signed in. It never types passwords or completes a purchase, and it asks before it accepts terms or sends anything.

Contact: contact@atelierhq.dev

**Screenshots and captions:**

1. `firefox-1.jpg`: Atelier works in web pages for you, in tabs of its own: the tab it works in glows and says what it is
   doing.
2. `firefox-2.jpg`: What you see in Atelier meanwhile: the steps, the page it is on, and the answer.
3. `firefox-3.jpg`: Your tabs stay yours: only its own tabs, in a group named after the chat.

**Version notes (0.3.0):** The first version for Firefox.

## Notes to reviewer

Atelier for Firefox is the browser side of the Atelier desktop app (https://atelierhq.dev, source:
https://github.com/TheOriUHD/atelier, folder apps/browser-extension). It does nothing on its own: it connects through
native messaging to the host `dev.atelier.browser`, which the Atelier desktop app (0.10.7 or later) registers for
Firefox, and runs the calls the app sends, only in tabs it opened itself. Without the app it retries the connection once a
minute and does nothing else.

To try it: install Atelier from https://atelierhq.dev/download/ (0.10.7 or later; until 0.10.7 is out, set Settings › System ›
Update channel to Beta), turn on Settings › Computer use › Enable computer use, add a model provider, then ask in a chat "Open example.com and
tell me what the page says". The add-on opens a background tab in an orange group named after the chat, reads the page,
and the answer comes back in the app.

Permissions:
- nativeMessaging: its only connection, to the Atelier desktop app on the same computer
- tabs, tabGroups: opens its own background tabs, groups them per chat, reads their address and title, closes them
- scripting: reads a page's text and elements in its own tabs, does clicks and typing there, shows the orange glow and
  the label with its current step, and keeps links that would open a new tab in the same tab
- webNavigation: notices a new page loading in one of its own tabs, to apply that same-tab rule and show the glow again
- storage: remembers which tabs are its own (session storage)
- alarms: tries to reach the desktop app again once a minute while it isn't running
- host access to all sites: the person can ask Atelier to work on any site; the add-on acts only in tabs it opened

Data: page content leaves the browser only to the desktop app over native messaging (declared in
data_collection_permissions); the add-on has no network requests, analytics or remote code of its own.

Source: worker.js is the TypeScript in the attached source package bundled by esbuild 0.28.2, not minified. Build with
`npm install && npm run build` (Node 20 or newer); `apps/browser-extension/out/firefox/worker.js` is then identical to the
one in the upload. The README in the package lists what each file does.
