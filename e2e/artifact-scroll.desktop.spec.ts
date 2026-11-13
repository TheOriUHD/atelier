import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { launchDesktop, setUpLocal } from './desktop-app.ts';
import { call, settled, tempConfigDir } from './fixtures.ts';

test('desktop Code: a long page in the Artifact pane scrolled to its end, and bringing parts of itself into view by script, leaves the app where it is', async () => {
  test.setTimeout(120_000);
  const configDir = await tempConfigDir();
  const app = await launchDesktop(configDir);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await setUpLocal(page);
    await page.getByRole('radio', { name: 'Code' }).click();
    // A long landing page, as models write them: sections that fade in as they scroll into view.
    const sections = Array.from({ length: 12 }, (_, i) => `<section style="height:420px" class="reveal"><h2>Section ${i + 1}</h2></section>`).join('');
    const landing = `<!doctype html><html><body style="margin:0;background:#111;color:#eee">${sections}<footer><p>Footer</p></footer><script>
      const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('in')));
      document.querySelectorAll('.reveal').forEach((s) => io.observe(s));
      // As landing pages do: a section brought into view by script (smooth anchor links, "back to top", a reveal).
      let jumped = false;
      addEventListener('scroll', () => {
        if (jumped || scrollY < 1500) return;
        jumped = true;
        document.querySelector('footer').scrollIntoView({ behavior: 'smooth', block: 'end' });
        document.querySelector('h2').scrollIntoView();
        document.querySelector('footer p').scrollIntoView({ block: 'start' });
      });
    </script></body></html>`;
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill([call('Write', { file_path: 'index.html', content: landing }), call('artifact', { file_path: 'index.html' })].join('\n'));
    await composer.press('Enter');
    await page.getByRole('region', { name: 'Write index.html?' }).getByRole('button', { name: 'Allow once' }).click();
    const pane = page.getByRole('region', { name: 'Artifact', exact: true });
    await expect(pane.locator('[aria-busy="false"]:has(iframe[title="Artifact preview"])')).toBeVisible();
    const frame = pane.locator('iframe[title="Artifact preview"]');
    await settled(frame);
    await expect(pane.frameLocator('iframe[title="Artifact preview"]').getByRole('heading', { name: 'Section 1', exact: true })).toBeVisible();

    // The app's layout: nothing in it but the real scrolling areas may move (the shell, the pane's frame).
    const where = () =>
      page.evaluate(() => ({
        document: document.scrollingElement!.scrollTop,
        shell: document.querySelector('#root > div')!.scrollTop,
        paneTop: Math.round(document.querySelector('[aria-label="Artifact"]')!.getBoundingClientRect().top),
      }));
    const before = await where();
    // Down to the end of the page and well past it, with the wheel over the preview.
    const box = (await frame.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(500);
    // The page did scroll itself to its end (and brought parts of itself into view on the way).
    await expect.poll(() => pane.frameLocator('iframe[title="Artifact preview"]').locator('body').evaluate(() => window.scrollY)).toBeGreaterThan(1500);
    expect(await where()).toEqual({ ...before, document: 0, shell: 0 });
  } finally {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
  }
});
