# Website

The public site at **atelierhq.dev**: one static page, no framework and no build step. The docs are a separate site,
`apps/docs` (below), at `docs.atelierhq.dev`.

```
apps/site/
  public/         what is deployed: index.html, styles.css, site.js, theme.js, fonts/, img/, _headers, 404.html
  shots/          how the app screenshots are made (below)
  wrangler.jsonc  Cloudflare Worker with static assets, on the custom domain only
```

## Look and copy

- Tokens, fonts and the icon are the app's own (`design/tokens/tokens.json`): Inter for the interface, Source Serif 4 for
  titles, JetBrains Mono for code, paper, ink and clay. Light and dark follow the system; the toggle remembers a choice.
- Primary buttons are ink (like the app's), not clay: clay on white is 4:1, under the 4.5:1 text needs.
- No other product's name in the copy and no claim of affiliation (the footer says it is independent).
- Be plain about the license: **source-available** (PolyForm Noncommercial), never "open source". Say what is unverified
  or unsigned where it matters (Windows builds are not code-signed; Windows and Linux have had less testing).
- No inline `style` attributes or inline scripts: `_headers` sets a strict CSP (`default-src 'self'`).

## Download page

`/download/` detects the visitor's system (and, where the browser says, the processor), leads with the right build and lets
them pick another; a link can ask for one with `/download/#windows`. The list of files comes from `public/releases.json`,
which **you regenerate after publishing a release and before deploying**:

```bash
node apps/site/scripts/releases.mjs [tag]    # reads the release with the GitHub CLI
```

The release workflow's `site` job does this and deploys the site after every stable release, once the repository has
the `CLOUDFLARE_API_TOKEN` secret (a Cloudflare API token with Workers Scripts edit and Workers Routes edit on
atelierhq.dev; `CLOUDFLARE_ACCOUNT_ID` is already set); without it the job leaves a notice and skips. It fails loudly if a
build is missing from the release. Without the JSON (or without scripting) every button opens the
newest release on GitHub. The page's install notes say macOS builds are signed and notarized and Windows builds are not; change them when that
changes. The server section is the Docker route from `docs/self-hosting.md`.

## Preview

```bash
pnpm dlx wrangler dev -c apps/site/wrangler.jsonc --local   # with the real headers, http://127.0.0.1:8787
# or just the files:
python3 -m http.server 4173 --directory apps/site/public
```

## Deploy

```bash
npx wrangler@4 deploy -c apps/site/wrangler.jsonc
```

The Worker is only reachable on `atelierhq.dev` (`workers_dev` and preview URLs are off).

## Docs site (`apps/docs`)

Astro Starlight; pages are Markdown in `apps/docs/src/content/docs/` (the sidebar order is in `astro.config.mjs`), the look is
`src/styles/theme.css` (this site's tokens and fonts), and the screenshots in `public/img` are copies of this site's.

```bash
pnpm --filter @atelier/docs dev            # live preview, http://localhost:4321
pnpm --filter @atelier/docs build          # dist/, plus dist/_headers (CSP with Starlight's inline scripts by hash)
pnpm --filter @atelier/docs run preview    # the build with the real headers (wrangler dev --local)
pnpm --filter @atelier/docs run deploy     # build and deploy the Worker "atelier-docs" on docs.atelierhq.dev
```

Like this site it is reachable only on its custom domain. The site links
to `/getting-started/` and `/self-hosting/`, and the app to `/getting-started/` and `/self-hosting/#run-it`: keep those
pages where they are.

## Screenshots

The captures come from the real app (dark theme, 1360×850 CSS pixels rendered at 3×, so each master is 4080×2550), running
on throwaway data against a scripted model, never your own profile:

```bash
node apps/site/shots/capture.mjs /tmp/shots      # chat, artifact, cowork, providers, code, permission (PNG masters)
apps/site/shots/convert.sh /tmp/shots            # WebP at 1280, 2560 and 3840 wide into public/img
```

`capture.mjs` launches the installed app (`/Applications/Atelier.app`, or `ATELIER_E2E_APP`, else
`apps/desktop/dist`), so install a fresh build first when the UI has changed. `demo-model.mjs` is the scripted Ollama
stand-in with the replies on screen (a `qwen3:30b` that answers at 58.8 tok/s).
Needs `cwebp` (`brew install webp`) and ImageMagick for the conversion.
