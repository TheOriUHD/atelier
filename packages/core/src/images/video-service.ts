/**
 * One video generation from start to finish (ARCHITECTURE §23), the counterpart of `service.ts` for clips: picks the
 * model, keeps to the limits, fits the request to it, waits its turn, follows the adapter's long job, stores the clip
 * and records what it cost. It shares the providers, the registry, the queue and the library with images; what differs
 * is that a clip takes minutes and costs real money, so there are no automatic retries and the limits are its own.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { IMAGE_ID_PREFIX, videoId, type GeneratedImageMeta, type ImageModelInfo, type Message, type Settings } from '@atelier/protocol';
import type { BlobStore } from '../store/blobs.ts';
import type { Db } from '../store/db.ts';
import { generatedImages, usageEvents } from '../store/schema.ts';
import type { FileRepo } from '../files/file-repo.ts';
import { fitImage, sniffMime } from '../providers/images.ts';
import type { ProviderFetch } from '../providers/types.ts';
import { textOutput, type ToolContext, type ToolOutput } from '../tools/types.ts';
import type { DownloadedVideo } from './download.ts';
import { parseRatio } from './params.ts';
import { createProgressReporter, type ProgressReporter } from './progress.ts';
import { listVideoPrice, videoCost } from './prices.ts';
import { ImageModelUnavailable, type ImageProviderRegistry, type ResolvedImageModel } from './registry.ts';
import { imagesIn, type ImageSessionFacts } from './service.ts';
import type { ImageEvent, ImageInput, ImageRequest } from './types.ts';
import { checkVideo, videoFacts } from './video.ts';
import { describeDurations, fitVideo, type FittedVideo, type VideoAsk } from './video-params.ts';

export interface GenerateVideoInput {
  prompt: string;
  negative_prompt?: string;
  aspect_ratio?: string;
  resolution?: string;
  seconds?: number;
  audio?: boolean;
  fps?: number;
  /** An `img_…` id: the clip starts from this picture. */
  first_frame?: string;
  /** An `img_…` id: the clip ends on this picture. */
  last_frame?: string;
  model?: string;
  seed?: number;
}

export interface VideoServiceDeps {
  registry: ImageProviderRegistry;
  blobs: Pick<BlobStore, 'put' | 'read'>;
  files: Pick<FileRepo, 'addGenerated'>;
  db: Db;
  settings(): Settings;
  session(id: string): Promise<ImageSessionFacts>;
  /** The person's own default video model. */
  preferred(userId: string | null): Promise<string | undefined>;
  isAdmin(userId: string | null): Promise<boolean>;
  history(sessionId: string): Promise<Message[]>;
  turnStart(sessionId: string): Promise<number>;
  /** A finished clip's URL; `through` a person's computer when one of their own servers gave it. */
  download(url: string, signal: AbortSignal, through?: ProviderFetch): Promise<DownloadedVideo>;
  recordUsage(entry: { providerId: string; modelId: string; sessionId: string; userId: string | null; mode: string; videos: number; videoSeconds: number; costUsd: number | null; costEstimated: boolean; durationMs: number }): void;
  idleMs?: number;
  log?(message: string, error: unknown): void;
}

/** With nothing from the server for this long, it isn't coming. Many services say nothing between "queued" and "done", which the total limit covers. */
const IDLE_MS = 15 * 60_000;
const TOTAL_MS = 60 * 60_000;
/** A turn may make this many clips unless the admin says otherwise: each costs minutes and real money. */
export const DEFAULT_VIDEOS_PER_TURN = 2;
const MAX_FRAME_SIDE = 2048;
const MAX_FRAME_BYTES = 20 * 1024 * 1024;

/** A problem the model should read and work around, not a failure of Atelier. */
class VideoCallError extends Error {}

