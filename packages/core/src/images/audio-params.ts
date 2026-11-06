/**
 * Fits what the text model asked for a sound to what the sound model takes (ARCHITECTURE §23), as `video-params.ts` does
 * for clips: the voice by id or name, a conversation's speakers, direction, speed, length, lyrics and vocals. Whatever
 * a model can't do is dropped and said, so one tool call works everywhere; what can't be dropped without changing what
 * the person gets (too much text, too many speakers) is an error the model reads and works around.
 */
import type { AudioCapabilities, AudioKind, AudioVoice, ImageCapabilities } from '@atelier/protocol';
import type { AudioSpeaker } from './types.ts';
import { describeDurations, fitSeconds } from './video-params.ts';

export interface AudioAsk {
  kind: AudioKind;
  /** Speech: the words, which decide whether the text fits. */
  text?: string | undefined;
  voice?: string | undefined;
  speakers?: readonly AudioSpeaker[] | undefined;
  direction?: string | undefined;
  speed?: number | undefined;
  language?: string | undefined;
  seconds?: number | undefined;
  lyrics?: string | undefined;
  instrumental?: boolean | undefined;
  seed?: number | undefined;
  negativePrompt?: string | undefined;
}

/** What a person set for one model, used when the call says nothing. */
export interface AudioDefaults {
  voice?: string | undefined;
  seconds?: number | undefined;
}

export interface FittedAudio {
  kind: AudioKind;
  /** The voice's id as the service takes it, and its name for the person. */
  voice?: string;
  voiceName?: string;
  speakers?: AudioSpeaker[];
  direction?: string;
  speed?: number;
  language?: string;
  seconds?: number;
  lyrics?: string;
  instrumental?: boolean;
  seed?: number;
  negativePrompt?: string;
  /** What was changed or left out, for the text model to read. */
  notes: string[];
}

/** A request the model can't take as it is; the message says how to change it. */
export class AudioAskError extends Error {}

export class NotASoundModel extends Error {}

const KIND_NAMES: Record<AudioKind, string> = { speech: 'speech', music: 'music', sound: 'sound effects' };
export const kindName = (kind: AudioKind): string => KIND_NAMES[kind];

/** The model's sound side, or an error: callers hold another kind of model by mistake only if a registry is wrong. */
export function audioOf(capabilities: ImageCapabilities): AudioCapabilities {
  if (capabilities.output !== 'audio' || !capabilities.audio) throw new NotASoundModel('That model makes pictures, not sound.');
  return capabilities.audio;
}

