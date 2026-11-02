/**
 * One image generation from start to finish (ARCHITECTURE §23): picks the model, keeps to the limits, fits the request
 * to it, waits its turn on the server, follows the adapter's events, stores the images and records what they cost.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { imageId, IMAGE_ID_PREFIX, type GeneratedImageMeta, type ImageModelInfo, type ImageProgress, type ImageProviderDraft, type ImageTuning, type Message, type MessageError, type Settings } from '@atelier/protocol';
import type { BlobStore } from '../store/blobs.ts';
import type { Db } from '../store/db.ts';
import { generatedImages, usageEvents } from '../store/schema.ts';
import type { FileRepo } from '../files/file-repo.ts';
import { imageSize } from '../providers/image-size.ts';
import { fitImage, sniffMime } from '../providers/images.ts';
import { isLocalServer } from '../providers/scheduler.ts';
import type { ProviderFetch } from '../providers/types.ts';
import { toBase64 } from '../providers/util.ts';
import { textOutput, type ToolContext, type ToolOutput } from '../tools/types.ts';
import { checkImage, type DownloadedImage } from './download.ts';
import { MaskError, normaliseMask } from './mask.ts';
import { fitParams, type SizeName } from './params.ts';
import { imageCost, listImagePrice } from './prices.ts';
import { ImageModelUnavailable, type ImageProviderRegistry, type ResolvedImageModel } from './registry.ts';
import type { ImageEvent, ImageInput, ImageQuality, ImageRequest } from './types.ts';

export interface GenerateImageInput {
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  size?: SizeName;
  count?: number;
  quality?: ImageQuality;
  reference_images?: string[];
  mask?: string;
  model?: string;
  seed?: number;
  transparent?: boolean;
  options?: ImageTuning & { loras?: { name: string; weight?: number }[] };
}

export interface ImageSessionFacts {
  userId: string | null;
  mode: string;
  temporary: boolean;
  /** This session's choice, if it made one. */
  imageModel?: string;
}

