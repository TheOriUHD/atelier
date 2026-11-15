/**
 * Dictation (ARCHITECTURE §27): the message box's microphone. A window records the person's voice and sends it as 16 kHz
 * mono 16-bit PCM to its backend, which passes it to a speech-to-text service of the providers set up there (the keys
 * never leave the backend) and sends the words back as they are recognised.
 */
import { z } from 'zod';

/** What a window sends: 16-bit little-endian PCM, one channel, this many samples a second. */
export const DICTATION_SAMPLE_RATE = 16_000;
/** The longest one dictation runs before it stops by itself. */
export const DICTATION_MAX_MS = 10 * 60_000;
/** One `dictation.audio` call: up to two seconds of audio, as base64. */
export const DICTATION_CHUNK_MAX_BYTES = DICTATION_SAMPLE_RATE * 2 * 2;

/** `auto` lets the service hear which language it is; otherwise an ISO 639-1 code. */
export const DictationLanguage = z.string().regex(/^(auto|[a-z]{2})$/, 'A two-letter language code, or auto');
export type DictationLanguage = z.infer<typeof DictationLanguage>;

export interface DictationLanguageInfo {
  code: string;
  /** In English, as the list shows it. */
  label: string;
  /** In the language itself, which the search also matches. */
  native: string;
}

/**
 * The languages the menu offers, most spoken first. The services (Voxtral, Whisper, GPT-4o Transcribe, Scribe, Nova)
 * hear all of these; one that doesn't says so when dictation starts.
 */
export const DICTATION_LANGUAGES: readonly DictationLanguageInfo[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'zh', label: 'Chinese', native: '中文' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'ar', label: 'Arabic', native: 'العربية' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'ko', label: 'Korean', native: '한국어' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands' },
  { code: 'pl', label: 'Polish', native: 'Polski' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'th', label: 'Thai', native: 'ไทย' },
  { code: 'sv', label: 'Swedish', native: 'Svenska' },
  { code: 'da', label: 'Danish', native: 'Dansk' },
  { code: 'no', label: 'Norwegian', native: 'Norsk' },
  { code: 'fi', label: 'Finnish', native: 'Suomi' },
  { code: 'cs', label: 'Czech', native: 'Čeština' },
  { code: 'sk', label: 'Slovak', native: 'Slovenčina' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar' },
  { code: 'ro', label: 'Romanian', native: 'Română' },
  { code: 'bg', label: 'Bulgarian', native: 'Български' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά' },
  { code: 'he', label: 'Hebrew', native: 'עברית' },
  { code: 'fa', label: 'Persian', native: 'فارسی' },
  { code: 'ur', label: 'Urdu', native: 'اردو' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu' },
  { code: 'tl', label: 'Tagalog', native: 'Tagalog' },
  { code: 'sw', label: 'Swahili', native: 'Kiswahili' },
  { code: 'ca', label: 'Catalan', native: 'Català' },
  { code: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { code: 'sr', label: 'Serbian', native: 'Српски' },
  { code: 'sl', label: 'Slovenian', native: 'Slovenščina' },
  { code: 'lt', label: 'Lithuanian', native: 'Lietuvių' },
  { code: 'lv', label: 'Latvian', native: 'Latviešu' },
  { code: 'et', label: 'Estonian', native: 'Eesti' },
  { code: 'is', label: 'Icelandic', native: 'Íslenska' },
  { code: 'ga', label: 'Irish', native: 'Gaeilge' },
  { code: 'cy', label: 'Welsh', native: 'Cymraeg' },
  { code: 'af', label: 'Afrikaans', native: 'Afrikaans' },
];

/** The menu's name for a language setting. */
export function dictationLanguageLabel(code: string | undefined): string {
  if (!code || code === 'auto') return 'Auto';
  return DICTATION_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

/** A speech-to-text service the backend can dictate with: one model of one of its providers. */
export const DictationSource = z.object({
  /** `text:<provider id>:<model>` or `media:<provider id>:<model>`. */
  id: z.string(),
  /** The model, as people know it ("Voxtral Realtime"). */
  label: z.string(),
  /** The provider's name in Settings. */
  provider: z.string(),
  /** Words appear while the person speaks; otherwise a phrase at a time, at each pause. */
  live: z.boolean(),
});
export type DictationSource = z.infer<typeof DictationSource>;

export const DictationStatus = z.object({
  /** An admin can turn dictation off for everyone (Settings › General › Dictation). */
  enabled: z.boolean(),
  /** What dictating uses now; null when no provider offers speech-to-text. */
  source: DictationSource.nullable(),
  /** Admins: every service to choose from. Others: none. */
  sources: z.array(DictationSource),
  /** The admin's choice by id; null picks one by itself. */
  chosen: z.string().nullable(),
});
export type DictationStatus = z.infer<typeof DictationStatus>;

export const DictationId = z.string().min(1).max(100);

export const DictationStart = z.object({
  language: DictationLanguage,
  /** Words the service should expect (the project's name, file names): it spells them as given. */
  hints: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});
export type DictationStart = z.infer<typeof DictationStart>;

export const DictationAudio = z.object({
  id: DictationId,
  /** 0, 1, 2…: the backend puts calls that overtook each other back in order. */
  seq: z.number().int().min(0).max(1_000_000),
  /** base64 of 16 kHz mono s16le PCM. */
  pcm: z.string().max(Math.ceil(DICTATION_CHUNK_MAX_BYTES / 3) * 4),
});

/** Sent to the window that dictates: everything heard so far (its end may still change), or why it stopped. */
export const DictationUpdate = z.object({
  id: z.string(),
  text: z.string(),
  error: z.string().optional(),
});
export type DictationUpdate = z.infer<typeof DictationUpdate>;
