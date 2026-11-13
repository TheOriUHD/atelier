// Renders the Chrome Web Store's images from store/shots.html into store/images/: each section at its exact size, as a
// JPEG (the store takes JPEG or a 24-bit PNG without alpha). Run from the repo: node apps/browser-extension/store/render.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'images');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(here, 'shots.html')).href);
  // Runs in the page, where `document` exists.
  await page.evaluate('document.fonts.ready');
  for (const id of await page.$$eval('section.shot', (all) => all.map((s) => s.id))) {
    const file = join(out, `${id}.jpg`);
    await page.locator(`#${id}`).screenshot({ path: file, type: 'jpeg', quality: 92 });
    console.log(file);
  }
} finally {
  await browser.close();
}
