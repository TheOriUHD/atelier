/**
 * What the transcript shows for a GenerateImage call (design/components.md › GeneratedImages), worked out from the call,
 * its result and its live progress. The tool's result text is written for the model, so what people read is drawn from it here.
 */
import { imageId, type GeneratedImageMeta, type ImageProgress, type ToolCallPart, type ToolResultPart } from '@atelier/protocol';

export interface ImageShape {
  width: number;
  height: number;
}

/** A finished image. Results from before `generated` existed, and old clients' messages, only have blob and mime. */
export type ShownImage = Pick<GeneratedImageMeta, 'id' | 'blob' | 'mime' | 'prompt'> & Partial<Omit<GeneratedImageMeta, 'id' | 'blob' | 'mime' | 'prompt'>>;

const input = (call: Pick<ToolCallPart, 'input'>) => (call.input && typeof call.input === 'object' ? (call.input as { prompt?: unknown; aspect_ratio?: unknown; count?: unknown }) : {});

export const promptOf = (call: Pick<ToolCallPart, 'input'>): string => {
  const { prompt } = input(call);
  return typeof prompt === 'string' ? prompt : '';
};

export function resultText(result: ToolResultPart | undefined): string {
  return result?.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n') ?? '';
}

/** The images of a call: their stored facts, or just what's in `content`; ahead of the result, what progress says is done. */
export function shownImages(call: Pick<ToolCallPart, 'input'>, result: ToolResultPart | undefined, progress?: ImageProgress): ShownImage[] {
  if (!result) return progress?.images ?? [];
  if (result.isError) return [];
  if (result.generated?.length) return result.generated;
  const prompt = promptOf(call);
  return result.content.flatMap((c) => (c.type === 'image' ? [{ id: imageId(c.blob), blob: c.blob, mime: c.mime, prompt }] : []));
}

/** The size a call will have: what the backend settled on, else the ratio it asked for, else the usual square. */
export function plannedShape(call: Pick<ToolCallPart, 'input'>, progress: ImageProgress | undefined): ImageShape {
  if (progress?.width && progress.height) return { width: progress.width, height: progress.height };
  const asked = input(call).aspect_ratio;
  const ratio = typeof asked === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(asked) : null;
  if (ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0) return { width: Number(ratio[1]), height: Number(ratio[2]) };
  return { width: 1, height: 1 };
}

export function plannedCount(call: Pick<ToolCallPart, 'input'>, progress: ImageProgress | undefined): number {
  const asked = input(call).count;
  return progress?.count ?? (typeof asked === 'number' && asked >= 1 ? Math.min(4, Math.floor(asked)) : 1);
}

/** How far along it is, 0 to 1; undefined while nothing says, which is a shimmer and no bar. */
export function imageFraction(progress: ImageProgress | undefined): number | undefined {
  if (!progress) return undefined;
  if (progress.phase === 'finishing') return 1;
  if (progress.phase !== 'generating') return undefined;
  if (progress.fraction !== undefined) return progress.fraction;
  return progress.steps && progress.step !== undefined ? Math.min(1, progress.step / progress.steps) : undefined;
}

/** "about 20 s", settling on round numbers where a second more or less says nothing and would only flicker. */
export function formatEta(ms: number): string {
  const seconds = ms / 1000;
  if (seconds >= 90) return `about ${Math.round(seconds / 60)} min`;
  if (seconds >= 10) return `about ${Math.round(seconds / 5) * 5} s`;
  return `about ${Math.max(1, Math.round(seconds))} s`;
}

/** "14 s", "3.2 s", "1 min 12 s". */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`;
}

/** The one line that says what's going on while an image is made. */
export function imageStatus(progress: ImageProgress | undefined, { count, waiting }: { count: number; waiting: boolean }): string {
  const them = count > 1 ? `${count} images` : 'the image';
  if (!progress) return waiting ? 'Waiting for your answer' : 'Getting ready';
  switch (progress.phase) {
    case 'queued':
      return progress.ahead ? `${progress.ahead} ahead of you` : 'Waiting for the image server';
    case 'freeing':
      return 'Freeing the GPU';
    case 'loading':
      return 'Loading the model';
    case 'finishing':
      return `Saving ${them}`;
    case 'generating': {
      const where = progress.steps && progress.step !== undefined ? `Step ${Math.min(progress.step, progress.steps)} of ${progress.steps}` : progress.fraction !== undefined ? `${Math.round(progress.fraction * 100)}%` : `Making ${them}`;
      return progress.etaMs !== undefined ? `${where} · ${formatEta(progress.etaMs)}` : where;
    }
  }
}

/**
 * How blurred the picture forming is: heavy at the start, clear just before the end, so the finished image takes over
 * from something nearly sharp. A backend that doesn't say how far it is gets a middle value.
 */
export function previewBlur(fraction: number | undefined): number {
  if (fraction === undefined) return 6;
  return Math.round(Math.max(0, 14 * (1 - fraction / 0.9)) * 10) / 10;
}

export interface ImageFailure {
  /** `setup`: something an admin can put right in Settings, unlike a prompt the service turned down. */
  kind: 'stopped' | 'refused' | 'setup' | 'failed';
  text: string;
}

const FAILED_PREFIX = /^GenerateImage failed: /;
const ABORTED = /^(this operation was aborted|stopped\.?)/i;
/** Sentences written to steer the model; the person gets the sentence around them. */
const FOR_THE_MODEL = [/ That is final: tell the person, and don't reword the prompt to get past it\.$/, / Stop here and tell the person; they can ask for more in their next message\.$/];
const SETUP = /^No image model is available|^Cannot reach |rejected the credentials|endpoint not found|^Model not found|is turned off\.$|has no model "/;

export function imageFailure(text: string): ImageFailure {
  const said = text.replace(FAILED_PREFIX, '').trim();
  if (ABORTED.test(said)) return { kind: 'stopped', text: 'Stopped before it finished.' };
  const plain = FOR_THE_MODEL.reduce((s, sentence) => s.replace(sentence, ''), said).replace(/ Tell the person; an admin can change it\.$/, ' An admin can change it.');
  if (/ refused this\b/.test(plain)) return { kind: 'refused', text: plain };
  if (SETUP.test(plain)) return { kind: 'setup', text: plain };
  return { kind: 'failed', text: plain || 'The image could not be made.' };
}

/** When only some images came back, why the rest didn't. */
export function missingNote(result: ToolResultPart | undefined): string | null {
  return /^Only these came back: (.+)$/m.exec(resultText(result))?.[1] ?? null;
}

/** A name for a downloaded image, from its prompt; the hash keeps a call's four images apart. */
export function imageFileName(image: Pick<ShownImage, 'prompt' | 'blob' | 'mime'>): string {
  const slug = image.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'image'}-${image.blob.slice(0, 6)}.${image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1]}`;
}

export type ImageLayout = 'one' | 'row' | 'hero-side' | 'hero-top' | 'strip' | 'grid';

/**
 * How a call's images share the column. Three wide pictures stack, because side by side each would be a sliver; four
 * tall ones stand in a row, the same size as they would be in a grid the height limit has narrowed, and without its empty half.
 */
export function imageLayout(shapes: readonly ImageShape[]): ImageLayout {
  const first = shapes[0];
  if (shapes.length <= 1 || !first) return 'one';
  if (shapes.length === 2) return 'row';
  const ratio = first.width / first.height;
  if (shapes.length === 3) return ratio > 1.2 ? 'hero-top' : 'hero-side';
  return shapes.length === 4 && ratio < 0.85 ? 'strip' : 'grid';
}