export interface ImageServiceDeps {
  registry: ImageProviderRegistry;
  blobs: Pick<BlobStore, 'put' | 'read'>;
  files: Pick<FileRepo, 'addGenerated'>;
  db: Db;
  settings(): Settings;
  session(id: string): Promise<ImageSessionFacts>;
  /** The person's own default image model. */
  preferred(userId: string | null): Promise<string | undefined>;
  isAdmin(userId: string | null): Promise<boolean>;
  /** The session's messages, to find an image by its id. */
  history(sessionId: string): Promise<Message[]>;
  /** When the turn the session is in started. */
  turnStart(sessionId: string): Promise<number>;
  /** A finished image's URL; `through` a person's computer when one of their own servers gave it. */
  download(url: string, signal: AbortSignal, through?: ProviderFetch): Promise<DownloadedImage>;
  recordUsage(entry: { providerId: string; modelId: string; sessionId: string; userId: string | null; mode: string; images: number; costUsd: number | null; costEstimated: boolean; durationMs: number }): void;
  /** Changed by tests, which don't wait for retries. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  idleMs?: number;
  log?(message: string, error: unknown): void;
}

/** With nothing from the server for this long, it isn't coming. */
const IDLE_MS = 15 * 60_000;
const TOTAL_MS = 60 * 60_000;
const PROGRESS_EVERY_MS = 500;
/** Steps seen before their pace says anything about how long the rest will take. */
const ETA_AFTER_STEPS = 2;
const PREVIEW_EVERY_MS = 1_000;
const PREVIEW_SIDE = 512;
const PREVIEW_BYTES = 200_000;
const MAX_PREVIEW_CHARS = 16_000_000;
const MAX_PREVIEW_PIXELS = 4_000_000;
const RETRY_DELAYS_MS = [2_000, 6_000];
const MAX_INPUT_SIDE = 2048;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/** A problem the model should read and work around, not a failure of Atelier. */
class ImageCallError extends Error {}

/** A name for the saved file, from the prompt. */
function fileName(prompt: string, sha: string, mime: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'image'}-${sha.slice(0, 6)}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`;
}

const seconds = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

/** The ids of every image a conversation holds, attachments and generated alike, with their hashes. */
function imagesIn(messages: readonly Message[]): Map<string, string> {
  const found = new Map<string, string>();
  const add = (sha: string) => found.set(imageId(sha), sha);
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'image') add(p.blob);
      else if (p.type === 'tool_result') {
        for (const c of p.content) if (c.type === 'image') add(c.blob);
      }
      // The brushed mask of "change this area" is no attachment, but the model passes its id as `mask`.
      else if (p.type === 'context' && p.notice?.kind === 'area') add(p.notice.mask.blob);
    }
  }
  return found;
}

/** An image of the conversation and the mask the person brushed on it (`Notice` kind `area`). */
export interface AreaEdit {
  image: { blob: string; mime: string };
  mask: { blob: string; mime: string };
}

export class ImageService {
  /** Images made or under way per session this turn, so parallel calls can't all slip under the limit. */
  private turns = new Map<string, { since: number; count: number }>();
  /** Images under way per person, which usage doesn't show yet: sessions started together can't all slip under the daily limit. */
  private underWay = new Map<string, number>();

  constructor(private readonly deps: ImageServiceDeps) {}

  /** The models a session can use, the one it would use first. */
  async models(session: ImageSessionFacts): Promise<ImageModelInfo[]> {
    if (!this.deps.settings().imageGeneration.enabled) return [];
    const admin = await this.deps.isAdmin(session.userId);
    const all = (await this.deps.registry.listModels(session.userId)).filter((m) => admin || !m.hidden);
    const first = session.imageModel ?? (await this.deps.preferred(session.userId)) ?? this.deps.settings().models.defaults.image;
    return [...all].sort((a, b) => Number(b.ref === first) - Number(a.ref === first));
  }

  /** Whether any model can run now: one on a computer that's away can't. */
  async available(session: ImageSessionFacts): Promise<boolean> {
    return (await this.models(session)).some((m) => m.available !== false);
  }

  private async pick(session: ImageSessionFacts, asked: string | undefined): Promise<ResolvedImageModel> {
    const models = await this.models(session);
    if (models.length === 0) throw new ImageCallError('No image model is available. An admin adds one in Settings › Image providers.');
    const wanted = asked?.toLowerCase();
    const match = wanted ? models.find((m) => m.ref.toLowerCase() === wanted || m.modelId.toLowerCase() === wanted || m.displayName.toLowerCase() === wanted) : models[0];
    if (!match) throw new ImageCallError(`There's no image model "${asked}". You can use: ${models.map((m) => m.ref).join(', ')}.`);
    return this.deps.registry.resolve(match.ref, { admin: await this.deps.isAdmin(session.userId), userId: session.userId });
  }

  /**
   * An input image, by its id only. Paths aren't taken: this tool goes unreviewed, so a path would let a prompt-injected
   * model send any file in the folder to a provider. A file comes in through Read, which has permissions, and gets an id.
   */
  /** The bytes of one of this conversation's images by its id. Only this conversation's: a model can't reach anything else by guessing hashes. */
  private async imageBytes(sessionId: string, reference: string): Promise<{ bytes: Uint8Array; mime: NonNullable<ReturnType<typeof sniffMime>> }> {
    if (!reference.startsWith(IMAGE_ID_PREFIX)) throw new ImageCallError(`"${reference}" isn't an image id. To use an image file, open it with Read first, then pass the id you get.`);
    const known = imagesIn(await this.deps.history(sessionId));
    const sha = known.get(reference);
    if (!sha) throw new ImageCallError(`There's no image ${reference} in this conversation.${known.size ? ` Images here: ${[...known.keys()].join(', ')}.` : ''}`);
    const bytes = await this.deps.blobs.read(sha);
    const mime = sniffMime(bytes);
    if (!mime) throw new ImageCallError(`${reference} isn't an image.`);
    return { bytes, mime };
  }

  /**
   * The mask for `reference`, in the internal convention (white changes, images/mask.ts) and exactly its size, so each
   * dialect only has to convert, never to resize. A mask that is really a picture, or marks nothing, is the model's mistake to hear.
   */
  private async maskImage(sessionId: string, id: string, reference: ImageInput): Promise<ImageInput> {
    const { bytes } = await this.imageBytes(sessionId, id);
    try {
      return normaliseMask(bytes, reference);
    } catch (error) {
      if (error instanceof MaskError) throw new ImageCallError(`The mask ${id} ${error.message}`);
      throw error;
    }
  }

  private async inputImage(sessionId: string, reference: string): Promise<ImageInput> {
    const { bytes, mime } = await this.imageBytes(sessionId, reference);
    const fitted = fitImage(bytes, mime, MAX_INPUT_SIDE, MAX_INPUT_BYTES);
    if (!fitted.ok) throw new ImageCallError(`The image ${reference} ${fitted.reason}.`);
    return { bytes: fitted.image.bytes, mime: fitted.image.mime, name: `input-${reference}.${fitted.image.mime.split('/')[1]}` };
  }

  /** The available models that can change one area, the person's choice first. */
  async maskModels(session: ImageSessionFacts): Promise<ImageModelInfo[]> {
    return (await this.models(session)).filter((m) => m.available !== false && m.capabilities.edit && m.capabilities.mask);
  }

  /** What the model hears when a model can't change one area: which can, if any, so it can offer that instead of quietly changing everything. */
  private async cannotMask(session: ImageSessionFacts, model: ResolvedImageModel): Promise<string> {
    const others = (await this.maskModels(session)).filter((m) => m.ref !== model.info.ref);
    const head = `${model.config.name}'s ${model.info.displayName} can't change just one area.`;
    if (others.length === 0) return `${head} No image model here can. Tell the person that, and offer to change the whole picture instead, without a mask: describe the result you want and pass only the image in \`reference_images\`.`;
    return `${head} These can: ${others.map((m) => `${m.ref} (${m.displayName})`).join(', ')}. Say so, then call again with \`model\` set to one of them (a local server may need a moment to switch).`;
  }

  /**
   * What the model is told when the person brushed an area (docs/PROMPTS.md): checked first, so a mask that can't work
   * is refused when it is sent, not after the model spent a turn on it. Throws what the person should read.
   */
  async areaNote(sessionId: string, area: AreaEdit): Promise<string> {
    const session = await this.deps.session(sessionId);
    const models = await this.maskModels(session);
    if (!(await this.available(session))) throw new Error('No image model is available. An admin adds one in Settings › Image providers.');
    const image = imageId(area.image.blob);
    const mask = imageId(area.mask.blob);
    try {
      const reference = await this.inputImage(sessionId, image);
      // The same check the generation will make, with the model the person would get.
      await this.maskImage(sessionId, mask, reference);
    } catch (error) {
      if (error instanceof ImageCallError) throw new Error(error.message, { cause: error });
      throw error;
    }
    const capable = models.length > 0 ? `Image models that can change one area: ${models.map((m) => m.ref).join(', ')}.` : 'No image model here is known to change just one area; if GenerateImage says so, tell the person and offer to change the whole picture instead.';
    return [
      `The person brushed over part of the image ${image} and wants only that area changed. Their message says how.`,
      `Call GenerateImage with \`reference_images\` ["${image}"] and \`mask\` "${mask}". The mask is not a picture to look at or describe: white marks the area to change.`,
      '`prompt` describes the whole picture as it should look afterwards, with the change made, in the style of the original; everything outside the area stays as it is. Keep the original\'s aspect ratio.',
      capable,
      "If GenerateImage says the model can't change one area, follow what it says. Never paste the ids into your reply.",
    ].join('\n');
  }

  /** The models as the text model reads them, the person's choice first. */
  async modelList(session: ImageSessionFacts): Promise<string> {
    return (await this.models(session))
      .filter((m) => m.available !== false)
      .map((m) => {
        const { promptStyle, negativePrompt, edit } = m.capabilities;
        const style = promptStyle === 'tags' ? 'comma-separated tags' : 'plain sentences';
        const traits = [`prompt in ${style}`, ...(negativePrompt ? ['takes a negative prompt'] : []), ...(edit ? ['can change images'] : [])];
        return `- ${m.ref} (${m.displayName}${m.description ? `, ${m.description}` : ''}): ${traits.join(', ')}`;
      })
      .join('\n');
  }

  /** Makes one small real image from a provider that may not be saved yet, for the Test button. */
  async tryImage(draft: ImageProviderDraft, modelId: string | undefined): Promise<{ blob: string; mime: string; width: number; height: number; durationMs: number }> {
    const started = Date.now();
    const { adapter } = await this.deps.registry.draftAdapter(draft);
    const models = await adapter.listModels(AbortSignal.timeout(20_000));
    const model = models.find((m) => m.modelId === modelId) ?? models[0];
    if (!model) throw new Error(`${draft.name} has no models to try.`);
    const fit = fitParams(model.capabilities, { size: 'small' });
    const request: ImageRequest = {
      model: model.modelId,
      prompt: 'A small red lighthouse on a rocky coast at sunrise, soft watercolor',
      count: 1,
      quality: 'draft',
      references: [],
      tuning: fit.tuning,
      loras: [],
      capabilities: model.capabilities,
      signal: AbortSignal.timeout(10 * 60_000),
      ...(fit.width ? { width: fit.width } : {}),
      ...(fit.height ? { height: fit.height } : {}),
      ...(fit.aspectRatio ? { aspectRatio: fit.aspectRatio } : {}),
      ...(fit.sizeClass ? { sizeClass: fit.sizeClass } : {}),
    };
    let image: Extract<ImageEvent, { type: 'image' }> | undefined;
    let error: MessageError | undefined;
    for await (const event of adapter.generate(request)) {
      if (event.type === 'image') image ??= event;
      if (event.type === 'finish') error = event.error;
    }
    if (!image) throw new Error(error?.message ?? `${draft.name} made no image.`);
    const fetched = image.bytes ? { bytes: image.bytes, mime: checkImage(image.bytes) } : await this.deps.download(image.url!, request.signal);
    const { sha256 } = await this.deps.blobs.put(fetched.bytes, fetched.mime);
    const size = imageSize(fetched.bytes) ?? { width: 0, height: 0 };
    return { blob: sha256, mime: fetched.mime, ...size, durationMs: Date.now() - started };
  }

  /** Keeps to the limits; throws what the model should tell the person. */
  private async checkLimits(sessionId: string, userId: string | null, count: number): Promise<void> {
    const { maxImagesPerTurn, maxImagesPerUserPerDay, maxSpendPerUserPerDayUsd } = this.deps.settings().imageGeneration;
    const since = await this.deps.turnStart(sessionId);
    const turn = this.turns.get(sessionId);
    const made = turn?.since === since ? turn.count : 0;
    if (made + count > maxImagesPerTurn) throw new ImageCallError(`That's the limit of ${maxImagesPerTurn} images in one turn. Stop here and tell the person; they can ask for more in their next message.`);
    if (userId && (maxImagesPerUserPerDay !== undefined || maxSpendPerUserPerDayUsd !== undefined)) {
      const midnight = new Date().setUTCHours(0, 0, 0, 0);
      const today = this.deps.db
        .select({ images: sql<number>`coalesce(sum(${usageEvents.images}), 0)`, cost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)` })
        .from(usageEvents)
        .where(and(eq(usageEvents.userId, userId), gte(usageEvents.ts, midnight), gte(usageEvents.images, 1)))
        .get();
      if (maxImagesPerUserPerDay !== undefined && (today?.images ?? 0) + (this.underWay.get(userId) ?? 0) + count > maxImagesPerUserPerDay) throw new ImageCallError(`This account has reached its limit of ${maxImagesPerUserPerDay} images a day. Tell the person; an admin can change it.`);
      if (maxSpendPerUserPerDayUsd !== undefined && (today?.cost ?? 0) >= maxSpendPerUserPerDayUsd) throw new ImageCallError(`This account has reached its limit of $${maxSpendPerUserPerDayUsd} of images a day. Tell the person; an admin can change it.`);
    }
    this.turns.set(sessionId, { since, count: made + count });
    if (userId) this.underWay.set(userId, (this.underWay.get(userId) ?? 0) + count);
  }

  private release(sessionId: string, count: number): void {
    const turn = this.turns.get(sessionId);
    if (turn) turn.count = Math.max(0, turn.count - count);
  }

  /** The job is over: what it made is in usage now, and the rest was never made. */
  private settle(userId: string | null, count: number): void {
    if (!userId || count === 0) return;
    const left = (this.underWay.get(userId) ?? 0) - count;
    if (left > 0) this.underWay.set(userId, left);
    else this.underWay.delete(userId);
  }

  /** Reports progress at a pace the connection and the page can take, and keeps previews small. */
  private progressReporter(ctx: ToolContext, shape: Pick<ImageProgress, 'width' | 'height' | 'count'>) {
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

  /** Runs one adapter stream, collecting finished images; retried as a whole when a hosted service has a hiccup. */
  private async collect(model: ResolvedImageModel, request: ImageRequest, progress: ReturnType<ImageService['progressReporter']>, onUsage: (e: Extract<ImageEvent, { type: 'usage' }>) => void): Promise<{ images: Extract<ImageEvent, { type: 'image' }>[]; finish: Extract<ImageEvent, { type: 'finish' }> }> {
    const images: Extract<ImageEvent, { type: 'image' }>[] = [];
    for await (const event of model.adapter.generate(request)) {
      switch (event.type) {
        case 'queued':
          progress.update({ phase: 'queued', ahead: event.ahead }, true);
          break;
        case 'loading':
          progress.update({ phase: 'loading' }, true);
          break;
        case 'progress':
          progress.update({ phase: 'generating', ...(event.step !== undefined ? { step: event.step } : {}), ...(event.steps !== undefined ? { steps: event.steps } : {}), ...(event.fraction !== undefined ? { fraction: event.fraction } : {}), ...(event.etaMs !== undefined ? { etaMs: event.etaMs } : {}) });
          break;
        case 'preview':
          progress.preview(event.mime, event.data);
          break;
        case 'image':
          images.push(event);
          progress.update({ phase: 'finishing' }, true);
          break;
        case 'usage':
          onUsage(event);
          break;
        case 'finish':
          return { images, finish: event };
      }
    }
    return { images, finish: { type: 'finish', reason: 'error', error: { code: 'stream_truncated', message: `${model.config.name} stopped without an answer.`, retryable: true } } };
  }

  async generate(input: GenerateImageInput, ctx: ToolContext): Promise<ToolOutput> {
    const started = Date.now();
    /** Counted towards the limit and not made, handed back at the end. */
    let reserved = 0;
    let underWay = 0;
    let userId: string | null = null;
    try {
      const session = await this.deps.session(ctx.sessionId);
      userId = session.userId;
      const model = await this.pick(session, input.model);
      const fit = fitParams(
        model.info.capabilities,
        {
          aspectRatio: input.aspect_ratio,
          size: input.size,
          count: input.count,
          quality: input.quality,
          negativePrompt: input.negative_prompt,
          seed: input.seed,
          transparent: input.transparent,
          tuning: input.options,
          loras: input.options?.loras,
          references: input.reference_images?.length,
          mask: !!input.mask,
        },
        this.deps.settings().imageModels.overrides[model.info.ref]?.tuning,
      );
      if (input.mask) {
        if (!input.reference_images?.length) throw new ImageCallError('A mask belongs to an image: put that image\'s id first in `reference_images`.');
        if (!fit.mask) throw new ImageCallError(await this.cannotMask(session, model));
      }
      await this.checkLimits(ctx.sessionId, session.userId, fit.count);
      reserved = fit.count;
      underWay = fit.count;

      const references = await Promise.all((input.reference_images ?? []).slice(0, fit.references).map((r) => this.inputImage(ctx.sessionId, r)));
      const mask = input.mask && fit.mask ? await this.maskImage(ctx.sessionId, input.mask, references[0]!) : undefined;

      const progress = this.progressReporter(ctx, { ...(fit.width ? { width: fit.width } : {}), ...(fit.height ? { height: fit.height } : {}), count: fit.count });
      progress.update({}, true);

      const release = await this.deps.registry.hold(model, ctx.signal, { onWait: (ahead) => progress.update({ phase: 'queued', ...(ahead !== null ? { ahead } : {}) }, true), owner: ctx.sessionId });
      try {
        const { images, finish, usage } = await this.run(model, input, fit, references, mask, ctx, progress);
        if (finish.reason === 'aborted' || ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Stopped.');
        if (images.length === 0) {
          if (finish.reason === 'refused') return textOutput(`${finish.error?.message ?? `${model.config.name} refused this.`} That is final: tell the person, and don't reword the prompt to get past it.`, true);
          return textOutput(failureText(model, finish.error), true);
        }
        const stored = await this.store(images, input, model, session, ctx, { fit, usage, started });
        progress.update({ images: stored }, true);
        this.reportUsage(model, ctx, session, stored);
        reserved -= stored.length;
        return resultOutput(stored, model, fit.notes, finish.reason === 'error' ? finish.error : undefined, Date.now() - started);
      } finally {
        if (model.config.freeAfterRun) await model.adapter.free?.(AbortSignal.timeout(15_000)).catch(() => undefined);
        release();
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      if (error instanceof ImageCallError || error instanceof ImageModelUnavailable) return textOutput(error.message, true);
      throw error;
    } finally {
      if (reserved > 0) this.release(ctx.sessionId, reserved);
      this.settle(userId, underWay);
    }
  }

  private async run(model: ResolvedImageModel, input: GenerateImageInput, fit: ReturnType<typeof fitParams>, references: ImageInput[], mask: ImageInput | undefined, ctx: ToolContext, progress: ReturnType<ImageService['progressReporter']>) {
    if (model.config.sharesGpuWith) {
      progress.update({ phase: 'freeing' }, true);
      await this.deps.registry.freeText(model.config, ctx.signal);
    }
    // Its turn has come: many services say nothing more until the image is there, and this isn't waiting in line any more.
    progress.update({ phase: 'generating' }, true);
    const idleMs = this.deps.idleMs ?? IDLE_MS;
    const sleep = this.deps.sleep ?? defaultSleep;
    const usage: { costUsd?: number; input?: number; output?: number } = {};
    for (let attempt = 0; ; attempt++) {
      const idle = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(new DOMException(`${model.config.name} sent nothing for too long.`, 'TimeoutError')), idleMs);
      };
      // Servers that report nothing until the image is done are limited by TOTAL_MS instead: only one that started
      // talking can go quiet.
      const watched: typeof progress = {
        update: (next, force) => (touch(), progress.update(next, force)),
        preview: (mime, data) => (touch(), progress.preview(mime, data)),
      };
      const request: ImageRequest = {
        model: model.info.modelId,
        prompt: input.prompt,
        count: fit.count,
        quality: fit.quality,
        references,
        tuning: fit.tuning,
        loras: fit.loras,
        capabilities: model.info.capabilities,
        signal: AbortSignal.any([ctx.signal, idle.signal, AbortSignal.timeout(TOTAL_MS)]),
        ...(mask ? { mask } : {}),
        ...(fit.negativePrompt ? { negativePrompt: fit.negativePrompt } : {}),
        ...(fit.width ? { width: fit.width } : {}),
        ...(fit.height ? { height: fit.height } : {}),
        ...(fit.aspectRatio ? { aspectRatio: fit.aspectRatio } : {}),
        ...(fit.sizeClass ? { sizeClass: fit.sizeClass } : {}),
        ...(fit.seed !== undefined ? { seed: fit.seed } : {}),
        ...(fit.transparent ? { transparent: true } : {}),
      };
      try {
        const { images, finish } = await this.collect(model, request, watched, (e) => {
          usage.costUsd = e.costUsd ?? usage.costUsd;
          usage.input = e.input ?? usage.input;
          usage.output = e.output ?? usage.output;
        });
        const again = finish.reason === 'error' && finish.error?.retryable && images.length === 0 && attempt < RETRY_DELAYS_MS.length && !ctx.signal.aborted && !isLocalServer(model.config.baseUrl);
        if (!again) return { images, finish, usage };
      } finally {
        clearTimeout(timer);
      }
      await sleep(RETRY_DELAYS_MS[attempt]!, ctx.signal);
    }
  }

  private async store(images: Extract<ImageEvent, { type: 'image' }>[], input: GenerateImageInput, model: ResolvedImageModel, session: ImageSessionFacts, ctx: ToolContext, facts: { fit: ReturnType<typeof fitParams>; usage: { costUsd?: number; input?: number; output?: number }; started: number }): Promise<GeneratedImageMeta[]> {
    const durationMs = Date.now() - facts.started;
    const each = perImageCost(this.deps.settings(), model, facts.fit, facts.usage, images.length);
    const stored: GeneratedImageMeta[] = [];
    for (const image of images) {
      // A person's own server says where its image is as it sees it: that URL means nothing here, and this server must not
      // go wherever it points. The computer fetches it, and only from the address it lent.
      const fetched = image.bytes ? { bytes: image.bytes, mime: checkImage(image.bytes) } : await this.deps.download(image.url!, ctx.signal, model.personal?.fetch);
      const { sha256: blob } = await this.deps.blobs.put(fetched.bytes, fetched.mime);
      const size = imageSize(fetched.bytes) ?? { width: facts.fit.width ?? 0, height: facts.fit.height ?? 0 };
      await this.deps.files.addGenerated({ name: fileName(input.prompt, blob, fetched.mime), mime: fetched.mime, blob, size: fetched.bytes.byteLength, userId: session.userId, sessionId: ctx.sessionId, messageId: ctx.messageId });
      await this.deps.db.insert(generatedImages).values({
        id: randomUUID(),
        userId: session.userId,
        sessionId: ctx.sessionId,
        messageId: ctx.messageId,
        callId: ctx.callId,
        blob,
        mime: fetched.mime,
        size: fetched.bytes.byteLength,
        width: size.width,
        height: size.height,
        prompt: input.prompt,
        revisedPrompt: image.revisedPrompt ?? null,
        negativePrompt: facts.fit.negativePrompt ?? null,
        providerId: model.info.providerId,
        modelId: model.info.modelId,
        modelName: model.info.displayName,
        params: { aspectRatio: input.aspect_ratio, size: input.size, quality: facts.fit.quality, tuning: facts.fit.tuning, loras: facts.fit.loras, references: input.reference_images?.length ?? 0 },
        seed: image.seed ?? facts.fit.seed ?? null,
        costUsd: each?.usd ?? null,
        costEstimated: each?.estimated ?? false,
        durationMs,
        hidden: session.temporary,
        createdAt: Date.now(),
      });
      stored.push({
        id: imageId(blob),
        blob,
        mime: fetched.mime,
        width: size.width,
        height: size.height,
        prompt: input.prompt,
        ref: model.info.ref,
        modelName: model.info.displayName,
        durationMs,
        ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
        ...(facts.fit.negativePrompt ? { negativePrompt: facts.fit.negativePrompt } : {}),
        ...((image.seed ?? facts.fit.seed) !== undefined ? { seed: (image.seed ?? facts.fit.seed)! } : {}),
        ...(each ? { costUsd: each.usd, costEstimated: each.estimated } : {}),
      });
    }
    return stored;
  }

  private reportUsage(model: ResolvedImageModel, ctx: ToolContext, session: ImageSessionFacts, stored: GeneratedImageMeta[]): void {
    const priced = stored.filter((s) => s.costUsd !== undefined);
    this.deps.recordUsage({
      providerId: model.info.providerId,
      modelId: model.info.modelId,
      sessionId: ctx.sessionId,
      userId: session.userId,
      mode: session.mode,
      images: stored.length,
      costUsd: priced.length ? priced.reduce((sum, s) => sum + s.costUsd!, 0) : null,
      costEstimated: priced.some((s) => s.costEstimated),
      durationMs: stored[0]?.durationMs ?? 0,
    });
  }
}

