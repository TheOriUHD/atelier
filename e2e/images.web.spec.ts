import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

/** A solid PNG of `width`×`height`, so the lightbox has an aspect ratio to keep. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5a)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

test('an attached image opens bigger in the lightbox, fitted to the window, and Escape closes it', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png(1600, 400) });
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('Look at this');
  await box.press('Enter');
  await expect(page.getByText(/You said: .*Look at this/).first()).toBeVisible();

  const attachment = page.getByRole('button', { name: 'Attachment' });
  await expect(attachment).toHaveCSS('cursor', 'zoom-in');
  await attachment.click();
  const lightbox = page.getByRole('dialog', { name: 'Image' });
  const image = lightbox.locator('img');
  await expect(image).toBeVisible();
  const viewport = page.viewportSize()!;
  const shown = (await image.boundingBox())!;
  expect(shown.width).toBeLessThanOrEqual(viewport.width * 0.9 + 1);
  expect(shown.width / shown.height).toBeCloseTo(4, 1);
  await expect(lightbox.getByRole('button', { name: 'Next image' })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});
