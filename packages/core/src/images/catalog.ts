/**
 * Capabilities of models Atelier knows; a model it doesn't know gets careful defaults, so nothing depends on a release.
 * Checked against each vendor's documentation on 2026-11-02 (the dialect files name the pages).
 */
import type { ImageCapabilities, ImageSize, ImageSizes } from '@atelier/protocol';

export const SQUARE: ImageSizes = { kind: 'free', min: 256, max: 2048, multiple: 8, base: 1024 };

/** What an unknown hosted model is safely assumed to do. */
export const HOSTED_DEFAULTS: ImageCapabilities = {
  family: 'hosted',
  promptStyle: 'natural',
  negativePrompt: false,
  sizes: { kind: 'fixed', list: [{ width: 1024, height: 1024 }] },
  maxCount: 1,
  edit: false,
  mask: false,
  maxReferences: 0,
  transparent: false,
  seed: false,
  previews: false,
  tunable: false,
};

export type ModelTable = readonly (readonly [RegExp, Partial<ImageCapabilities>])[];

/** The first row that matches, over `base`. */
export const lookUp = (table: ModelTable, modelId: string, base: ImageCapabilities = HOSTED_DEFAULTS): ImageCapabilities => ({ ...base, ...table.find(([match]) => match.test(modelId))?.[1] });

const aspect = (ratios: string[], classes: string[] = []): ImageSizes => ({ kind: 'aspect', ratios, classes });

/** `[width, height]` both ways round, for a list of sizes. */
const bothWays = (...sizes: readonly (readonly [number, number])[]): ImageSize[] => sizes.flatMap(([width, height]) => (width === height ? [{ width, height }] : [{ width, height }, { width: height, height: width }]));

/**
 * GPT Image 2 and 2.5 take any size with sides in multiples of 16, ratios up to 3:1 and 655,360 to 8,294,400 pixels.
 * `free` sizes can't say the pixel limits, and its `small` would fall under the minimum, so these are spelled out:
 * three sizes per shape, none above 2560×1440, where OpenAI calls sizes experimental.
 */
const GPT_IMAGE_2_SIZES = bothWays([832, 832], [1024, 1024], [1920, 1920], [1008, 672], [1536, 1024], [2304, 1536], [960, 720], [1280, 960], [2048, 1536], [1136, 640], [1536, 864], [2560, 1440], [1344, 576], [1680, 720], [2240, 960], [1440, 480], [1920, 640], [2400, 800]);

const GPT_IMAGE = { family: 'gpt-image', maxCount: 10, edit: true, mask: true, maxReferences: 16, transparent: true, previews: true } as const;

/** The earlier GPT Image models: the one row that also fits an Azure deployment whose name says nothing. */
export const GPT_IMAGE_1: Partial<ImageCapabilities> = { ...GPT_IMAGE, sizes: { kind: 'fixed', list: bothWays([1024, 1024], [1536, 1024]) } };

// DALL·E 2 and 3 were retired on 2026-05-12 and gpt-image-1 on 2026-10-23; 1.5, 1-mini and chatgpt-image-latest go on 2026-12-01.
export const OPENAI_MODELS: ModelTable = [
  [/^gpt-image-2/, { ...GPT_IMAGE, sizes: { kind: 'fixed', list: GPT_IMAGE_2_SIZES } }],
  [/^(?:gpt-image|chatgpt-image)/, GPT_IMAGE_1],
];