/** The voice a name or id stands for, ignoring case; a voice's name may be asked for as well as its id. */
export function findVoice(voices: readonly AudioVoice[] | undefined, wanted: string | undefined): AudioVoice | undefined {
  if (!voices?.length || !wanted) return undefined;
  const want = wanted.trim().toLowerCase();
  return voices.find((v) => v.id.toLowerCase() === want) ?? voices.find((v) => v.name.toLowerCase() === want) ?? voices.find((v) => v.name.toLowerCase().split(/\s+[-–(]/)[0] === want);
}

/** The voice used when nothing fits: the person's, then the model's own, then the first it lists. */
function defaultVoice(audio: AudioCapabilities, defaults: AudioDefaults): AudioVoice | { id: string; name: string } | undefined {
  const own = findVoice(audio.voices, defaults.voice) ?? findVoice(audio.voices, audio.defaultVoice);
  if (own) return own;
  if (audio.voices?.length) return audio.voices[0];
  const id = defaults.voice ?? audio.defaultVoice;
  return id ? { id, name: id } : undefined;
}

/** A speaking rate the services take: half to twice as fast covers what people ask for. */
const SPEED_RANGE = [0.5, 2] as const;

export function fitAudio(capabilities: ImageCapabilities, ask: AudioAsk, defaults: AudioDefaults = {}): FittedAudio {
  const audio = audioOf(capabilities);
  const notes: string[] = [];
  if (!audio.kinds.includes(ask.kind)) throw new AudioAskError(`This model makes ${audio.kinds.map(kindName).join(' and ')}, not ${kindName(ask.kind)}.`);
  const out: FittedAudio = { kind: ask.kind, notes };

  if (ask.kind === 'speech') {
    const text = ask.text ?? '';
    if (audio.maxChars && text.length > audio.maxChars) throw new AudioAskError(`The text is ${text.length} characters, and this model reads at most ${audio.maxChars} at once. Split it into parts of up to ${audio.maxChars} characters and make each one, or choose another model.`);
    const speakers = ask.speakers?.filter((s) => s.name.trim()) ?? [];
    if (speakers.length >= 2) {
      const most = audio.maxSpeakers ?? 1;
      if (speakers.length > most) throw new AudioAskError(most === 1 ? 'This model speaks in one voice at a time. Make each speaker’s lines as a call of their own, or choose a model that takes several speakers.' : `This model takes at most ${most} speakers in one call.`);
      out.speakers = speakers.map((s) => {
        const found = findVoice(audio.voices, s.voice);
        if (!found && audio.voices?.length) notes.push(`There's no voice "${s.voice}", so ${s.name} speaks in ${defaultVoice(audio, defaults)?.name ?? 'the usual voice'}.`);
        return { name: s.name.trim(), voice: found?.id ?? (audio.voices?.length ? (defaultVoice(audio, defaults)?.id ?? s.voice) : s.voice) };
      });
    } else {
      const asked = ask.voice ?? speakers[0]?.voice;
      const found = findVoice(audio.voices, asked);
      if (asked && !found && audio.voices?.length) {
        const fallback = defaultVoice(audio, defaults);
        notes.push(`There's no voice "${asked}", so it's ${fallback?.name ?? 'the usual voice'}.`);
      }
      // A service without a list of voices takes the name as it is.
      const voice = found ?? (asked && !audio.voices?.length ? { id: asked, name: asked } : defaultVoice(audio, defaults));
      if (voice) {
        out.voice = voice.id;
        out.voiceName = voice.name;
      }
    }
    if (ask.direction?.trim()) {
      if (audio.direction) out.direction = ask.direction.trim();
      else notes.push('This model takes no directions for how to speak, so they were left out; it reads the words as they are.');
    }
    if (ask.speed !== undefined && ask.speed !== 1) {
      if (audio.speed) out.speed = Math.min(SPEED_RANGE[1], Math.max(SPEED_RANGE[0], ask.speed));
      else notes.push("This model's speaking rate is fixed, so the speed was left out.");
    }
    if (ask.seconds !== undefined) notes.push('Speech is as long as its words, so the length was left out.');
  } else {
    if (audio.durations) {
      const wanted = ask.seconds ?? defaults.seconds ?? audio.defaultSeconds;
      if (wanted !== undefined) {
        out.seconds = fitSeconds(audio.durations, wanted);
        if (ask.seconds !== undefined && out.seconds !== ask.seconds) notes.push(`This model makes ${describeDurations(audio.durations)}, so it's ${out.seconds} seconds.`);
      }
    } else if (ask.seconds !== undefined) notes.push('This model decides how long it is, so the length was left out.');
    if (ask.kind === 'music') {
      const lyrics = ask.lyrics?.trim();
      if (ask.instrumental) {
        if (audio.vocals === 'always') notes.push('This model always sings, so it has vocals.');
        else out.instrumental = true;
      } else if (lyrics) {
        if (audio.vocals === 'none') notes.push('This model makes instrumentals only, so the lyrics were left out.');
        else if (!audio.lyrics) notes.push('This model writes its own words, so the lyrics were left out.');
        else out.lyrics = lyrics;
      }
      // Asked for neither: the model goes by the description, which may ask for a singer and leave the words to it.
    } else if (ask.lyrics?.trim()) notes.push('Sound effects have no words, so the lyrics were left out.');
    if (ask.voice || ask.speakers?.length) notes.push(`${ask.kind === 'music' ? 'Music' : 'A sound effect'} has no voice to choose, so it was left out.`);
  }

  if (ask.language?.trim()) {
    const want = ask.language.trim();
    if (!audio.languages?.length || audio.languages.some((l) => l.toLowerCase() === want.toLowerCase())) out.language = want;
    else notes.push(`This model doesn't list ${want}, so it chose the language itself.`);
  }
  if (ask.seed !== undefined) {
    if (capabilities.seed) out.seed = ask.seed;
    else notes.push("This model can't repeat a result, so the seed was left out.");
  }
  if (ask.negativePrompt?.trim()) {
    if (capabilities.negativePrompt) out.negativePrompt = ask.negativePrompt.trim();
    else notes.push('This model takes no negative prompt, so it was left out.');
  }
  return out;
}