/** One image's cost: what the service reported, else the admin's price, else a list price. */
function perImageCost(settings: Settings, model: ResolvedImageModel, fit: ReturnType<typeof fitParams>, usage: { costUsd?: number; input?: number; output?: number }, count: number): { usd: number; estimated: boolean } | null {
  if (usage.costUsd !== undefined) return { usd: usage.costUsd / count, estimated: false };
  // A person's own server costs nothing here, whatever its model happens to be called.
  if (model.personal) return null;
  const price = settings.imagePricing[model.info.ref] ?? listImagePrice(model.info.modelId);
  if (!price) return null;
  if ((price.input !== undefined || price.output !== undefined) && (usage.input !== undefined || usage.output !== undefined)) {
    return { usd: (((usage.input ?? 0) * (price.input ?? 0) + (usage.output ?? 0) * (price.output ?? 0)) / 1_000_000) / count, estimated: false };
  }
  const usd = imageCost(price, fit.width, fit.height, fit.sizeClass);
  return usd === null ? null : { usd, estimated: true };
}

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

function failureText(model: ResolvedImageModel, error: MessageError | undefined): string {
  return error?.message ?? `${model.config.name} made no image.`;
}

function resultOutput(stored: GeneratedImageMeta[], model: ResolvedImageModel, notes: string[], failed: MessageError | undefined, totalMs: number): ToolOutput {
  const first = stored[0]!;
  const facts = [`${first.width}×${first.height}`, ...(first.seed !== undefined ? [`seed ${first.seed}`] : []), `${seconds(totalMs)} s`].join(', ');
  const lines = [`Generated ${stored.length === 1 ? 'an image' : `${stored.length} images`} with ${model.info.displayName} (${facts}): ${stored.map((s) => s.id).join(', ')}. They're on screen for the person: don't repeat them, link to them or describe them unless asked.`];
  const revised = first.revisedPrompt;
  if (revised) lines.push(`The service reworded the prompt to: ${revised}`);
  if (notes.length) lines.push(notes.join(' '));
  if (failed) lines.push(`Only these came back: ${failed.message}`);
  return { content: [{ type: 'text', text: lines.join('\n') }, ...stored.map((s) => ({ type: 'image' as const, mime: s.mime, blob: s.blob }))], generated: stored };
}
