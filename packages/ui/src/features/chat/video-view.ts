/**
 * What the transcript shows for a GenerateVideo call (design/components.md › GeneratedVideos), worked out from the call, its
 * result and its live progress, as image-view.ts does for pictures. The tool's result text is written for the model.
 */
import type { ImageProgress, ToolCallPart, ToolResultPart } from '@atelier/protocol';
import { formatEta, imageFailure, resultText, type ImageFailure, type ImageShape, type ShownImage } from './image-view.ts';

/** A finished clip: the stored facts of a `generated` entry of kind video. */
export type ShownVideo = Omit<ShownImage, 'kind'> & { kind: 'video' };

const input = (call: Pick<ToolCallPart, 'input'>) => (call.input && typeof call.input === 'object' ? (call.input as { prompt?: unknown; aspect_ratio?: unknown; seconds?: unknown }) : {});

export const videoPrompt = (call: Pick<ToolCallPart, 'input'>): string => {
  const { prompt } = input(call);
  return typeof prompt === 'string' ? prompt : '';
};

/** The clips of a call; ahead of the result, what progress says is done. */
export function shownVideos(result: ToolResultPart | undefined, progress?: ImageProgress): ShownVideo[] {
  const list = result ? (result.isError ? [] : (result.generated ?? [])) : (progress?.images ?? []);
  return list.filter((g) => g.kind === 'video') as ShownVideo[];
}

/** The shape the clip will have: what the backend settled on, else the ratio asked for, else the usual wide one. */
export function plannedVideoShape(call: Pick<ToolCallPart, 'input'>, progress: ImageProgress | undefined): ImageShape {
  if (progress?.width && progress.height) return { width: progress.width, height: progress.height };
  const asked = input(call).aspect_ratio;
  const ratio = typeof asked === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(asked) : null;
  if (ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0) return { width: Number(ratio[1]), height: Number(ratio[2]) };
  return { width: 16, height: 9 };
}

/** "0:06", "1:05": a clip's length as a player writes it. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** How far along it is, 0 to 1; undefined while nothing says, which is a shimmer and no bar. */
export function videoFraction(progress: ImageProgress | undefined): number | undefined {
  if (!progress) return undefined;
  if (progress.phase === 'finishing') return 1;
  if (progress.phase !== 'generating') return undefined;
  if (progress.fraction !== undefined) return progress.fraction;
  return progress.steps && progress.step !== undefined ? Math.min(1, progress.step / progress.steps) : undefined;
}

/** The one line that says what's going on while a clip is made. A clip takes minutes, so it says what is being waited for. */
export function videoStatus(progress: ImageProgress | undefined, { seconds, waiting }: { seconds: number | undefined; waiting: boolean }): string {
  if (!progress) return waiting ? 'Waiting for your answer' : 'Getting ready';
  const length = progress.seconds ?? seconds;
  switch (progress.phase) {
    case 'queued':
      return progress.ahead ? `${progress.ahead} ahead of you` : 'Waiting in line';
    case 'freeing':
      return 'Freeing the GPU';
    case 'loading':
      return 'Loading the model';
    case 'finishing':
      return 'Saving the video';
    case 'generating': {
      const fraction = videoFraction(progress);
      const where = progress.steps && progress.step !== undefined ? `Step ${Math.min(progress.step, progress.steps)} of ${progress.steps}` : fraction !== undefined ? `${Math.round(fraction * 100)}%` : length ? `Making a ${Math.round(length)} s video` : 'Making the video';
      return progress.etaMs !== undefined ? `${where} · ${formatEta(progress.etaMs)}` : where;
    }
  }
}

const VIDEO_SETUP = /^No video model is available/;

/** Why there is no clip, in the words the person should read. */
export function videoFailure(text: string): ImageFailure {
  const failure = imageFailure(text.replace(/^GenerateVideo failed: /, ''));
  if (failure.kind === 'failed' && VIDEO_SETUP.test(failure.text)) return { kind: 'setup', text: failure.text };
  return failure.text === 'The image could not be made.' ? { kind: 'failed', text: 'The video could not be made.' } : failure;
}

/** A name for a downloaded clip, from its prompt; the hash keeps clips of one prompt apart. */
export function videoFileName(video: Pick<ShownVideo, 'prompt' | 'blob' | 'mime'>): string {
  const slug = video.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'video'}-${video.blob.slice(0, 6)}.${video.mime === 'video/webm' ? 'webm' : 'mp4'}`;
}

export { resultText };
