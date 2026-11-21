# Media kit

The media kit at **media.atelierhq.dev**: logos, app icons, banners, wallpapers, screenshots, the mascot, colours, fonts
and words, as downloads and as a page that shows them. Linked from the footer of the website, the docs and the update
feed's page, next to the Impressum.

```
apps/media/
  src/             masters kept in git: wordmark.json (the word as outlines), words.json (the copy), screens/ios (App Store screenshots)
  scripts/         build.mjs makes everything; brand.mjs, banners.mjs and page.mjs are the SVG, banner and page templates
  public/          what is deployed. Hand-written: media.css, media.js, _headers, robots.txt. Everything else is made by the build
  wrangler.jsonc   a Cloudflare Worker with static assets, on the custom domain only (the domain creates its own DNS record)
```

## Build

```bash
node apps/media/scripts/build.mjs
```

It needs Google Chrome (rendered through Playwright's `chrome` channel, so no browser download), ImageMagick (`magick`),
`iconutil` (macOS) and `zip`. About 20 seconds. It starts by deleting what it made last time.

What it makes, from the masters:

- **Logos** (`kit/logos`): horizontal and stacked lockups, the wordmark, the tile and the palette alone, each in colour,
  black, white and on dark where it matters, as SVG and as transparent PNG at 512, 1024 and 2048 px. The word is Source
  Serif 4 semibold drawn as outlines, so no file needs the font. The tile and palette are the app icon's own
  (`design/icon-full.svg`).
- **App icons** (`kit/app-icons`): the icon with and without the macOS margin, iPhone and iPad (light, dark, tinted),
  Android adaptive layers, a round icon, and the `.ico`, `.icns` and favicons.
- **Banners** (`kit/banners/{light,dark,clay}`): eleven sizes (GitHub social preview, link preview, X, LinkedIn, YouTube,
  Product Hunt, 16:9, ultrawide, square, story), with the website's headline. The text block shrinks to fit each shape.
  **Wallpapers** for desktop and phone.
- **Screenshots**: the website's desktop captures (`apps/site/public/img`) and the App Store's iPhone and iPad ones
  (`src/screens/ios`).
- **Pip** (`kit/pip`): the terminal app's mascot, from `apps/cli/src/art/mascot.ts`, as pixel-exact SVG and PNGs at whole
  multiples of its 12 px grid.
- **Brand** (`kit/brand`): colours as JSON and CSS, the three fonts with their licence, the words.
- **Downloads** (`downloads/*.zip`): the brand kit, and each part. A file may not pass 25 MB on the host, which is why
  banners and screenshots are not in the brand kit.

The page (`index.html`) is written from the same data, so it cannot list a file that was not made. Fonts, `styles.css` and
`theme.js` are copied from `apps/site/public`, so the page looks like the website.

## Changing things

- The words (what Atelier is at four lengths, the facts, the usage terms): `src/words.json`.
- A colour: `COLORS` in `scripts/brand.mjs` and the same hex in `public/media.css` and the website's `styles.css`.
- A banner's text or look: `scripts/banners.mjs`.
- The wordmark (a different weight or size): `scripts/outline-wordmark.py` (its header says how to run it), then commit
  `src/wordmark.json`.
- New App Store screenshots: replace the PNGs in `src/screens/ios/`.

## Deploy

```bash
npx wrangler@4 deploy -c apps/media/wrangler.jsonc
```

The Worker answers only on `media.atelierhq.dev` (`workers_dev` and preview URLs are off). The first deploy creates the
domain's DNS record by itself. The same strict `_headers` as the website apply (no inline scripts or styles).
Releases don't deploy it: run the two commands above after changing the kit.