/** A name for the saved file, from the prompt. */
function fileName(prompt: string, sha: string, mime: string): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'video'}-${sha.slice(0, 6)}.${mime === 'video/webm' ? 'webm' : 'mp4'}`;
}

const wholeSeconds = (ms: number) => String(Math.max(1, Math.round(ms / 1000)));

export class VideoService {
  /** Clips made or under way per session this turn, so parallel calls can't all slip under the limit. */
  private turns = new Map<string, { since: number; count: number }>();
  /** Clips under way per person, which usage doesn't show yet. */
  private underWay = new Map<string, number>();

  constructor(private readonly deps: VideoServiceDeps) {}

  /** The video models a session can use, the person's choice first. */
  async models(session: ImageSessionFacts): Promise<ImageModelInfo[]> {
    const { enabled, videoEnabled } = this.deps.settings().imageGeneration;
    if (!enabled || videoEnabled === false) return [];
    const admin = await this.deps.isAdmin(session.userId);
    const all = (await this.deps.registry.listModels(session.userId)).filter((m) => (admin || !m.hidden) && m.capabilities.output === 'video' && !!m.capabilities.video);
    const first = (await this.deps.preferred(session.userId)) ?? this.deps.settings().models.defaults.video;
    return [...all].sort((a, b) => Number(b.ref === first) - Number(a.ref === first));
  }

  /** Whether any video model can run now: one on a computer that's away can't. */
  async available(session: ImageSessionFacts): Promise<boolean> {
    return (await this.models(session)).some((m) => m.available !== false);
  }

  private async pick(session: ImageSessionFacts, asked: string | undefined): Promise<ResolvedImageModel> {
    const models = await this.models(session);
    if (models.length === 0) throw new VideoCallError('No video model is available. An admin adds one in Settings › Media.');
    const wanted = asked?.toLowerCase();
    const match = wanted ? models.find((m) => m.ref.toLowerCase() === wanted || m.modelId.toLowerCase() === wanted || m.displayName.toLowerCase() === wanted) : models.find((m) => m.available !== false) ?? models[0];
    if (!match) throw new VideoCallError(`There's no video model "${asked}". You can use: ${models.map((m) => m.ref).join(', ')}.`);
    return this.deps.registry.resolve(match.ref, { admin: await this.deps.isAdmin(session.userId), userId: session.userId });
  }

  /** The models as the text model reads them: what lengths, sizes and inputs each takes. */
  async modelList(session: ImageSessionFacts): Promise<string> {
    return (await this.models(session))
      .filter((m) => m.available !== false)
      .map((m) => {
        const { video, promptStyle, negativePrompt } = m.capabilities;
        if (!video) return '';
        const traits = [
          video.fixedLength ? 'the model chooses the length' : `${describeDurations(video.durations)}, usually ${video.defaultSeconds}`,
          ...(video.resolutions?.length ? [video.resolutions.join('/')] : []),
          ...(m.capabilities.sizes.kind === 'aspect' ? [m.capabilities.sizes.ratios.join(' or ')] : []),
          video.audio === 'none' ? 'silent' : video.audio === 'always' ? 'with sound' : 'sound optional',
          ...(video.firstFrameRequired ? ['needs a picture to start from, in first_frame'] : video.firstFrame ? [video.lastFrame ? 'can start from and end on an image' : 'can start from an image'] : []),
          promptStyle === 'tags' ? 'prompt in comma-separated tags' : 'prompt in plain sentences',
          ...(negativePrompt ? ['takes a negative prompt'] : []),
        ];
        return `- ${m.ref} (${m.displayName}${m.description ? `, ${m.description}` : ''}): ${traits.join('; ')}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  /** A first or last frame by its id only, for the same reason images are: this tool goes unreviewed, so a path would let a prompt-injected model send any file to a provider. */
  private async frame(sessionId: string, reference: string): Promise<ImageInput> {
    if (!reference.startsWith(IMAGE_ID_PREFIX)) throw new VideoCallError(`"${reference}" isn't an image id. To start from an image file, open it with Read first, then pass the id you get.`);
    const known = imagesIn(await this.deps.history(sessionId));
    const sha = known.get(reference);
    if (!sha) throw new VideoCallError(`There's no image ${reference} in this conversation.${known.size ? ` Images here: ${[...known.keys()].join(', ')}.` : ''}`);
    const bytes = await this.deps.blobs.read(sha);
    const mime = sniffMime(bytes);
    if (!mime) throw new VideoCallError(`${reference} isn't an image.`);
    const fitted = fitImage(bytes, mime, MAX_FRAME_SIDE, MAX_FRAME_BYTES);
    if (!fitted.ok) throw new VideoCallError(`The image ${reference} ${fitted.reason}.`);
    return { bytes: fitted.image.bytes, mime: fitted.image.mime, name: `frame-${reference}.${fitted.image.mime.split('/')[1]}` };
  }

  /** Keeps to the limits; throws what the model should tell the person. */
  private async checkLimits(sessionId: string, userId: string | null): Promise<void> {
    const { maxVideosPerUserPerDay, maxVideoSpendPerUserPerDayUsd } = this.deps.settings().imageGeneration;
    const maxVideosPerTurn = this.deps.settings().imageGeneration.maxVideosPerTurn ?? DEFAULT_VIDEOS_PER_TURN;
    const since = await this.deps.turnStart(sessionId);
    const turn = this.turns.get(sessionId);
    const made = turn?.since === since ? turn.count : 0;
    if (made + 1 > maxVideosPerTurn) throw new VideoCallError(`That's the limit of ${maxVideosPerTurn} ${maxVideosPerTurn === 1 ? 'video' : 'videos'} in one turn. Stop here and tell the person; they can ask for more in their next message.`);
    if (userId && (maxVideosPerUserPerDay !== undefined || maxVideoSpendPerUserPerDayUsd !== undefined)) {
      const midnight = new Date().setUTCHours(0, 0, 0, 0);
      const today = this.deps.db
        .select({ videos: sql<number>`coalesce(sum(${usageEvents.videos}), 0)`, cost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)` })
        .from(usageEvents)
        .where(and(eq(usageEvents.userId, userId), gte(usageEvents.ts, midnight), gte(usageEvents.videos, 1)))
        .get();
      if (maxVideosPerUserPerDay !== undefined && (today?.videos ?? 0) + (this.underWay.get(userId) ?? 0) + 1 > maxVideosPerUserPerDay) throw new VideoCallError(`This account has reached its limit of ${maxVideosPerUserPerDay} videos a day. Tell the person; an admin can change it.`);
      if (maxVideoSpendPerUserPerDayUsd !== undefined && (today?.cost ?? 0) >= maxVideoSpendPerUserPerDayUsd) throw new VideoCallError(`This account has reached its limit of $${maxVideoSpendPerUserPerDayUsd} of videos a day. Tell the person; an admin can change it.`);
    }
    this.turns.set(sessionId, { since, count: made + 1 });
    if (userId) this.underWay.set(userId, (this.underWay.get(userId) ?? 0) + 1);
  }

  private release(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (turn) turn.count = Math.max(0, turn.count - 1);
  }

  private settle(userId: string | null): void {
    if (!userId) return;
    const left = (this.underWay.get(userId) ?? 0) - 1;
    if (left > 0) this.underWay.set(userId, left);
    else this.underWay.delete(userId);
  }

  async generate(input: GenerateVideoInput, ctx: ToolContext): Promise<ToolOutput> {
    const started = Date.now();
    /** Counted towards the limit and not made, handed back at the end. */
    let reserved = false;
    let underWay = false;
    let userId: string | null = null;
    try {
      const session = await this.deps.session(ctx.sessionId);
      userId = session.userId;
      const model = await this.pick(session, input.model);
      const ask: VideoAsk = {
        seconds: input.seconds,
        aspectRatio: input.aspect_ratio,
        resolution: input.resolution,
        audio: input.audio,
        fps: input.fps,
        seed: input.seed,
        negativePrompt: input.negative_prompt,
        firstFrame: !!input.first_frame,
        lastFrame: !!input.last_frame,
      };
      const fit = fitVideo(model.info.capabilities, ask, this.deps.settings().imageModels.overrides[model.info.ref]?.video);
      // An image-to-video model can't start without a picture: say so before a slot, a limit or any money is used.
      if (model.info.capabilities.video?.firstFrameRequired && !fit.firstFrame) throw new VideoCallError(`${model.info.displayName} makes video only from a picture. Pass the id of one in first_frame, or choose another model.`);
      await this.checkLimits(ctx.sessionId, session.userId);
      reserved = true;
      underWay = true;

      const firstFrame = fit.firstFrame ? await this.frame(ctx.sessionId, input.first_frame!) : undefined;
      const lastFrame = fit.lastFrame ? await this.frame(ctx.sessionId, input.last_frame!) : undefined;

      const shape = frameShape(fit);
      const progress = createProgressReporter(ctx, { kind: 'video', seconds: fit.seconds, count: 1, ...shape });
      progress.update({}, true);

      const release = await this.deps.registry.hold(model, ctx.signal, { onWait: (ahead) => progress.update({ phase: 'queued', ...(ahead !== null ? { ahead } : {}) }, true), owner: ctx.sessionId });
      try {
        const { video, finish, usage } = await this.run(model, input, fit, { firstFrame, lastFrame }, ctx, progress);
        if (finish.reason === 'aborted' || ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Stopped.');
        if (!video) {
          if (finish.reason === 'refused') return textOutput(`${finish.error?.message ?? `${model.config.name} refused this.`} That is final: tell the person, and don't reword the prompt to get past it.`, true);
          return textOutput(finish.error?.message ?? `${model.config.name} made no video.`, true);
        }
        progress.update({ phase: 'finishing' }, true);
        const stored = await this.store(video, input, model, session, ctx, { fit, usage, started });
        progress.update({ images: [stored] }, true);
        this.deps.recordUsage({
          providerId: model.info.providerId,
          modelId: model.info.modelId,
          sessionId: ctx.sessionId,
          userId: session.userId,
          mode: session.mode,
          videos: 1,
          videoSeconds: stored.seconds ?? fit.seconds,
          costUsd: stored.costUsd ?? null,
          costEstimated: stored.costEstimated ?? false,
          durationMs: stored.durationMs ?? 0,
        });
        reserved = false;
        return resultOutput(stored, model, fit, Date.now() - started);
      } finally {
        if (model.config.freeAfterRun) await model.adapter.free?.(AbortSignal.timeout(15_000)).catch(() => undefined);
        release();
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      if (error instanceof VideoCallError || error instanceof ImageModelUnavailable) return textOutput(error.message, true);
      throw error;
    } finally {
      if (reserved) this.release(ctx.sessionId);
      if (underWay) this.settle(userId);
    }
  }

  private async run(model: ResolvedImageModel, input: GenerateVideoInput, fit: FittedVideo, frames: { firstFrame: ImageInput | undefined; lastFrame: ImageInput | undefined }, ctx: ToolContext, progress: ProgressReporter) {
    if (model.config.sharesGpuWith) {
      progress.update({ phase: 'freeing' }, true);
      await this.deps.registry.freeText(model.config, ctx.signal);
    }
    progress.update({ phase: 'generating' }, true);
    const usage: { costUsd?: number } = {};
    const idle = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DOMException(`${model.config.name} sent nothing for too long.`, 'TimeoutError')), this.deps.idleMs ?? IDLE_MS);
    };
    const request: ImageRequest = {
      model: model.info.modelId,
      prompt: input.prompt,
      count: 1,
      quality: 'standard',
      references: [],
      tuning: {},
      loras: [],
      capabilities: model.info.capabilities,
      signal: AbortSignal.any([ctx.signal, idle.signal, AbortSignal.timeout(TOTAL_MS)]),
      video: {
        seconds: fit.seconds,
        ...(fit.fps !== undefined ? { fps: fit.fps } : {}),
        ...(fit.resolution ? { resolution: fit.resolution } : {}),
        ...(fit.audio !== undefined ? { audio: fit.audio } : {}),
        ...(frames.firstFrame ? { firstFrame: frames.firstFrame } : {}),
        ...(frames.lastFrame ? { lastFrame: frames.lastFrame } : {}),
      },
      ...(fit.negativePrompt ? { negativePrompt: fit.negativePrompt } : {}),
      ...(fit.width ? { width: fit.width } : {}),
      ...(fit.height ? { height: fit.height } : {}),
      ...(fit.aspectRatio ? { aspectRatio: fit.aspectRatio } : {}),
      ...(fit.sizeClass ? { sizeClass: fit.sizeClass } : {}),
      ...(fit.seed !== undefined ? { seed: fit.seed } : {}),
    };
    let video: Extract<ImageEvent, { type: 'video' }> | undefined;
    let finish: Extract<ImageEvent, { type: 'finish' }> = { type: 'finish', reason: 'error', error: { code: 'stream_truncated', message: `${model.config.name} stopped without an answer.`, retryable: true } };
    try {
      for await (const event of model.adapter.generate(request)) {
        // Only an adapter that has started talking can go quiet, so the clock starts with its first event.
        touch();
        if (event.type === 'queued') progress.update({ phase: 'queued', ahead: event.ahead }, true);
        else if (event.type === 'loading') progress.update({ phase: 'loading' }, true);
        else if (event.type === 'progress') {
          progress.update({ phase: 'generating', ...(event.step !== undefined ? { step: event.step } : {}), ...(event.steps !== undefined ? { steps: event.steps } : {}), ...(event.fraction !== undefined ? { fraction: event.fraction } : {}), ...(event.etaMs !== undefined ? { etaMs: event.etaMs } : {}) });
        } else if (event.type === 'preview') progress.preview(event.mime, event.data);
        else if (event.type === 'video') video ??= event;
        else if (event.type === 'usage') usage.costUsd = event.costUsd ?? usage.costUsd;
        else if (event.type === 'finish') {
          finish = event;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return { video, finish, usage };
  }

  private async store(video: Extract<ImageEvent, { type: 'video' }>, input: GenerateVideoInput, model: ResolvedImageModel, session: ImageSessionFacts, ctx: ToolContext, facts: { fit: FittedVideo; usage: { costUsd?: number }; started: number }): Promise<GeneratedImageMeta> {
    const durationMs = Date.now() - facts.started;
    // A person's own server says where its clip is as it sees it: that URL means nothing here, and this server must not go wherever it points.
    const fetched = video.bytes ? { bytes: video.bytes, mime: checkVideo(video.bytes) } : await this.deps.download(video.url!, ctx.signal, model.personal?.fetch);
    const { sha256: blob } = await this.deps.blobs.put(fetched.bytes, fetched.mime);
    const file = videoFacts(fetched.bytes);
    // What the file says wins over what was asked: the service may have made another length.
    const seconds = file.seconds ?? facts.fit.seconds;
    const cost = clipCost(this.deps.settings(), model, facts.fit, facts.usage, seconds);
    const width = file.width || facts.fit.width || 0;
    const height = file.height || facts.fit.height || 0;
    const fps = file.fps ?? facts.fit.fps;
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
      width,
      height,
      kind: 'video',
      mediaSeconds: seconds,
      fps: fps ?? null,
      audio: file.audio,
      prompt: input.prompt,
      negativePrompt: facts.fit.negativePrompt ?? null,
      providerId: model.info.providerId,
      modelId: model.info.modelId,
      modelName: model.info.displayName,
      params: { aspectRatio: input.aspect_ratio, resolution: facts.fit.resolution, seconds: facts.fit.seconds, fps: facts.fit.fps, audio: facts.fit.audio, firstFrame: !!input.first_frame, lastFrame: !!input.last_frame },
      seed: video.seed ?? facts.fit.seed ?? null,
      costUsd: cost?.usd ?? null,
      costEstimated: cost?.estimated ?? false,
      durationMs,
      hidden: session.temporary,
      createdAt: Date.now(),
    });
    const seed = video.seed ?? facts.fit.seed;
    return {
      id: videoId(blob),
      blob,
      mime: fetched.mime,
      width,
      height,
      kind: 'video',
      prompt: input.prompt,
      ref: model.info.ref,
      modelName: model.info.displayName,
      seconds,
      audio: file.audio,
      durationMs,
      ...(fps !== undefined ? { fps } : {}),
      ...(facts.fit.negativePrompt ? { negativePrompt: facts.fit.negativePrompt } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(cost ? { costUsd: cost.usd, costEstimated: cost.estimated } : {}),
    };
  }
}

