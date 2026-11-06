/** `GenerateAudio`: a thin shell around AudioService (src/images/audio-service.ts), which does the work (ARCHITECTURE §23). */
import type { GenerateAudioInput } from '../images/audio-service.ts';
import type { DescribeContext, Tool, ToolContext, ToolOutput } from './types.ts';

export interface GenerateAudioDeps {
  generate(input: GenerateAudioInput, ctx: ToolContext): Promise<ToolOutput>;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') {
    return [
      'Makes speech, music or a sound effect and gives it to the person to play.',
      '- Only when the person asks to hear something: read a text aloud, a song, a jingle, a sound.',
      '- `kind` "speech": put exactly the words in `text`, and pick a `voice` from the note about sound models.',
      '- `kind` "music" or "sound": describe it in `prompt`.',
    ].join('\n');
  }
  return [
    'Makes a sound and shows it in the conversation for the person to play: speech read in a voice, a piece of music, or a sound effect. Make one only when the person asks to hear something.',
    '- `kind` "speech": `text` is exactly what is said, word for word: write numbers, abbreviations and names the way they should be spoken. Pick a `voice` from the note about sound models, by its id, to suit what is said and who says it. `direction` says how to say it (calm, excited, whispered, a slight Scottish accent), on models that take directions.',
    "- A conversation between people: give `speakers`, each a name and a voice, and write `text` as lines that start with the speaker's name and a colon, on models that take several speakers. Otherwise make each speaker's lines as a call of their own.",
    '- `kind` "music": `prompt` is the style, mood, tempo, instruments and structure. Put words to sing in `lyrics`, on models that sing, or set `instrumental` for none. `seconds` is the length.',
    '- `kind` "sound": `prompt` describes the sound effect or ambience (a door creaking open in an empty hall), and `seconds` its length.',
    "- A note tells you which sound models you can use and what each takes. Leave `model` out to use the person's choice for that kind.",
    "- You can't hear the result. Don't claim to describe how it sounds; say what you asked for.",
    '- It appears by itself: never paste its id or a link into your reply.',
    "- Never imitate a real person's voice or make speech that pretends to come from someone real. Don't name real artists or ask for an existing song: describe the style instead, and write your own lyrics.",
    "- A provider's refusal is final: tell the person, and don't reword the request to get around it.",
  ].join('\n');
}

const SPEAKER = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 40, description: 'The name that starts their lines in `text`.' },
    voice: { type: 'string', minLength: 1, maxLength: 200, description: 'Their voice id, from the note.' },
  },
  required: ['name', 'voice'],
  additionalProperties: false,
};

export function createGenerateAudioTool(deps: GenerateAudioDeps): Tool<GenerateAudioInput> {
  return {
    name: 'GenerateAudio',
    description: describe,
    compactExample: { kind: 'speech', text: '<the exact words to say>', voice: '<a voice id from the note>' },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['speech', 'music', 'sound'], description: 'Speech, music or a sound effect.' },
        text: { type: 'string', minLength: 1, maxLength: 40_000, description: 'Speech: exactly the words to say.' },
        direction: { type: 'string', maxLength: 2000, description: 'Speech: how to say it, on models that take directions.' },
        voice: { type: 'string', maxLength: 200, description: 'Speech: a voice id from the note.' },
        speakers: { type: 'array', minItems: 2, maxItems: 10, items: SPEAKER, description: 'Speech between several people: who speaks and in which voice.' },
        speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'Speech: 1 is normal, 1.2 a little faster.' },
        language: { type: 'string', maxLength: 40, description: 'The language, like en or German, where the model needs telling.' },
        prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'Music or sound: what it should sound like.' },
        lyrics: { type: 'string', maxLength: 10_000, description: 'Music: words to sing, on models that sing.' },
        instrumental: { type: 'boolean', description: 'Music: no vocals.' },
        seconds: { type: 'number', minimum: 0.5, maximum: 600, description: 'Music or sound: how long it is.' },
        negative_prompt: { type: 'string', maxLength: 1000, description: 'What it must not have, for models that take one.' },
        model: { type: 'string', description: 'Which sound model; leave it out for the person’s choice.' },
        seed: { type: 'integer', minimum: 0, description: 'Repeats a result, on models that can.' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    compactSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['speech', 'music', 'sound'] },
        text: { type: 'string', minLength: 1, maxLength: 40_000 },
        voice: { type: 'string' },
        prompt: { type: 'string', minLength: 1, maxLength: 4000 },
        seconds: { type: 'number' },
        model: { type: 'string' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    readOnly: false,
    concurrent: true,
    run: (input, ctx) => deps.generate(input, ctx),
  };
}