/** A preset's own models, and the capabilities of an unknown one, as the last row. */
export const XAI_MODELS: ModelTable = [
  [
    /./,
    {
      family: 'grok-imagine',
      sizes: aspect(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2'], ['1k', '2k']),
      maxCount: 10,
      edit: true,
      maxReferences: 5,
    },
  ],
];
export const XAI_MODEL_IDS = ['grok-imagine-image-2.0', 'grok-imagine-image', 'grok-imagine-image-quality'];

/** Together documents no limits, so these are the narrowest that hold across FLUX: multiples of 32, up to 1440. */
const TOGETHER_SIZES: ImageSizes = { kind: 'free', min: 256, max: 1440, multiple: 32, base: 1024 };
const TOGETHER = { family: 'together', negativePrompt: true, sizes: TOGETHER_SIZES, maxCount: 4, seed: true, tunable: true } as const;
export const TOGETHER_MODELS: ModelTable = [
  [/FLUX\.1-schnell/i, { ...TOGETHER, defaults: { steps: 4 } }],
  [/kontext/i, { ...TOGETHER, edit: true, maxReferences: 1 }],
  [/FLUX\.2|gemini|flash-image/i, { ...TOGETHER, edit: true, maxReferences: 4 }],
  [/./, TOGETHER],
];

const RECRAFT_RATIOS = ['1:1', '2:1', '1:2', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '6:10', '14:10', '10:14', '16:9', '9:16'];
const RECRAFT = { family: 'recraft', sizes: aspect(RECRAFT_RATIOS), maxCount: 6, seed: true } as const;
export const RECRAFT_MODELS: ModelTable = [
  [/^recraftv[23]/, { ...RECRAFT, negativePrompt: true }],
  [/./, RECRAFT],
];
/** Vector models answer in SVG, which Atelier won't show. */
export const RECRAFT_MODEL_IDS = ['recraftv4_1', 'recraftv4_1_flash', 'recraftv4_1_utility', 'recraftv4_1_pro', 'recraftv4', 'recraftv4_pro', 'recraftv3', 'recraftv2'];

/**
 * Size names go small to large, and `params.ts` gives `medium` the middle one. Google's default is 1K and 2K costs half
 * as much again, so 4K is left out: listing it would make every unasked-for image 2K.
 */
const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const GEMINI_WIDE_RATIOS = [...GEMINI_RATIOS, '1:4', '4:1', '1:8', '8:1'];
const GEMINI = { family: 'gemini', edit: true } as const;
export const GEMINI_MODELS: ModelTable = [
  [/^gemini-nano-banana/, { ...GEMINI, sizes: aspect(GEMINI_WIDE_RATIOS, ['1K', '2K']), maxReferences: 14 }],
  [/^gemini-3\.1-flash-lite-image/, { ...GEMINI, sizes: aspect(GEMINI_WIDE_RATIOS, ['1K']), maxReferences: 14 }],
  [/^gemini-3\.1-flash-image/, { ...GEMINI, sizes: aspect(GEMINI_WIDE_RATIOS, ['512', '1K', '2K']), maxReferences: 14 }],
  [/^gemini-3-pro-image/, { ...GEMINI, sizes: aspect(GEMINI_RATIOS, ['1K', '2K']), maxReferences: 14 }],
  // One size per ratio, and it works best with three inputs.
  [/^gemini-2\.5-flash-image/, { ...GEMINI, sizes: aspect(GEMINI_RATIOS), maxReferences: 3 }],
  [/./, { ...GEMINI, sizes: aspect(GEMINI_RATIOS), maxReferences: 3 }],
];

const FLUX_2_SIZES: ImageSizes = { kind: 'free', min: 64, max: 2048, multiple: 16, base: 1024 };
const FLUX_2 = { family: 'flux2', sizes: FLUX_2_SIZES, edit: true, maxReferences: 8, seed: true } as const;
export const BFL_MODELS: ModelTable = [
  [/^flux-3-image$/, { family: 'flux3', sizes: aspect(['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16', '1:2', '9:21'], ['1k', '2k']), edit: true, maxReferences: 10 }],
  [/^flux-2-klein/, { ...FLUX_2, maxReferences: 4 }],
  [/^flux-2-flex/, { ...FLUX_2, tunable: true, defaults: { steps: 50, guidance: 5 } }],
  [/^flux-2/, FLUX_2],
];
export const BFL_MODEL_IDS = ['flux-3-image', 'flux-2-pro-preview', 'flux-2-max', 'flux-2-pro', 'flux-2-flex', 'flux-2-klein-9b-preview', 'flux-2-klein-9b', 'flux-2-klein-4b'];

const STABILITY_RATIOS = ['21:9', '16:9', '3:2', '5:4', '1:1', '4:5', '2:3', '9:16', '9:21'];
const STABILITY = { family: 'stability', negativePrompt: true, sizes: aspect(STABILITY_RATIOS), seed: true } as const;
export const STABILITY_MODELS: ModelTable = [
  // Core takes no input image.
  [/core/, STABILITY],
  [/./, { ...STABILITY, edit: true, mask: true, maxReferences: 1 }],
];
export const STABILITY_MODEL_IDS = ['stable-image-ultra', 'stable-image-core', 'sd3.5-large', 'sd3.5-large-turbo', 'sd3.5-medium'];

/** On Bedrock the same models answer through `InvokeModel`; Nova Canvas and Titan Image have reached end of life there. */
export const BEDROCK_MODELS: ModelTable = [
  [/sd3-5-large/, { ...STABILITY, edit: true, mask: true, maxReferences: 1 }],
  [/./, STABILITY],
];
export const BEDROCK_MODEL_IDS = ['stability.stable-image-ultra-v1:1', 'stability.stable-image-core-v1:1', 'stability.sd3-5-large-v1:0'];

const IDEOGRAM_SIZES: ImageSizes = {
  kind: 'fixed',
  list: bothWays([1024, 1024], [2048, 2048], [720, 1280], [1440, 2560], [800, 1280], [1600, 2560], [832, 1248], [1664, 2496], [864, 1152], [1728, 2304], [896, 1120], [1792, 2240], [720, 1440], [1440, 2880], [512, 1536], [1024, 3072], [1296, 3168]),
};
const IDEOGRAM = { family: 'ideogram', seed: true, maxCount: 4 } as const;
export const IDEOGRAM_MODELS: ModelTable = [
  [/^ideogram-4-5/, { ...IDEOGRAM, sizes: IDEOGRAM_SIZES, edit: true, mask: true, maxReferences: 5, transparent: true }],
  [/^ideogram-4/, { ...IDEOGRAM, sizes: IDEOGRAM_SIZES, edit: true, maxReferences: 1 }],
  [/^ideogram-3/, { ...IDEOGRAM, negativePrompt: true, sizes: aspect(['1x1', '16x9', '9x16', '16x10', '10x16', '3x2', '2x3', '4x3', '3x4', '5x4', '4x5', '2x1', '1x2', '3x1', '1x3']), edit: true, mask: true, maxReferences: 1 }],
];
export const IDEOGRAM_MODEL_IDS = ['ideogram-4-5', 'ideogram-4', 'ideogram-3'];

const COMMON_RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '21:9'];
/** For models a service hosts by the thousand and doesn't describe, where a ratio is the input most of them share. */
export const ASPECT_DEFAULTS: ImageCapabilities = { ...HOSTED_DEFAULTS, sizes: aspect(COMMON_RATIOS) };

const FAL_SIZES: ImageSizes = { kind: 'free', min: 256, max: 2048, multiple: 16, base: 1024 };
export const FAL_MODELS: ModelTable = [
  [/\/flux\/schnell/, { family: 'flux', sizes: FAL_SIZES, maxCount: 4, seed: true }],
  [/\/edit$/, { family: 'fal', sizes: FAL_SIZES, maxCount: 4, edit: true, maxReferences: 4, seed: true }],
  [/./, { family: 'fal', sizes: FAL_SIZES, seed: true }],
];

export const REPLICATE_MODELS: ModelTable = [
  [/flux-schnell|flux-dev/, { family: 'flux', maxCount: 4, seed: true }],
  [/flux/, { family: 'flux', seed: true }],
];

export const HUGGINGFACE_CAPABILITIES: ImageCapabilities = { ...HOSTED_DEFAULTS, family: 'huggingface', negativePrompt: true, sizes: { kind: 'free', min: 256, max: 1440, multiple: 16, base: 1024 }, seed: true, tunable: true };
