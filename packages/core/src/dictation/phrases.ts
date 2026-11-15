/**
 * Dictation through a service that transcribes whole recordings (OpenAI's /v1/audio/transcriptions and its copies,
 * ElevenLabs, Deepgram): the audio is cut into phrases at the speaker's pauses. While a phrase is being said, what was
 * said of it so far is transcribed again every second or two, so the words still appear as they are spoken; at the
 * pause it is transcribed once more, for good. Silence is never sent (Whisper makes up words for it).
 */
import { DICTATION_SAMPLE_RATE } from '@atelier/protocol';
import { joinText, type DictationEngine, type EngineEvents } from './engine.ts';

export interface PhraseOptions extends EngineEvents {
  /** Transcribes one phrase (a WAV file), given what was said before it for context. */
  transcribe(wav: Uint8Array, before: string, signal: AbortSignal): Promise<string>;
  /** For tests: the length of a pause that ends a phrase, and the longest phrase. */
  pauseMs?: number;
  maxPhraseMs?: number;
}

const BYTES_PER_MS = (DICTATION_SAMPLE_RATE * 2) / 1000;
/** Loudness is judged 20 ms at a time. */
const FRAME_MS = 20;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;
/** Audio kept before the first spoken frame, so the first word isn't clipped. */
const PREROLL_MS = 300;
/** A phrase needs this much speech in it to be sent at all (a cough, a click). */
const MIN_SPEECH_MS = 200;

/** A WAV file of 16 kHz mono s16le PCM. */
export function wavOf(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true);
  view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** Root mean square of one frame of s16le samples, 0 to 32768. */
function loudness(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let sum = 0;
  const n = Math.floor(frame.byteLength / 2);
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

interface Phrase {
  /** Frames of this phrase, in order. */
  frames: Uint8Array[];
  levels: number[];
  speechFrames: number;
  /** Trailing frames without speech. */
  quietFrames: number;
  /** The newest transcript of it, while it is still being said or being transcribed for good. */
  heard: string;
  /** Frames it had at the last look, to transcribe again only when it grew. */
  lookedAt: number;
}

const freshPhrase = (): Phrase => ({ frames: [], levels: [], speechFrames: 0, quietFrames: 0, heard: '', lookedAt: 0 });

const concat = (frames: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.byteLength;
  }
  return out;
};

