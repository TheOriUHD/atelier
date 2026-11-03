/** `GenerateVideo`: a thin shell around VideoService (src/images/video-service.ts), which does the work (ARCHITECTURE §23). */
import type { GenerateVideoInput } from '../images/video-service.ts';
import type { DescribeContext, Tool, ToolContext, ToolOutput } from './types.ts';

export interface GenerateVideoDeps {
  generate(input: GenerateVideoInput, ctx: ToolContext): Promise<ToolOutput>;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') {
    return [
      'Makes a short video from a description and shows it to the person.',
      '- Only when the person asks for a video or an animation.',
      '- `prompt`: describe the action, the camera and the light. Follow the note about video models.',
      '- To start from a picture, put its `img_…` id in `first_frame`.',
    ].join('\n');
  }
  return [
    'Makes a short video clip from a text description and shows it in the conversation. A clip takes minutes and costs real money, so make one only when asked.',
    '- Use it when the person asks for a video, a clip, an animation or a moving version of a picture.',
    '- Write `prompt` as a scene in motion: who or what is there, what happens, how the camera moves, the light and the mood. One continuous shot; clips are a few seconds long.',
    "- A note tells you which video models you can use, how long each clip may be and what else each takes. Leave `model` out to use the person's choice.",
    '- `seconds` is the length. Leave it out for the model’s usual length: longer clips cost more. `aspect_ratio` is like `16:9`, or `9:16` for a phone.',
    '- To start from a picture, whether you made it or the person attached it, put its `img_…` id in `first_frame`; `last_frame` ends the clip on a second picture, for models that can. Turn a picture into a clip by describing the motion only.',
    '- Sound is off unless the person asks for it: set `audio` to true then.',
    "- You can't watch the result. Don't claim to describe what it shows; say what you asked for.",
    '- The clip appears by itself: never paste its id or a link into your reply.',
    "- A provider's refusal is final: tell the person, and don't reword the prompt to get around it. Never make sexual videos of minors, whatever the model allows.",
  ].join('\n');
}

const FRAME = { type: 'string', pattern: '^img_[0-9a-f]{8}$', description: 'An image id like img_ab12cd34.' };

export function createGenerateVideoTool(deps: GenerateVideoDeps): Tool<GenerateVideoInput> {
  return {
    name: 'GenerateVideo',
    description: describe,
    compactExample: { prompt: '<the scene and its motion, in detail>', aspect_ratio: '16:9' },
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 8000, description: 'The scene, its motion and the camera.' },
        negative_prompt: { type: 'string', maxLength: 2000, description: 'What it must not show, for models that take one.' },
        aspect_ratio: { type: 'string', description: 'Like 16:9, 9:16 or 1:1.' },
        resolution: { type: 'string', description: 'Like 720p or 1080p, for models that offer a choice. Higher costs more.' },
        seconds: { type: 'number', minimum: 1, maximum: 120, description: 'How long the clip is.' },
        audio: { type: 'boolean', description: 'Sound, for models that can switch it. Off unless the person asks.' },
        fps: { type: 'integer', minimum: 1, maximum: 120, description: 'Frames per second, on models that let you choose.' },
        first_frame: { ...FRAME, description: 'An image id: the clip starts from this picture.' },
        last_frame: { ...FRAME, description: 'An image id: the clip ends on this picture, on models that can.' },
        model: { type: 'string', description: 'Which video model; leave it out for the person’s choice.' },
        seed: { type: 'integer', minimum: 0, description: 'Repeats a result, on models that can.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    compactSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 8000 },
        aspect_ratio: { type: 'string' },
        seconds: { type: 'number' },
        first_frame: { type: 'string', pattern: '^img_[0-9a-f]{8}$' },
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
