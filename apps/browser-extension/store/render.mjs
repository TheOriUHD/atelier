// Renders the Chrome Web Store's images and addons.mozilla.org's screenshots (firefox-*) from store/shots.html into store/images/: each section at its exact size, as a
// JPEG (the store takes JPEG or a 24-bit PNG without alpha). Run from the repo: node apps/browser-extension/store/render.mjs
import { chromium } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'images');
mkdirSync(out, { recursive: true });
// Playwright's own Chromium, else one installed on this computer (CHROMIUM_PATH, or Chrome, Brave or Edge on a Mac).
const installed = [process.env.CHROMIUM_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find((p) => p && existsSync(p));
const browser = await chromium.launch().catch(() => (installed ? chromium.launch({ executablePath: installed }) : Promise.reject(new Error('No Chromium: run npx playwright install chromium, or set CHROMIUM_PATH.'))));
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
  // addons.mozilla.org gets the app's own screenshot as it is.
  copyFileSync(join(out, 'screenshot-2.jpg'), join(out, 'firefox-2.jpg'));
} finally {
  await browser.close();
}
