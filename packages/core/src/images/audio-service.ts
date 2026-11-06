/**
 * One sound from start to finish (ARCHITECTURE §23), the counterpart of `video-service.ts` for speech, music and sound
 * effects: picks a model that makes the kind asked for, keeps to the limits, fits the request to it, waits its turn,
 * follows the adapter's job, keeps the file and records what it cost. It shares the providers, the registry, the queue
 * and the library with images and video. Like a clip, a failed sound is never made again by itself: music costs real
 * money, and the model reads the error and decides.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { audioId, type AudioKind, type GeneratedImageMeta, type ImageModelInfo, type ImageProviderDraft, type Settings } from '@atelier/protocol';
import type { BlobStore } from '../store/blobs.ts';
import type { Db } from '../store/db.ts';
import { generatedImages, usageEvents } from '../store/schema.ts';
import type { FileRepo } from '../files/file-repo.ts';
import type { ProviderFetch } from '../providers/types.ts';
import { textOutput, type ToolContext, type ToolOutput } from '../tools/types.ts';
import { AUDIO_EXTENSIONS, audioFacts, checkAudio, isPcm, pcmRate, pcmToWav } from './audio.ts';
import { AudioAskError, fitAudio, kindName, type AudioAsk, type FittedAudio } from './audio-params.ts';
import type { DownloadedAudio } from './download.ts';
import { createProgressReporter, type ProgressReporter } from './progress.ts';
import { audioCost, listAudioPrice } from './prices.ts';
import { ImageModelUnavailable, type ImageProviderRegistry, type ResolvedImageModel } from './registry.ts';
import type { ImageSessionFacts } from './service.ts';
import type { AudioSpeaker, ImageEvent, ImageRequest } from './types.ts';
import { describeDurations, fitSeconds } from './video-params.ts';

export interface GenerateAudioInput {
  kind: AudioKind;
  /** Speech: exactly the words to say. */
  text?: string;
  /** Speech: how to say them. */
  direction?: string;
  /** Music and sound: what it should be. */
  prompt?: string;
  voice?: string;
  speakers?: AudioSpeaker[];
  speed?: number;
  language?: string;
  seconds?: number;
  lyrics?: string;
  instrumental?: boolean;
  negative_prompt?: string;
  model?: string;
  seed?: number;
}

export interface AudioServiceDeps {
  registry: ImageProviderRegistry;
  blobs: Pick<BlobStore, 'put'>;
  files: Pick<FileRepo, 'addGenerated'>;
  db: Db;
  settings(): Settings;
  session(id: string): Promise<ImageSessionFacts>;
  /** The person's own default model for this kind of sound. */
  preferred(userId: string | null, kind: AudioKind): Promise<string | undefined>;
  isAdmin(userId: string | null): Promise<boolean>;
  turnStart(sessionId: string): Promise<number>;
  /** A finished sound's URL; `through` a person's computer when one of their own servers gave it. */
  download(url: string, signal: AbortSignal, through?: ProviderFetch): Promise<DownloadedAudio>;
  recordUsage(entry: { providerId: string; modelId: string; sessionId: string; userId: string | null; mode: string; seconds: number; chars: number; costUsd: number | null; costEstimated: boolean; durationMs: number }): void;
  idleMs?: number;
}

/** With nothing from the server for this long, it isn't coming. Speech comes in seconds; a long song can take minutes, which the total limit covers. */
const IDLE_MS = 10 * 60_000;
const TOTAL_MS = 30 * 60_000;
/** A turn may make this many sounds unless the admin says otherwise: enough for a short exchange of lines, not a runaway loop. */
export const DEFAULT_AUDIO_PER_TURN = 6;
/** Voices listed per model in the note the text model reads: enough to choose from, and the note stays short. */
const VOICES_IN_NOTE = 30;

/** A problem the model should read and work around, not a failure of Atelier. */
class AudioCallError extends Error {}

