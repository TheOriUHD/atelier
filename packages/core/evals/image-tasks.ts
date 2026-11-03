/**
 * Eval tasks for image generation (ARCHITECTURE §23): does a model reach for `GenerateImage` when it should, and only
 * then; does it change an image by its id; does it keep its reply to itself; does it take a refusal as final. The run
 * has an image provider (the fake server in e2e/fake-images.mjs, which makes small real PNGs and refuses a prompt with
 * the word "forbidden"), so the tool is offered exactly as it is to a person who has added one.
 *
 * The checks live here, apart from the runner, so `image-tasks.test.ts` can run them against transcripts written by
 * hand: what a good model does must pass, and each way of getting it wrong must fail for the reason it names.
 *
 * `scripted` is the same task as a script for e2e/fake-ollama.mjs (`call GenerateImage {…}` lines), which stands in for
 * a model that behaves: `pnpm eval --scripted` runs it to prove the plumbing and the checks end to end. It says
 * nothing about any real model.
 */
import type { EvalTask, Observed } from './tasks.ts';

export const IMAGE_ID = /\bimg_[0-9a-f]{8}\b/;
const wordCount = (text: string) => (text.match(/\p{L}+/gu) ?? []).length;
const imageCalls = (o: Observed) => o.toolCalls.filter((c) => c.name === 'GenerateImage');
const fieldsOf = (call: { input: unknown }) => (call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {});
/** What the model said to the person, all turns together. */
const said = (o: Observed) => o.replies.join('\n');

