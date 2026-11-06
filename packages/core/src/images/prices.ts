/**
 * List prices for images, where a service doesn't say what a call cost. These go stale, so the UI shows them as
 * estimates; a price the admin set, or a cost the service reported, always wins.
 *
 * Only prices read on the vendors' own pages. Left out because the page shows none for them: Black Forest Labs (its
 * submit answer gives the cost), Ideogram, fal, Replicate, Hugging Face, Bedrock's Stability models. OpenRouter and xAI
 * report the cost of each call.
 */
import type { ImagePrice } from '@atelier/protocol';

/** Checked against the vendors' price pages on 2026-11-02; keyed by the start of the model id. */
const LIST_PRICES: readonly (readonly [RegExp, ImagePrice])[] = [
  // OpenAI bills tokens, and every call says how many. `bySize` is the medium-quality figure, for a server that doesn't.
  [/^gpt-image-2\.5/, { input: 5, output: 30 }],
  [/^gpt-image-2/, { input: 5, output: 30, bySize: { '1024x1024': 0.053, '1024x1536': 0.041, '1536x1024': 0.041 } }],
  [/^gpt-image-1\.5|^chatgpt-image-latest/, { input: 5, output: 32, bySize: { '1024x1024': 0.034, '1024x1536': 0.05, '1536x1024': 0.05 } }],
  [/^gpt-image-1-mini/, { input: 2, output: 8, bySize: { '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 } }],
  [/^gemini-nano-banana-2\.1/, { bySize: { '1K': 0.0336, '2K': 0.0504 } }],
  [/^gemini-3\.1-flash-lite-image/, { bySize: { '1K': 0.0336 } }],
  [/^gemini-3\.1-flash-image/, { bySize: { '512': 0.045, '1K': 0.067, '2K': 0.101 } }],
  [/^gemini-3-pro-image/, { bySize: { '1K': 0.134, '2K': 0.134 } }],
  [/^gemini-2\.5-flash-image/, { perImage: 0.039 }],
  [/^grok-imagine-image-quality/, { perImage: 0.05 }],
  [/^grok-imagine-image-2/, { perImage: 0.04 }],
  [/^grok-imagine-image/, { perImage: 0.02 }],
  [/^recraftv4_1_flash/, { perImage: 0.007 }],
  [/^recraftv4_1(?:_utility)?$/, { perImage: 0.035 }],
  [/^recraftv4$|^recraftv3$/, { perImage: 0.04 }],
  [/^recraftv2$/, { perImage: 0.022 }],
  [/^stable-image-ultra/, { perImage: 0.08 }],
  [/^stable-image-core/, { perImage: 0.03 }],
  [/^sd3\.5-large-turbo/, { perImage: 0.04 }],
  [/^sd3\.5-large/, { perImage: 0.065 }],
  [/^sd3\.5-medium/, { perImage: 0.035 }],
  // Together's per-image figures are "estimates, not rates" by its own account; these are its per-megapixel ones.
  [/^black-forest-labs\/FLUX\.1(?:\.1-pro|-kontext-pro)/, { perMegapixel: 0.04 }],
  [/^black-forest-labs\/FLUX\.1-kontext-max/, { perMegapixel: 0.08 }],
];

/**
 * List prices for video, per second, read on the vendors' own pages on 2026-11-03 (xAI: docs.x.ai/developers/pricing;
 * fal and Replicate: each model's page; Google: the pricing page, which says "approximately" for 720p). Services that
 * report the cost of a call (OpenRouter, xAI) never use these. A price that depends on something the call doesn't
 * give, such as a promotion, is left out.
 */
const VIDEO_PRICES: readonly (readonly [RegExp, ImagePrice])[] = [
  [/^grok-imagine-video-1\.5-lite/, { perSecond: 0.02 }],
  [/^grok-imagine-video-1\.5/, { perSecond: 0.08 }],
  [/^grok-imagine-video/, { perSecond: 0.05 }],
  [/^(?:kling\/v4\/|kwaivgi\/kling-v4\.0)/, { bySecond: { '720p': 0.157, '1080p': 0.235 } }],
  [/^alibaba\/wan-3(?:\.0)?(?:\/|$)/, { bySecond: { '480p': 0.05, '720p': 0.1, '1080p': 0.2 } }],
  [/^lightricks\/ltx-2\.5\/.*\/fast$/, { bySecond: { '720p': 0.09, '1080p': 0.13, '1440p': 0.19, '2160p': 0.3 } }],
  [/^google\/gemini-omni-flash\/v1\.1\//, { bySecond: { '360p': 0.03, '720p': 0.1, '1080p': 0.15, '4k': 0.3 } }],
  [/^gemini-omni/, { bySecond: { '720p': 0.1 } }],
];

/**
 * List prices for sound, read on the vendors' own pages on 2026-11-06. Speech is by the character where the vendor counts
 * that, and by the second of sound made otherwise (a token price turned into seconds at the vendor's own rate of tokens
 * per second). Services that report what a call cost never use these, nor does a subscription that counts credits.
 */
const AUDIO_PRICES: readonly (readonly [RegExp, ImagePrice])[] = [
  [/^tts-1-hd/, { perMillionChars: 30 }],
  [/^tts-1/, { perMillionChars: 15 }],
  [/^gpt-4o-mini-tts/, { perSecond: 0.00025 }],
];

export function listAudioPrice(modelId: string): ImagePrice | null {
  return AUDIO_PRICES.find(([match]) => match.test(modelId))?.[1] ?? null;
}

/** What a sound costs under `price`: by the characters read out for speech, else by its seconds; null when the price covers neither. */
export function audioCost(price: ImagePrice, facts: { seconds?: number | undefined; chars?: number | undefined }): number | null {
  if (price.perMillionChars !== undefined && facts.chars !== undefined) return Math.round((price.perMillionChars * facts.chars) / 1e6 * 1e6) / 1e6;
  if (price.perSecond !== undefined && facts.seconds !== undefined) return Math.round(price.perSecond * facts.seconds * 1e6) / 1e6;
  return null;
}

export function listVideoPrice(modelId: string): ImagePrice | null {
  return VIDEO_PRICES.find(([match]) => match.test(modelId))?.[1] ?? null;
}

/** What a clip of `seconds` costs under `price`, or null when the price doesn't cover this resolution. */
export function videoCost(price: ImagePrice, seconds: number, resolution?: string): number | null {
  const named = resolution ? Object.entries(price.bySecond ?? {}).find(([name]) => name.toLowerCase() === resolution.toLowerCase())?.[1] : undefined;
  const perSecond = named ?? price.perSecond;
  return perSecond === undefined ? null : Math.round(perSecond * seconds * 1e6) / 1e6;
}

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