/** A name for the saved file, from what was said or asked for. */
function fileName(words: string, sha: string, extension: string): string {
  const slug = words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'sound'}-${sha.slice(0, 6)}.${extension}`;
}

const wholeSeconds = (ms: number) => String(Math.max(1, Math.round(ms / 1000)));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** What a call is about: the words for speech, the description otherwise. */
const subject = (input: GenerateAudioInput) => (input.kind === 'speech' ? (input.text ?? '') : (input.prompt ?? ''));

export class AudioService {
  /** Sounds made or under way per session this turn, so parallel calls can't all slip under the limit. */
  private turns = new Map<string, { since: number; count: number }>();
  /** Sounds under way per person, which usage doesn't show yet. */
  private underWay = new Map<string, number>();

  constructor(private readonly deps: AudioServiceDeps) {}

  /** The sound models a session can use, of every kind. */
  async models(session: ImageSessionFacts): Promise<ImageModelInfo[]> {
    const { enabled, audioEnabled } = this.deps.settings().imageGeneration;
    if (!enabled || audioEnabled === false) return [];
    const admin = await this.deps.isAdmin(session.userId);
    return (await this.deps.registry.listModels(session.userId)).filter((m) => (admin || !m.hidden) && m.capabilities.output === 'audio' && !!m.capabilities.audio);
  }

  /** The models that make one kind, the person's choice for it first. */
  private async modelsFor(session: ImageSessionFacts, kind: AudioKind): Promise<ImageModelInfo[]> {
    const all = (await this.models(session)).filter((m) => m.capabilities.audio!.kinds.includes(kind));
    const first = (await this.deps.preferred(session.userId, kind)) ?? this.deps.settings().models.defaults[kind];
    return [...all].sort((a, b) => Number(b.ref === first) - Number(a.ref === first));
  }

  /** Whether any sound model can run now: one on a computer that's away can't. */
  async available(session: ImageSessionFacts): Promise<boolean> {
    return (await this.models(session)).some((m) => m.available !== false);
  }

  private async pick(session: ImageSessionFacts, input: GenerateAudioInput): Promise<ResolvedImageModel> {
    const models = await this.modelsFor(session, input.kind);
    if (models.length === 0) {
      const others = [...new Set((await this.models(session)).flatMap((m) => m.capabilities.audio!.kinds))];
      throw new AudioCallError(others.length ? `No model here makes ${kindName(input.kind)}; the sound models here make ${others.map(kindName).join(' and ')}. Tell the person.` : 'No sound model is available. An admin adds one in Settings › Media.');
    }
    const wanted = input.model?.toLowerCase();
    let match: ImageModelInfo | undefined;
    if (wanted) {
      match = models.find((m) => m.ref.toLowerCase() === wanted || m.modelId.toLowerCase() === wanted || m.displayName.toLowerCase() === wanted);
      if (!match) throw new AudioCallError(`There's no ${kindName(input.kind)} model "${input.model}". You can use: ${models.map((m) => m.ref).join(', ')}.`);
    } else {
      const ready = models.filter((m) => m.available !== false);
      // A conversation goes to a model that takes that many voices, when the usual one doesn't.
      const speakers = input.speakers?.length ?? 0;
      match = (speakers >= 2 ? ready.find((m) => (m.capabilities.audio!.maxSpeakers ?? 1) >= speakers) : undefined) ?? ready[0] ?? models[0];
    }
    return this.deps.registry.resolve(match!.ref, { admin: await this.deps.isAdmin(session.userId), userId: session.userId });
  }

  /** Makes one short real sound from a provider that may not be saved yet, for the Test button: a sentence, or a few seconds. */
  async trySound(draft: ImageProviderDraft, modelId: string | undefined): Promise<{ blob: string; mime: string; seconds: number | null; kind: AudioKind; text: string; durationMs: number }> {
    const started = Date.now();
    const { adapter } = await this.deps.registry.draftAdapter(draft);
    const models = (await adapter.listModels(AbortSignal.timeout(20_000))).filter((m) => m.capabilities.output === 'audio' && !!m.capabilities.audio);
    const model = models.find((m) => m.modelId === modelId) ?? models[0];
    if (!model) throw new Error(`${draft.name} has no sound models to try.`);
    const audio = model.capabilities.audio!;
    const kind = audio.kinds[0]!;
    const text = kind === 'speech' ? 'Hello! This is a short test of how this voice sounds.' : kind === 'music' ? 'A calm, warm piano melody' : 'A single soft knock on a wooden door';
    const fit = fitAudio(model.capabilities, { kind, text, seconds: kind === 'music' ? 5 : 2 });
    const seconds = audio.durations && fit.seconds !== undefined ? fitSeconds(audio.durations, fit.seconds) : fit.seconds;
    const signal = AbortSignal.timeout(5 * 60_000);
    const request: ImageRequest = {
      model: model.modelId,
      prompt: text,
      count: 1,
      quality: 'draft',
      references: [],
      tuning: {},
      loras: [],
      capabilities: model.capabilities,
      signal,
      audio: { kind, ...(fit.voice ? { voice: fit.voice } : {}), ...(seconds !== undefined ? { seconds } : {}), ...(kind === 'music' ? { instrumental: true } : {}) },
    };
    let sound: Extract<ImageEvent, { type: 'audio' }> | undefined;
    for await (const event of adapter.generate(request)) {
      if (event.type === 'audio') sound ??= event;
      else if (event.type === 'finish') {
        if (!sound) throw new Error(event.error?.message ?? `${draft.name} made no sound.`);
        break;
      }
    }
    if (!sound) throw new Error(`${draft.name} made no sound.`);
    let fetched: DownloadedAudio;
    if (sound.bytes) {
      const bytes = isPcm(sound.mime) ? pcmToWav(sound.bytes, pcmRate(sound.mime!)) : sound.bytes;
      fetched = { bytes, mime: checkAudio(bytes) };
    } else fetched = await this.deps.download(sound.url!, signal);
    const { sha256: blob } = await this.deps.blobs.put(fetched.bytes, fetched.mime);
    return { blob, mime: fetched.mime, seconds: audioFacts(fetched.bytes).seconds ?? null, kind, text, durationMs: Date.now() - started };
  }

  /** The models as the text model reads them: what each makes, its voices and what else it takes. */
  async modelList(session: ImageSessionFacts): Promise<string> {
    const overrides = this.deps.settings().imageModels.overrides;
    const firsts = new Map<AudioKind, string | undefined>();
    for (const kind of ['speech', 'music', 'sound'] as const) firsts.set(kind, (await this.deps.preferred(session.userId, kind)) ?? this.deps.settings().models.defaults[kind]);
    return (await this.models(session))
      .filter((m) => m.available !== false)
      .map((m) => {
        const audio = m.capabilities.audio!;
        const usual = audio.kinds.filter((k) => firsts.get(k) === m.ref);
        const traits: string[] = [audio.kinds.map(kindName).join(', ') + (usual.length ? ` (the person's choice for ${usual.map(kindName).join(' and ')})` : '')];
        if (audio.kinds.includes('speech')) {
          if (audio.direction) traits.push('takes directions for how to speak');
          if (audio.maxSpeakers && audio.maxSpeakers > 1) traits.push(`up to ${audio.maxSpeakers} speakers in one call`);
          if (audio.maxChars) traits.push(`at most ${audio.maxChars} characters a call`);
          if (audio.speed) traits.push('takes a speed');
        }
        if (audio.kinds.some((k) => k !== 'speech')) {
          traits.push(audio.durations ? `${describeDurations(audio.durations)}${audio.defaultSeconds ? `, usually ${audio.defaultSeconds}` : ''}` : 'the model chooses the length');
          if (audio.kinds.includes('music')) traits.push(audio.vocals === 'none' ? 'instrumental only' : audio.vocals === 'always' ? (audio.lyrics ? 'always sings, takes lyrics' : 'always sings') : audio.lyrics ? 'sings lyrics, or instrumental' : 'vocals or instrumental, writes its own words');
          if (m.capabilities.negativePrompt) traits.push('takes a negative prompt');
        }
        if (audio.languages?.length) traits.push(audio.languages.length > 12 ? `${audio.languages.length} languages` : audio.languages.join('/'));
        const line = `- ${m.ref} (${m.displayName}${m.description ? `, ${m.description}` : ''}): ${traits.join('; ')}`;
        if (!audio.voices?.length) return audio.kinds.includes('speech') ? `${line}; voice: ${audio.defaultVoice ?? 'its own'}${audio.defaultVoice ? ' (any voice name the service knows works)' : ''}` : line;
        const usualVoice = overrides[m.ref]?.audio?.voice ?? audio.defaultVoice;
        const voices = [...audio.voices].sort((a, b) => Number(b.id === usualVoice) - Number(a.id === usualVoice)).slice(0, VOICES_IN_NOTE);
        const listed = voices.map((v) => `${v.id}${v.name !== v.id ? ` (${v.name}${v.description ? `: ${v.description}` : ''})` : v.description ? ` (${v.description})` : ''}${v.id === usualVoice ? ' [usual]' : ''}`);
        const more = audio.voices.length - voices.length;
        return `${line}\n  voices: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
      })
      .join('\n');
  }

  /** Keeps to the limits; throws what the model should tell the person. */
  private async checkLimits(sessionId: string, userId: string | null): Promise<void> {
    const { maxAudioPerUserPerDay, maxAudioSpendPerUserPerDayUsd } = this.deps.settings().imageGeneration;
    const maxPerTurn = this.deps.settings().imageGeneration.maxAudioPerTurn ?? DEFAULT_AUDIO_PER_TURN;
    const since = await this.deps.turnStart(sessionId);
    const turn = this.turns.get(sessionId);
    const made = turn?.since === since ? turn.count : 0;
    if (made + 1 > maxPerTurn) throw new AudioCallError(`That's the limit of ${maxPerTurn} ${maxPerTurn === 1 ? 'sound' : 'sounds'} in one turn. Stop here and tell the person; they can ask for more in their next message.`);
    if (userId && (maxAudioPerUserPerDay !== undefined || maxAudioSpendPerUserPerDayUsd !== undefined)) {
      const midnight = new Date().setUTCHours(0, 0, 0, 0);
      const today = this.deps.db
        .select({ count: sql<number>`coalesce(sum(${usageEvents.audios}), 0)`, cost: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)` })
        .from(usageEvents)
        .where(and(eq(usageEvents.userId, userId), gte(usageEvents.ts, midnight), gte(usageEvents.audios, 1)))
        .get();
      if (maxAudioPerUserPerDay !== undefined && (today?.count ?? 0) + (this.underWay.get(userId) ?? 0) + 1 > maxAudioPerUserPerDay) throw new AudioCallError(`This account has reached its limit of ${maxAudioPerUserPerDay} sounds a day. Tell the person; an admin can change it.`);
      if (maxAudioSpendPerUserPerDayUsd !== undefined && (today?.cost ?? 0) >= maxAudioSpendPerUserPerDayUsd) throw new AudioCallError(`This account has reached its limit of $${maxAudioSpendPerUserPerDayUsd} of sound a day. Tell the person; an admin can change it.`);
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

  async generate(input: GenerateAudioInput, ctx: ToolContext): Promise<ToolOutput> {
    const started = Date.now();
    let reserved = false;
    let underWay = false;
    let userId: string | null = null;
    try {
      if (input.kind === 'speech' && !input.text?.trim()) throw new AudioCallError('Speech needs `text`: exactly the words to say.');
      if (input.kind !== 'speech' && !input.prompt?.trim()) throw new AudioCallError(`${input.kind === 'music' ? 'Music' : 'A sound effect'} needs \`prompt\`: what it should sound like.`);
      const session = await this.deps.session(ctx.sessionId);
      userId = session.userId;
      const model = await this.pick(session, input);
      const ask: AudioAsk = {
        kind: input.kind,
        text: input.text,
        voice: input.voice,
        speakers: input.speakers,
        direction: input.direction,
        speed: input.speed,
        language: input.language,
        seconds: input.seconds,
        lyrics: input.lyrics,
        instrumental: input.instrumental,
        seed: input.seed,
        negativePrompt: input.negative_prompt,
      };
      const fit = fitAudio(model.info.capabilities, ask, this.deps.settings().imageModels.overrides[model.info.ref]?.audio);
      await this.checkLimits(ctx.sessionId, session.userId);
      reserved = true;
      underWay = true;

      const progress = createProgressReporter(ctx, { kind: 'audio', audioKind: input.kind, count: 1, ...(fit.seconds ? { seconds: fit.seconds } : {}) });
      progress.update({}, true);
      const release = await this.deps.registry.hold(model, ctx.signal, { onWait: (ahead) => progress.update({ phase: 'queued', ...(ahead !== null ? { ahead } : {}) }, true), owner: ctx.sessionId });
      try {
        const { sound, finish, usage } = await this.run(model, input, fit, ctx, progress);
        if (finish.reason === 'aborted' || ctx.signal.aborted) throw ctx.signal.reason ?? new Error('Stopped.');
        if (!sound) {
          if (finish.reason === 'refused') return textOutput(`${finish.error?.message ?? `${model.config.name} refused this.`} That is final: tell the person, and don't reword the request to get past it.`, true);
          return textOutput(finish.error?.message ?? `${model.config.name} made no sound.`, true);
        }
        // Made, and likely billed: it counts for the turn even if it can't be kept, so a model can't loop on a format Atelier refuses.
        reserved = false;
        progress.update({ phase: 'finishing' }, true);
        const stored = await this.store(sound, input, model, session, ctx, { fit, usage, started });
        progress.update({ images: [stored] }, true);
        this.deps.recordUsage({
          providerId: model.info.providerId,
          modelId: model.info.modelId,
          sessionId: ctx.sessionId,
          userId: session.userId,
          mode: session.mode,
          seconds: stored.seconds ?? 0,
          chars: input.kind === 'speech' ? (input.text ?? '').length : 0,
          costUsd: stored.costUsd ?? null,
          costEstimated: stored.costEstimated ?? false,
          durationMs: stored.durationMs ?? 0,
        });
        return resultOutput(stored, model, fit, Date.now() - started);
      } finally {
        if (model.config.freeAfterRun) await model.adapter.free?.(AbortSignal.timeout(15_000)).catch(() => undefined);
        release();
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      if (error instanceof AudioCallError || error instanceof AudioAskError || error instanceof ImageModelUnavailable) return textOutput(error.message, true);
      throw error;
    } finally {
      if (reserved) this.release(ctx.sessionId);
      if (underWay) this.settle(userId);
    }
  }

  private async run(model: ResolvedImageModel, input: GenerateAudioInput, fit: FittedAudio, ctx: ToolContext, progress: ProgressReporter) {
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
      prompt: subject(input),
      count: 1,
      quality: 'standard',
      references: [],
      tuning: this.deps.settings().imageModels.overrides[model.info.ref]?.tuning ?? {},
      loras: [],
      capabilities: model.info.capabilities,
      signal: AbortSignal.any([ctx.signal, idle.signal, AbortSignal.timeout(TOTAL_MS)]),
      audio: {
        kind: fit.kind,
        ...(fit.voice ? { voice: fit.voice } : {}),
        ...(fit.speakers ? { speakers: fit.speakers } : {}),
        ...(fit.direction ? { direction: fit.direction } : {}),
        ...(fit.speed !== undefined ? { speed: fit.speed } : {}),
        ...(fit.language ? { language: fit.language } : {}),
        ...(fit.seconds !== undefined ? { seconds: fit.seconds } : {}),
        ...(fit.lyrics ? { lyrics: fit.lyrics } : {}),
        ...(fit.instrumental ? { instrumental: true } : {}),
      },
      ...(fit.negativePrompt ? { negativePrompt: fit.negativePrompt } : {}),
      ...(fit.seed !== undefined ? { seed: fit.seed } : {}),
    };
    let sound: Extract<ImageEvent, { type: 'audio' }> | undefined;
    let finish: Extract<ImageEvent, { type: 'finish' }> = { type: 'finish', reason: 'error', error: { code: 'stream_truncated', message: `${model.config.name} stopped without an answer.`, retryable: true } };
    try {
      for await (const event of model.adapter.generate(request)) {
        touch();
        if (event.type === 'queued') progress.update({ phase: 'queued', ahead: event.ahead }, true);
        else if (event.type === 'loading') progress.update({ phase: 'loading' }, true);
        else if (event.type === 'progress') {
          progress.update({ phase: 'generating', ...(event.step !== undefined ? { step: event.step } : {}), ...(event.steps !== undefined ? { steps: event.steps } : {}), ...(event.fraction !== undefined ? { fraction: event.fraction } : {}), ...(event.etaMs !== undefined ? { etaMs: event.etaMs } : {}) });
        } else if (event.type === 'audio') sound ??= event;
        else if (event.type === 'usage') usage.costUsd = event.costUsd ?? usage.costUsd;
        else if (event.type === 'finish') {
          finish = event;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    return { sound, finish, usage };
  }

  private async store(sound: Extract<ImageEvent, { type: 'audio' }>, input: GenerateAudioInput, model: ResolvedImageModel, session: ImageSessionFacts, ctx: ToolContext, facts: { fit: FittedAudio; usage: { costUsd?: number }; started: number }): Promise<GeneratedImageMeta> {
    const durationMs = Date.now() - facts.started;
    let fetched: DownloadedAudio;
    if (sound.bytes) {
      // Raw samples have no header to say what they are; the service's type does, and they become a WAV.
      const bytes = isPcm(sound.mime) ? pcmToWav(sound.bytes, pcmRate(sound.mime!)) : sound.bytes;
      fetched = { bytes, mime: checkAudio(bytes) };
    } else fetched = await this.deps.download(sound.url!, ctx.signal, model.personal?.fetch);
    const { sha256: blob } = await this.deps.blobs.put(fetched.bytes, fetched.mime);
    const file = audioFacts(fetched.bytes);
    const seconds = file.seconds ?? facts.fit.seconds;
    const chars = input.kind === 'speech' ? (input.text ?? '').length : undefined;
    const cost = soundCost(this.deps.settings(), model, facts.usage, { seconds, chars });
    const words = subject(input);
    await this.deps.files.addGenerated({ name: fileName(words, blob, AUDIO_EXTENSIONS[fetched.mime][0]!), mime: fetched.mime, blob, size: fetched.bytes.byteLength, userId: session.userId, sessionId: ctx.sessionId, messageId: ctx.messageId });
    const { fit } = facts;
    const voice = fit.speakers ? fit.speakers.map((s) => `${s.name}: ${s.voice}`).join(', ') : fit.voiceName;
    await this.deps.db.insert(generatedImages).values({
      id: randomUUID(),
      userId: session.userId,
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      callId: ctx.callId,
      blob,
      mime: fetched.mime,
      size: fetched.bytes.byteLength,
      width: 0,
      height: 0,
      kind: 'audio',
      mediaSeconds: seconds ?? null,
      fps: null,
      audio: true,
      prompt: words,
      negativePrompt: fit.negativePrompt ?? null,
      providerId: model.info.providerId,
      modelId: model.info.modelId,
      modelName: model.info.displayName,
      params: { audioKind: fit.kind, voice: fit.voice, voiceName: fit.voiceName, speakers: fit.speakers, direction: fit.direction, speed: fit.speed, language: fit.language, seconds: fit.seconds, lyrics: fit.lyrics, instrumental: fit.instrumental },
      seed: sound.seed ?? fit.seed ?? null,
      costUsd: cost?.usd ?? null,
      costEstimated: cost?.estimated ?? false,
      durationMs,
      hidden: session.temporary,
      createdAt: Date.now(),
    });
    const seed = sound.seed ?? fit.seed;
    return {
      id: audioId(blob),
      blob,
      mime: fetched.mime,
      width: 0,
      height: 0,
      kind: 'audio',
      audioKind: fit.kind,
      prompt: words,
      ref: model.info.ref,
      modelName: model.info.displayName,
      durationMs,
      ...(seconds !== undefined ? { seconds } : {}),
      ...(voice ? { voice } : {}),
      ...(fit.direction ? { direction: fit.direction } : {}),
      ...(fit.lyrics ? { lyrics: fit.lyrics } : {}),
      ...(fit.negativePrompt ? { negativePrompt: fit.negativePrompt } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(cost ? { costUsd: cost.usd, costEstimated: cost.estimated } : {}),
    };
  }
}

/** The cost of a sound: what the service reported, else the admin's price, else a list price. A person's own server costs nothing here. */
function soundCost(settings: Settings, model: ResolvedImageModel, usage: { costUsd?: number }, facts: { seconds?: number | undefined; chars?: number | undefined }): { usd: number; estimated: boolean } | null {
  if (usage.costUsd !== undefined) return { usd: usage.costUsd, estimated: false };
  if (model.personal) return null;
  const price = settings.imagePricing[model.info.ref] ?? listAudioPrice(model.info.modelId);
  if (!price) return null;
  const usd = audioCost(price, facts);
  return usd === null ? null : { usd, estimated: true };
}

const NOUNS: Record<AudioKind, string> = { speech: 'speech', music: 'music', sound: 'a sound effect' };

function resultOutput(stored: GeneratedImageMeta, model: ResolvedImageModel, fit: FittedAudio, totalMs: number): ToolOutput {
  const facts = [...(stored.voice ? [`voice ${stored.voice}`] : []), ...(stored.seconds !== undefined ? [`${round1(stored.seconds)} s`] : []), ...(fit.instrumental ? ['instrumental'] : []), ...(stored.seed !== undefined ? [`seed ${stored.seed}`] : []), `made in ${wholeSeconds(totalMs)} s`];
  const lines = [`Generated ${NOUNS[fit.kind]} with ${model.info.displayName} (${facts.join(', ')}): ${stored.id}. It's on screen for the person to play: don't repeat it, link to it or describe it unless asked. You can't hear it.`];
  if (fit.notes.length) lines.push(fit.notes.join(' '));
  // No audio part: the text model would only fill its context with a sound it can't use here.
  return { content: [{ type: 'text', text: lines.join('\n') }], generated: [stored] };
}