/** The shape of the frame while the clip is made, so the transcript's frame has it from the first moment. */
function frameShape(fit: FittedVideo): { width?: number; height?: number } {
  if (fit.width && fit.height) return { width: fit.width, height: fit.height };
  const ratio = parseRatio(fit.aspectRatio) ?? 16 / 9;
  return { width: Math.max(1, Math.round(ratio * 1000)), height: 1000 };
}

/** The cost of a clip: what the service reported, else the admin's price, else a list price. A person's own server costs nothing here. */
function clipCost(settings: Settings, model: ResolvedImageModel, fit: FittedVideo, usage: { costUsd?: number }, seconds: number): { usd: number; estimated: boolean } | null {
  if (usage.costUsd !== undefined) return { usd: usage.costUsd, estimated: false };
  if (model.personal) return null;
  const price = settings.imagePricing[model.info.ref] ?? listVideoPrice(model.info.modelId);
  if (!price) return null;
  const usd = videoCost(price, seconds, fit.resolution);
  return usd === null ? null : { usd, estimated: true };
}

function resultOutput(stored: GeneratedImageMeta, model: ResolvedImageModel, fit: FittedVideo, totalMs: number): ToolOutput {
  const facts = [`${stored.seconds === undefined ? fit.seconds : Math.round(stored.seconds * 10) / 10} s`, ...(stored.width ? [`${stored.width}×${stored.height}`] : []), ...(stored.fps ? [`${stored.fps} fps`] : []), stored.audio ? 'with sound' : 'silent', ...(stored.seed !== undefined ? [`seed ${stored.seed}`] : []), `made in ${wholeSeconds(totalMs)} s`];
  const lines = [`Generated a video with ${model.info.displayName} (${facts.join(', ')}): ${stored.id}. It's on screen for the person: don't repeat it, link to it or describe it unless asked. You can't watch it.`];
  if (fit.notes.length) lines.push(fit.notes.join(' '));
  // No image part: the text model can't use a clip, and the bytes would only fill its context.
  return { content: [{ type: 'text', text: lines.join('\n') }], generated: [stored] };
}
