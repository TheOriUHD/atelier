/**
 * Progress of a long job (ARCHITECTURE §23), shared by images and video: reports at a pace the connection and the page
 * can take, works out the time left from the pace of the steps, and keeps previews small.
 */
import type { ImageProgress } from '@atelier/protocol';
import { imageSize } from '../providers/image-size.ts';
import { fitImage } from '../providers/images.ts';
import { toBase64 } from '../providers/util.ts';
import type { ToolContext } from '../tools/types.ts';

const PROGRESS_EVERY_MS = 500;
/** Steps seen before their pace says anything about how long the rest will take. */
const ETA_AFTER_STEPS = 2;
const PREVIEW_EVERY_MS = 1_000;
const PREVIEW_SIDE = 512;
const PREVIEW_BYTES = 200_000;
const MAX_PREVIEW_CHARS = 16_000_000;
const MAX_PREVIEW_PIXELS = 4_000_000;

/** Reports progress at a pace the connection and the page can take, and keeps previews small. */
export function createProgressReporter(ctx: Pick<ToolContext, 'emit' | 'messageId' | 'callId'>, shape: Pick<ImageProgress, 'width' | 'height' | 'count' | 'kind' | 'seconds'>) {
  let sent = 0;
  let previewSent = 0;
  let preview: ImageProgress['preview'];
  let current: ImageProgress = { phase: 'queued', ...shape };
  // The first step seen: the time before it went to loading, so it's where the pace starts from.
  let first: { step: number; at: number } | undefined;
  /** Many servers report steps but no time; their pace tells it. */
  const paced = (next: Partial<ImageProgress>): Partial<ImageProgress> => {
    if (next.step === undefined || next.etaMs !== undefined) return next;
    first ??= { step: next.step, at: Date.now() };
    const done = next.step - first.step;
    const steps = next.steps ?? current.steps;
    return done >= ETA_AFTER_STEPS && steps ? { ...next, etaMs: ((Date.now() - first.at) / done) * Math.max(0, steps - next.step) } : next;
  };
  const send = (now: number) => {
    sent = now;
    ctx.emit({ type: 'tool_progress', messageId: ctx.messageId, callId: ctx.callId, progress: { ...current, ...(preview ? { preview } : {}) } });
  };
  return {
    update(next: Partial<ImageProgress>, force = false) {
      current = { ...current, ...paced(next) };
      const now = Date.now();
      if (force || now - sent >= PROGRESS_EVERY_MS) send(now);
    },
    preview(mime: string, data: string) {
      const now = Date.now();
      if (now - previewSent < PREVIEW_EVERY_MS) return;
      previewSent = now;
      const small = shrinkPreview(mime, data);
      if (small) preview = small;
      send(now);
    },
  };
}

export type ProgressReporter = ReturnType<typeof createProgressReporter>;

function shrinkPreview(mime: string, data: string): ImageProgress['preview'] {
  if (data.length <= PREVIEW_BYTES) return { mime, data };
  // Decoded on the backend's main thread, once a second, at a size a server chooses: a huge one is simply skipped.
  if (data.length > MAX_PREVIEW_CHARS) return undefined;
  const bytes = Buffer.from(data, 'base64');
  const size = imageSize(bytes);
  if (!size || size.width * size.height > MAX_PREVIEW_PIXELS) return undefined;
  const fitted = fitImage(bytes, mime, PREVIEW_SIDE, PREVIEW_BYTES);
  return fitted.ok ? { mime: fitted.image.mime, data: toBase64(fitted.image.bytes) } : undefined;
}
