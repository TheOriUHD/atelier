/**
 * List prices for images, where a service doesn't say what a call cost. These go stale, so the UI shows them as
 * estimates; a price the admin set, or a cost the service reported, always wins.
 */
import type { ImagePrice } from '@atelier/protocol';

/** Checked against the vendors' price pages on 2026-11-02; keyed by the start of the model id. */
const LIST_PRICES: readonly (readonly [RegExp, ImagePrice])[] = [
  [/^dall-e-3/, { bySize: { '1024x1024': 0.04, '1024x1792': 0.08, '1792x1024': 0.08 } }],
  [/^dall-e-2/, { bySize: { '1024x1024': 0.02, '512x512': 0.018, '256x256': 0.016 } }],
];

export function listImagePrice(modelId: string): ImagePrice | null {
  return LIST_PRICES.find(([match]) => match.test(modelId))?.[1] ?? null;
}

/** What one image costs at this size under `price`, or null when the price doesn't cover it. */
export function imageCost(price: ImagePrice, width: number | undefined, height: number | undefined, sizeClass?: string): number | null {
  const size = width && height ? `${width}x${height}` : undefined;
  const bySize = (size && price.bySize?.[size]) ?? (sizeClass && price.bySize?.[sizeClass]);
  if (bySize) return bySize;
  if (price.perImage !== undefined) return price.perImage;
  if (price.perMegapixel !== undefined && width && height) return (price.perMegapixel * width * height) / 1_000_000;
  return null;
}