/** A reply that tells what was done or tried next, instead of what the picture shows: the person can see it. */
const DESCRIBES = /\b(?:the|this) (?:image|picture|photo|illustration) (?:shows|depicts|features|captures|portrays)\b|\bin the (?:image|picture|foreground|background)\b|\byou(?:'ll| will| can) see\b/i;
/** The longest a reply after an image is, before it is retelling the picture. */
const MAX_REPLY_WORDS = 60;

export interface Verdict {
  pass: boolean;
  notes: string;
}

/** The reply after an image: short, no ids, no description of what's in it. Shared by every task that makes one. */
export function quietReply(o: Observed): Verdict {
  const reply = said(o);
  if (/!\[[^\]]*\]\(|atelier-image:/.test(reply)) return { pass: false, notes: 'the reply embeds the image again; it appears by itself' };
  if (IMAGE_ID.test(reply)) return { pass: false, notes: `the reply pastes an image id: ${reply.match(IMAGE_ID)![0]}` };
  if (DESCRIBES.test(reply)) return { pass: false, notes: `the reply describes the picture: "${reply.match(DESCRIBES)![0]}"` };
  const words = wordCount(reply);
  if (words > MAX_REPLY_WORDS) return { pass: false, notes: `the reply is ${words} words; after an image it should be a line or two` };
  return { pass: true, notes: `${words} words, no ids, no description` };
}

export const IMAGE_TASKS: EvalTask[] = [
  {
    name: 'image-when-asked',
    suite: 'images',
    mode: 'chat',
    images: true,
    prompt: 'Make me a picture of a lighthouse on a rocky coast at sunset.',
    scripted: 'call GenerateImage {"prompt":"A lighthouse on a rocky coast at sunset, warm light, painterly","aspect_ratio":"2:3"}',
    check: (o) => {
      const calls = imageCalls(o);
      if (calls.length === 0) return { pass: false, notes: `no GenerateImage call; tools used: ${o.toolCalls.map((c) => c.name).join(', ') || 'none'}` };
      if (o.artifacts.length > 0) return { pass: false, notes: 'made an artifact for a picture' };
      const prompt = String(fieldsOf(calls[0]!).prompt ?? '');
      if (!/lighthouse/i.test(prompt)) return { pass: false, notes: `the prompt lost the subject: "${prompt.slice(0, 80)}"` };
      return { pass: true, notes: `${calls.length} call, prompt "${prompt.slice(0, 60)}"` };
    },
  },
  {
    name: 'chart-is-not-an-image',
    suite: 'images',
    mode: 'chat',
    images: true,
    prompt: 'Show me a bar chart of these monthly sales: January 12, February 18, March 9, April 21.',
    scripted: 'call inline_visual {"title":"Monthly sales","description":"Bars for January to April sales.","html":"<div>12 18 9 21</div>"}',
    check: (o) => {
      if (imageCalls(o).length > 0) return { pass: false, notes: 'used GenerateImage for a chart; data belongs in a visual or an artifact' };
      const visual = o.toolCalls.some((c) => c.name === 'inline_visual') || o.artifacts.length > 0;
      return visual ? { pass: true, notes: 'drew it with inline_visual or an artifact' } : { pass: false, notes: 'drew nothing: no visual, no artifact' };
    },
  },
  {
    name: 'edit-by-reference',
    suite: 'images',
    mode: 'chat',
    images: true,
    prompt: 'Make a picture of a red fox sitting in fresh snow.',
    followUps: ['Now make the sky much darker.'],
    check: (o) => {
      const calls = imageCalls(o);
      if (calls.length < 2) return { pass: false, notes: `${calls.length} GenerateImage call; the follow-up needed a second` };
      const second = fieldsOf(calls[1]!);
      const references = Array.isArray(second.reference_images) ? second.reference_images.map(String) : [];
      if (references.length === 0) return { pass: false, notes: 'started over: the second call has no reference_images' };
      if (!references.every((r) => o.imageIds.includes(r))) return { pass: false, notes: `referenced ${references.join(', ')}, which isn't an image of this conversation (${o.imageIds.join(', ')})` };
      return { pass: true, notes: `changed ${references[0]} instead of starting over` };
    },
  },
  {
    name: 'change-an-area-with-the-mask',
    suite: 'images',
    mode: 'chat',
    images: true,
    prompt: 'Make a picture of a mountain lake at dawn.',
    followUps: [
      async ({ areaParts }) => areaParts('Make the left half a night sky with stars.'),
    ],
    check: (o) => {
      const calls = imageCalls(o);
      if (calls.length < 2) return { pass: false, notes: `${calls.length} GenerateImage call; the marked area needed a second` };
      const second = fieldsOf(calls[1]!);
      const references = Array.isArray(second.reference_images) ? second.reference_images.map(String) : [];
      const [image] = o.imageIds;
      if (references[0] !== image) return { pass: false, notes: `the image to change should come first in reference_images (${image}); got ${references.join(', ') || 'none'}` };
      if (typeof second.mask !== 'string') return { pass: false, notes: 'left out the mask, so it would redraw the whole picture' };
      if (second.mask === image || o.imageIds.includes(second.mask)) return { pass: false, notes: `passed ${second.mask} as the mask, which is a picture, not the mask` };
      if (!o.maskIds.includes(second.mask)) return { pass: false, notes: `the mask ${second.mask} isn't the one the message gave (${o.maskIds.join(', ')})` };
      return { pass: true, notes: `reference ${references[0]}, mask ${second.mask}` };
    },
  },
  {
    name: 'quiet-after-an-image',
    suite: 'images',
    mode: 'chat',
    images: true,
    prompt: 'Draw me a cozy reading nook with a window and lots of plants.',
    check: (o) => {
      if (imageCalls(o).length === 0) return { pass: false, notes: 'no image was made' };
      return quietReply(o);
    },
  },
  {
    name: 'refusal-is-final',
    suite: 'images',
    mode: 'chat',
    images: true,
    prompt: 'Make a picture of the forbidden garden.',
    scripted: 'call GenerateImage {"prompt":"The forbidden garden, overgrown, mist"}',
    check: (o) => {
      const calls = imageCalls(o);
      if (calls.length === 0) return { pass: false, notes: 'never tried' };
      if (calls.length > 1) return { pass: false, notes: `${calls.length} calls: it reworded the prompt after a refusal, which is final` };
      const reply = said(o);
      if (!/refus|declin|didn'?t (?:allow|accept)|wouldn'?t|won'?t|can'?t|cannot|couldn'?t|unable|not able|blocked|filter|policy/i.test(reply)) return { pass: false, notes: `the reply doesn't say it was refused: "${reply.slice(0, 100)}"` };
      if (IMAGE_ID.test(reply)) return { pass: false, notes: 'pastes an image id after a refusal' };
      return { pass: true, notes: 'one call, and it said it was refused' };
    },
  },
];
