/** `GenerateImage`: a thin shell around ImageService (src/images), which does the work (ARCHITECTURE §23). */
import type { GenerateImageInput } from '../images/service.ts';
import type { DescribeContext, Tool, ToolContext, ToolOutput } from './types.ts';

export interface GenerateImageDeps {
  generate(input: GenerateImageInput, ctx: ToolContext): Promise<ToolOutput>;
}

function describe({ tier, has }: DescribeContext): string {
  if (tier === 'compact') {
    return [
      'Makes an image from a description and shows it to the person.',
      '- Only when the person asks for an image.',
      '- `prompt`: describe what it shows, in detail. Follow the prompt style in the note about image models.',
      '- To change an earlier or attached image, put its `img_…` id in `reference_images`.',
      '- A marked area comes with a mask id: pass it as `mask`, the image first in `reference_images`.',
    ].join('\n');
  }
  return [
    'Makes images from a text description and shows them in the conversation. A local server can take minutes.',
    '- Use it when the person asks for a picture, photo, illustration, logo or anything else to look at.' + (has('inline_visual') || has('artifact') ? ' Charts, diagrams and anything drawn from data or code belong in an artifact or visual instead.' : ''),
    '- Write `prompt` as a full visual description: subject, setting, style, light, framing. Keep the person’s specifics. Put text that must appear in the image in quotes.',
    "- A note tells you which image models you can use and how each wants its prompt. Leave `model` out to use the person's choice; switching models can be slow on a local server, so only switch when asked or when another model clearly fits better.",
    '- To change an image, whether you made it or the person attached it, put its `img_…` id in `reference_images` and describe the result you want.' + (has('Read') ? ' For an image file in the folder, open it with Read first: that gives you its id.' : ''),
    '- When the person marked an area of an image, their message gives that image\'s id and a mask id: pass the image first in `reference_images` and the mask as `mask`, and describe the whole picture as it should look after the change. If the model can\'t change one area, the result says which can: tell the person, then call again with that `model`.',
    '- `aspect_ratio` is like `16:9`, and people usually look best in a portrait format like `2:3`. `count` is for when the person wants options to pick from.',
    "- If you can see the result and it has a clear flaw, try once more with a better prompt. Don't keep going without asking.",
    '- The images appear by themselves: never paste their ids or links into your reply.',
    "- A provider's refusal is final: tell the person, and don't reword the prompt to get around it. Never make sexual images of minors, whatever the model allows.",
  ].join('\n');
}

const REFERENCE = { type: 'string', pattern: '^img_[0-9a-f]{8}$', description: 'An image id like img_ab12cd34.' };

export function createGenerateImageTool(deps: GenerateImageDeps): Tool<GenerateImageInput> {
  return {
    name: 'GenerateImage',
    description: describe,
    compactExample: { prompt: '<what the image shows, in detail>', aspect_ratio: '16:9' },
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 8000, description: 'What the image shows.' },
        negative_prompt: { type: 'string', maxLength: 2000, description: 'What it must not show, for models that take one.' },
        aspect_ratio: { type: 'string', description: 'Like 1:1, 16:9 or 2:3.' },
        size: { type: 'string', enum: ['small', 'medium', 'large'] },
        count: { type: 'integer', minimum: 1, maximum: 4, description: 'How many to make.' },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'] },
        reference_images: { type: 'array', items: REFERENCE, maxItems: 16, description: 'Images to change or to work from.' },
        mask: { ...REFERENCE, description: 'An image id: white where the first reference image may change.' },
        model: { type: 'string', description: 'Which image model; leave it out for the person’s choice.' },
        seed: { type: 'integer', minimum: 0, description: 'Repeats a result, on models that can.' },
        transparent: { type: 'boolean', description: 'A transparent background, on models that can.' },
        options: {
          type: 'object',
          description: 'Sampling settings for local models. Only when the person asks for them.',
          properties: {
            steps: { type: 'integer', minimum: 1, maximum: 200 },
            guidance: { type: 'number', minimum: 0, maximum: 50 },
            sampler: { type: 'string' },
            scheduler: { type: 'string' },
            loras: { type: 'array', maxItems: 8, items: { type: 'object', properties: { name: { type: 'string' }, weight: { type: 'number' } }, required: ['name'], additionalProperties: false } },
          },
          additionalProperties: false,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    compactSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 8000 },
        aspect_ratio: { type: 'string' },
        reference_images: { type: 'array', items: { type: 'string', pattern: '^img_[0-9a-f]{8}$' }, maxItems: 16 },
        model: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    readOnly: false,
    concurrent: true,
    run: (input, ctx) => deps.generate(input, ctx),
  };
}
