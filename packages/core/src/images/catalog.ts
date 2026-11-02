/** Capabilities of models Atelier knows; a model it doesn't know gets careful defaults, so nothing depends on a release. */
import type { ImageCapabilities, ImageSizes } from '@atelier/protocol';

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

export const OPENAI_MODELS: readonly (readonly [RegExp, Partial<ImageCapabilities>])[] = [
  [
    /^gpt-image/,
    {
      family: 'gpt-image',
      sizes: { kind: 'fixed', list: [{ width: 1024, height: 1024 }, { width: 1536, height: 1024 }, { width: 1024, height: 1536 }] },
      maxCount: 4,
      edit: true,
      mask: true,
      maxReferences: 16,
      transparent: true,
      previews: true,
    },
  ],
  [/^dall-e-3/, { family: 'dall-e', sizes: { kind: 'fixed', list: [{ width: 1024, height: 1024 }, { width: 1792, height: 1024 }, { width: 1024, height: 1792 }] } }],
  [/^dall-e-2/, { family: 'dall-e', sizes: { kind: 'fixed', list: [{ width: 256, height: 256 }, { width: 512, height: 512 }, { width: 1024, height: 1024 }] }, maxCount: 4, edit: true, mask: true, maxReferences: 1 }],
];
