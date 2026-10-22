import { expect, test } from '@playwright/test';

const html = `<style>.controls{display:flex;gap:16px;align-items:center}canvas{display:block;width:100%;height:180px}</style><div class="controls"><label>Frequency <input id="frequency" type="range" min="1" max="10" value="3"></label><output id="value">3</output><button id="pause">Pause</button></div><canvas id="wave" width="640" height="180"></canvas><script>const slider=document.getElementById('frequency');slider.oninput=()=>document.getElementById('value').textContent=slider.value;document.getElementById('pause').onclick=e=>e.target.textContent=e.target.textContent==='Pause'?'Play':'Pause';const ctx=document.getElementById('wave').getContext('2d');ctx.strokeStyle='#827dbd';ctx.beginPath();for(let x=0;x<640;x++)ctx.lineTo(x,90+60*Math.sin(x/35));ctx.stroke();</script>`;

test('inline visuals blend into the transcript, interact, export and survive reload', async ({ page }) => {
  await page.goto('/');
  const box = page.getByRole('textbox', { name: /message|reply/i }).first();
  await box.fill(`call inline_visual ${JSON.stringify({ title: 'Wave playground', description: 'Explore a wave with a frequency slider.', html })}`);
  await box.press('Enter');
  const visual = page.getByRole('region', { name: 'Wave playground', exact: true });
  const frame = visual.frameLocator('iframe');
  await expect(frame.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  const slider = frame.getByRole('slider');
  await slider.fill('7');
  await expect(frame.locator('output')).toHaveText('7');
  expect(await visual.locator('iframe').evaluate((el) => getComputedStyle(el).borderWidth)).toBe('0px');
  await visual.screenshot({ path: 'test-results/inline-wave.png' });
  await visual.hover();
  const download = page.waitForEvent('download');
  await visual.getByRole('button', { name: 'Download as HTML' }).click();
  expect((await download).suggestedFilename()).toBe('Wave-playground.html');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Wave playground', exact: true }).frameLocator('iframe').getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
});

test('the inline runtime previews inert HTML, preserves state on theme updates and blocks network and parent access', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.id = 'probe';
    iframe.sandbox.add('allow-scripts');
    iframe.src = '/inline-visual.html';
    window.addEventListener('message', (event) => {
      if (event.source === iframe.contentWindow && event.data?.type === 'inline:ready') iframe.dataset.ready = 'yes';
    });
    document.body.append(iframe);
  });
  await expect(page.locator('#probe')).toHaveAttribute('data-ready', 'yes');
  const send = async (content: string, final: boolean, theme = 'light') => page.locator('#probe').evaluate((el, message) => (el as HTMLIFrameElement).contentWindow!.postMessage(message, '*'), { type: 'inline:render', html: content, final, theme, reducedMotion: true });
  const content = `<button id="test" onclick="this.textContent='bad'">Ready</button><script>document.getElementById('test').onclick=e=>e.target.textContent='Clicked';</script>`;
  await send(content, false);
  const frame = page.frameLocator('#probe');
  await expect(frame.getByRole('button', { name: 'Ready' })).toBeVisible();
  await expect(frame.locator('#inline-root')).toHaveAttribute('inert', '');
  await expect(frame.getByRole('button', { name: 'Ready' })).toBeVisible();
  await send(content, true);
  await frame.getByRole('button', { name: 'Ready' }).click();
  await expect(frame.getByRole('button', { name: 'Clicked' })).toBeVisible();
  await send(content, true, 'dark');
  await expect(frame.getByRole('button', { name: 'Clicked' })).toBeVisible();
  const isolated = await frame.locator('body').evaluate(async () => {
    let parentBlocked = false, storageBlocked = false, networkBlocked = false;
    try { void window.parent.document; } catch { parentBlocked = true; }
    try { localStorage.setItem('probe', 'x'); } catch { storageBlocked = true; }
    try { await fetch('/api/health'); } catch { networkBlocked = true; }
    return { parentBlocked, storageBlocked, networkBlocked };
  });
  expect(isolated).toEqual({ parentBlocked: true, storageBlocked: true, networkBlocked: true });
});
