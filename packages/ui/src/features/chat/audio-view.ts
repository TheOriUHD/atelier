/**
 * What the transcript shows for a GenerateAudio call (design/components.md › GeneratedAudio), worked out from the call, its
 * result and its live progress, as video-view.ts does for clips. The tool's result text is written for the model.
 */
import type { AudioKind, ImageProgress, ToolCallPart, ToolResultPart } from '@atelier/protocol';
import { formatEta, imageFailure, resultText, type ImageFailure, type ShownImage } from './image-view.ts';
import { videoFraction } from './video-view.ts';

/** A finished sound: the stored facts of a `generated` entry of kind audio. */
export type ShownSound = Omit<ShownImage, 'kind'> & { kind: 'audio' };

interface SoundInput {
  kind?: unknown;
  text?: unknown;
  prompt?: unknown;
  voice?: unknown;
  seconds?: unknown;
  speakers?: unknown;
}

const input = (call: Pick<ToolCallPart, 'input'>): SoundInput => (call.input && typeof call.input === 'object' ? (call.input as SoundInput) : {});

/** What the call asked for: speech unless it says otherwise, as speech is the usual ask. */
export function soundKind(call: Pick<ToolCallPart, 'input'>): AudioKind {
  const { kind } = input(call);
  return kind === 'music' || kind === 'sound' ? kind : 'speech';
}

/** The words for speech, the description otherwise: what the line under the card shows. */
export function soundSubject(call: Pick<ToolCallPart, 'input'>): string {
  const { text, prompt } = input(call);
  const value = soundKind(call) === 'speech' ? text : prompt;
  return typeof value === 'string' ? value : '';
}

/** The length asked for, for the status line. */
export function soundSeconds(call: Pick<ToolCallPart, 'input'>): number | undefined {
  const { seconds } = input(call);
  return typeof seconds === 'number' && seconds > 0 ? seconds : undefined;
}

/** The sounds of a call; ahead of the result, what progress says is done. */
export function shownSounds(result: ToolResultPart | undefined, progress?: ImageProgress): ShownSound[] {
  const list = result ? (result.isError ? [] : (result.generated ?? [])) : (progress?.images ?? []);
  return list.filter((g) => g.kind === 'audio') as ShownSound[];
}

export const KIND_LABELS: Record<AudioKind, string> = { speech: 'Speech', music: 'Music', sound: 'Sound effect' };

/** The card's title: what it is, and for speech in which voice. */
export function soundLabel(kind: AudioKind, voice: string | undefined): string {
  return voice && kind === 'speech' ? `${KIND_LABELS.speech} · ${voice}` : KIND_LABELS[kind];
}

const MAKING: Record<AudioKind, string> = { speech: 'Making the speech', music: 'Making the music', sound: 'Making the sound' };

/** The one line that says what's going on while a sound is made. */
export function soundStatus(progress: ImageProgress | undefined, { kind, seconds, waiting }: { kind: AudioKind; seconds: number | undefined; waiting: boolean }): string {
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
      return 'Saving the sound';
    case 'generating': {
      const fraction = videoFraction(progress);
      const where = progress.steps && progress.step !== undefined ? `Step ${Math.min(progress.step, progress.steps)} of ${progress.steps}` : fraction !== undefined ? `${Math.round(fraction * 100)}%` : kind === 'music' && length ? `Making ${Math.round(length)} s of music` : MAKING[kind];
      return progress.etaMs !== undefined ? `${where} · ${formatEta(progress.etaMs)}` : where;
    }
  }
}

export const soundFraction = videoFraction;

const SOUND_SETUP = /^No sound model is available|^No model here makes /;
const FOR_THE_MODEL = [/ That is final: tell the person, and don't reword the request to get past it\.$/, / Tell the person\.$/];

/** Why there is no sound, in the words the person should read. */
export function soundFailure(text: string): ImageFailure {
  const said = FOR_THE_MODEL.reduce((s, sentence) => s.replace(sentence, ''), text.replace(/^GenerateAudio failed: /, ''));
  const failure = imageFailure(said);
  if (failure.kind === 'failed' && SOUND_SETUP.test(failure.text)) return { kind: 'setup', text: failure.text };
  return failure.text === 'The image could not be made.' ? { kind: 'failed', text: 'The sound could not be made.' } : failure;
}

const EXTENSIONS: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm' };

/** A name for a downloaded sound, from what it says; the hash keeps sounds of one prompt apart. */
export function soundFileName(sound: Pick<ShownSound, 'prompt' | 'blob' | 'mime'>): string {
  const slug = sound.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'sound'}-${sound.blob.slice(0, 6)}.${EXTENSIONS[sound.mime] ?? 'mp3'}`;
}

export { resultText };
