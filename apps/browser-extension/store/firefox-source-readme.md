# Atelier for Firefox: source code

This is the source of the add-on, as it is in the Atelier repository (https://github.com/TheOriUHD/atelier, folder
`apps/browser-extension`, and the one protocol module it uses, `packages/protocol/src/browser.ts`). The add-on's
`worker.js` is these TypeScript files bundled by esbuild, unminified; `manifest.json` and `icon-128.png` are copied as
they are.

## Build

Requirements: Node.js 20 or newer and npm (any operating system). Nothing else is downloaded.

```
npm install
npm run build
```

`npm install` installs the pinned esbuild from `package.json` (the only dependency). `npm run build` runs
`node apps/browser-extension/scripts/build.mjs --firefox --store` and writes:

- `apps/browser-extension/out/firefox/`: the add-on's files (`manifest.json`, `worker.js`, `icon-128.png`)
- `apps/browser-extension/out/atelier-for-firefox-<version>.zip`: the same files as the uploaded package

`out/firefox/worker.js` is byte for byte the `worker.js` in the uploaded package.

## What is in it

- `apps/browser-extension/src/worker.ts`: the background script: the native messaging connection to the Atelier
  desktop app, the add-on's own tabs and tab groups, and the calls it runs in them
- `apps/browser-extension/src/page.ts`: functions run in a page with `scripting.executeScript` to read its text and its
  links, buttons and fields
- `apps/browser-extension/src/page-input.ts`: clicks, typing, keys and scrolling inside a page (Firefox has no debugger
  for extensions)
- `apps/browser-extension/src/overlay.ts`: the orange glow and the one-line label shown in the tab the add-on works in
- `apps/browser-extension/src/keys.ts`: key names to key events
- `packages/protocol/src/browser.ts`: the messages between the desktop app and the add-on
- `apps/browser-extension/scripts/build.mjs`: the build

The same code is built for Chrome as Atelier for Chrome; the `--firefox` flag gives it Firefox's manifest (no `key`, no
`debugger` permission, `background.scripts`, `browser_specific_settings`).
