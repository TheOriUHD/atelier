/** An image the person marked, in their message: the picture with the area they brushed tinted over it. */
import { useEffect, useState } from 'react';
import { blobUrl } from '../../lib/platform.ts';
import { tintFromMask } from './area-mask.ts';

/** The longest side of the tint: it is only a thumbnail's overlay. */
const TINT_SIDE = 320;

/** The mask at blob address `sha` as a data URL of its tint, or null where it can't be drawn. */
async function tintOf(sha: string): Promise<string | null> {
  const response = await fetch(blobUrl(sha));
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, TINT_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  tintFromMask(pixels.data);
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

export function AreaPreview({ image, mask }: { image: { blob: string }; mask: { blob: string } }) {
  const [tint, setTint] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    tintOf(mask.blob).then(
      (url) => current && setTint(url),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [mask.blob]);
  return (
    <figure className="relative max-w-60 overflow-hidden rounded-2xl inset-ring inset-ring-line">
      <img src={blobUrl(image.blob)} alt="The image, with the area to change marked" loading="lazy" className="block max-h-40 w-full object-cover" />
      {tint && <img src={tint} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full object-cover" />}
    </figure>
  );
}