export function openPhrases(options: PhraseOptions): DictationEngine {
  const pauseFrames = Math.round((options.pauseMs ?? 700) / FRAME_MS);
  const maxFrames = Math.round((options.maxPhraseMs ?? 25_000) / FRAME_MS);
  const controller = new AbortController();
  /** Phrases transcribed for good. */
  const done: string[] = [];
  /** Phrases said, waiting for their final transcript, oldest first. */
  const closing: Phrase[] = [];
  let current = freshPhrase();
  let partial = new Uint8Array(0);
  /** The quietest level heard lately: speech is well above it. */
  let floor = 60;
  let looking = false;
  /** Frames heard in all, and until which frame looks wait after one failed (a rate limit). */
  let heardFrames = 0;
  let looksFrom = 0;
  let lookFailures = 0;
  let finals: Promise<void> = Promise.resolve();
  let over = false;
  let failure: string | null = null;

  const shown = () => [...done, ...closing.map((p) => p.heard), current.heard].reduce(joinText, '');
  const emit = () => {
    if (!over) options.onText(shown());
  };
  const before = () => done.join(' ').slice(-400);

  const fail = (message: string) => {
    if (failure || over) return;
    failure = message;
    over = true;
    controller.abort();
    options.onError(message);
  };

  /** A look at the phrase being said: transcribed so far, shown, and replaced by the next look. */
  const look = () => {
    // Not while a phrase is being transcribed for good: that one counts more, and a service's rate limit is shared.
    if (looking || over || closing.length || heardFrames < looksFrom) return;
    const phrase = current;
    if (phrase.speechFrames * FRAME_MS < MIN_SPEECH_MS) return;
    // Every second at first, less often as the phrase grows: each look sends all of it.
    const every = phrase.frames.length < 250 ? 50 : phrase.frames.length < 500 ? 75 : 125;
    if (phrase.frames.length - phrase.lookedAt < every) return;
    phrase.lookedAt = phrase.frames.length;
    looking = true;
    options
      .transcribe(wavOf(concat(phrase.frames)), before(), controller.signal)
      .then((text) => {
        lookFailures = 0;
        // A look that ends after its phrase was transcribed for good is too late.
        if (phrase === current || closing.includes(phrase)) {
          phrase.heard = text.trim();
          emit();
        }
      })
      // A look that fails is only a look: the final transcript says whether the service works. The next waits longer.
      .catch(() => {
        lookFailures++;
        looksFrom = heardFrames + Math.min(150 * 2 ** (lookFailures - 1), 500);
      })
      .finally(() => {
        looking = false;
      });
  };

  /** Ends the phrase being said and transcribes it for good, after the ones before it. */
  const close = (cut = current.frames.length) => {
    const phrase = current;
    const rest = phrase.frames.splice(cut);
    // Cut mid-phrase at its quietest moment: all of what is left of it counts.
    if (rest.length) phrase.quietFrames = 0;
    current = freshPhrase();
    for (const frame of rest) hear(frame);
    if (phrase.speechFrames * FRAME_MS < MIN_SPEECH_MS) return;
    // The silence it ended with stays out, but for a little after the last word.
    const keep = Math.max(phrase.frames.length - phrase.quietFrames + Math.round(PREROLL_MS / FRAME_MS), 0);
    const audio = wavOf(concat(phrase.frames.slice(0, keep)));
    closing.push(phrase);
    finals = finals.then(async () => {
      if (over) return;
      let text: string | null = null;
      for (let attempt = 0; text === null && !over; attempt++) {
        try {
          text = await options.transcribe(audio, before(), controller.signal);
        } catch (e) {
          const { status, retryAfterMs } = e as { status?: number; retryAfterMs?: number };
          // A rate limit, the service's own trouble or the network: three more tries, waiting longer each time.
          const passing = status === undefined || status === 429 || status >= 500;
          if (attempt >= (passing ? 3 : 1)) {
            fail(e instanceof Error ? e.message : 'The transcription failed.');
            break;
          }
          await new Promise((r) => setTimeout(r, retryAfterMs ?? (status === 429 ? 1500 * 2 ** attempt : 400)));
        }
      }
      closing.splice(closing.indexOf(phrase), 1);
      if (text !== null && text.trim()) done.push(text.trim());
      emit();
    });
  };

  /** One 20 ms frame of audio. */
  function hear(frame: Uint8Array) {
    heardFrames++;
    const level = loudness(frame);
    const speech = level > Math.max(floor * 3, 250);
    // The floor follows quiet stretches down quickly and up slowly (a fan turned on).
    floor = speech ? floor : level < floor ? floor * 0.9 + level * 0.1 : floor * 0.995 + level * 0.005;
    const phrase = current;
    phrase.frames.push(frame);
    phrase.levels.push(level);
    if (speech) {
      phrase.speechFrames++;
      phrase.quietFrames = 0;
    } else phrase.quietFrames++;
    if (!phrase.speechFrames) {
      // Nothing said yet: only the last moment before the first word is kept.
      const preroll = Math.round(PREROLL_MS / FRAME_MS);
      if (phrase.frames.length > preroll) {
        phrase.frames.shift();
        phrase.levels.shift();
        phrase.quietFrames = Math.min(phrase.quietFrames, preroll);
      }
      return;
    }
    if (phrase.quietFrames >= pauseFrames) close();
    else if (phrase.frames.length >= maxFrames) {
      // Too long without a pause: cut at the quietest moment of its last two seconds.
      const from = Math.max(phrase.frames.length - 100, 1);
      let cut = from;
      for (let i = from; i < phrase.levels.length; i++) if (phrase.levels[i]! < phrase.levels[cut]!) cut = i;
      close(cut);
    }
  }

  return {
    write(pcm) {
      if (over) return;
      const all = partial.byteLength ? concat([partial, pcm]) : pcm;
      let at = 0;
      for (; at + FRAME_BYTES <= all.byteLength; at += FRAME_BYTES) hear(all.slice(at, at + FRAME_BYTES));
      partial = all.slice(at);
      look();
    },
    async finish() {
      if (!over) {
        if (partial.byteLength) current.frames.push(partial);
        partial = new Uint8Array(0);
        close();
      }
      await finals;
      if (failure) throw new Error(failure);
      over = true;
      controller.abort();
      return done.reduce(joinText, '');
    },
    abort() {
      over = true;
      controller.abort();
    },
  };
}
