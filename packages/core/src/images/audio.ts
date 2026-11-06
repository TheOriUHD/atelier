/**
 * What a generated sound really is (ARCHITECTURE §23). A service decides what comes back, and a sound is played by the
 * page's own player and offered for download, so the bytes must be a format Atelier knows: MP3, WAV, Ogg (Opus or
 * Vorbis), FLAC, AAC on its own or in MP4, or WebM, recognised by their structure and not by what the service called
 * them. The length comes from the file, so the transcript can show it before the sound is loaded.
 */
import type { AudioMime } from '@atelier/protocol';
import { sniffVideo, videoFacts } from './video.ts';

/** The most a sound may weigh. An hour of 48 kHz stereo WAV is about 660 MB; nothing a service makes comes near this one. */
export const MAX_AUDIO_BYTES = 256 * 1024 * 1024;

/** The extensions a sound of each type is saved with, the usual one first. */
export const AUDIO_EXTENSIONS: Record<AudioMime, readonly string[]> = {
  'audio/mpeg': ['mp3'],
  'audio/wav': ['wav'],
  'audio/ogg': ['ogg', 'opus', 'oga'],
  'audio/flac': ['flac'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/aac': ['aac'],
  'audio/webm': ['webm', 'weba'],
};

/** What a person calls each type, in messages. */
export const AUDIO_NAMES: Record<AudioMime, string> = {
  'audio/mpeg': 'an MP3',
  'audio/wav': 'a WAV',
  'audio/ogg': 'an Ogg',
  'audio/flac': 'a FLAC',
  'audio/mp4': 'an M4A',
  'audio/aac': 'an AAC',
  'audio/webm': 'a WebM',
};

export interface AudioFacts {
  mime: AudioMime;
  /** Absent when the file doesn't say. */
  seconds?: number;
  sampleRate?: number;
  channels?: number;
}

const ascii = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, Math.min(bytes.byteLength, at + length)));
const u32le = (bytes: Uint8Array, at: number) => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)) + bytes[at + 3]! * 0x1000000;
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u32be = (bytes: Uint8Array, at: number) => bytes[at]! * 0x1000000 + ((bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!);

// --------------------------------------------------------------------------------------------- MP3 and ADTS

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;
const MP3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Zero bytes some encoders leave after a tag, skipped up to this far. */
const MAX_PADDING = 64 * 1024;

/** Where the audio starts after an ID3v2 tag and any zero padding behind it, or 0. */
function afterId3(bytes: Uint8Array): number {
  if (bytes.byteLength < 10 || ascii(bytes, 0, 3) !== 'ID3') return 0;
  // A syncsafe size: seven bits a byte. A footer adds ten more.
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  let at = 10 + size + (bytes[5]! & 0x10 ? 10 : 0);
  const limit = Math.min(bytes.byteLength, at + MAX_PADDING);
  while (at < limit && bytes[at] === 0) at++;
  return at;
}

interface Mp3Frame {
  version: number;
  sampleRate: number;
  kbps: number;
  channels: number;
  samples: number;
}

/** An MPEG-1/2/2.5 Layer III frame header at `at`, or null. */
function mp3Frame(bytes: Uint8Array, at: number): Mp3Frame | null {
  if (at + 4 > bytes.byteLength || bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1]! >> 3) & 3;
  const layer = (bytes[at + 1]! >> 1) & 3;
  const bitrate = bytes[at + 2]! >> 4;
  const rate = (bytes[at + 2]! >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rate === 3) return null;
  return { version, sampleRate: MP3_RATES[version]![rate]!, kbps: (version === 3 ? MP3_KBPS_V1 : MP3_KBPS_V2)[bitrate]!, channels: bytes[at + 3]! >> 6 === 3 ? 1 : 2, samples: version === 3 ? 1152 : 576 };
}

/** An AAC frame in ADTS (MPEG-4 or MPEG-2, no CRC or with one) at `at`, or null. */
function adtsFrame(bytes: Uint8Array, at: number): { length: number; sampleRate: number; channels: number; samples: number } | null {
  if (at + 7 > bytes.byteLength || bytes[at] !== 0xff || (bytes[at + 1]! & 0xf6) !== 0xf0) return null;
  const rate = ADTS_RATES[(bytes[at + 2]! >> 2) & 0x0f];
  const length = ((bytes[at + 3]! & 0x03) << 11) | (bytes[at + 4]! << 3) | (bytes[at + 5]! >> 5);
  if (!rate || length < 7) return null;
  const channels = ((bytes[at + 2]! & 1) << 2) | (bytes[at + 3]! >> 6);
  return { length, sampleRate: rate, channels, samples: 1024 * ((bytes[at + 6]! & 3) + 1) };
}

function mp3Facts(bytes: Uint8Array, at: number): AudioFacts {
  const frame = mp3Frame(bytes, at)!;
  const facts: AudioFacts = { mime: 'audio/mpeg', sampleRate: frame.sampleRate, channels: frame.channels };
  // A VBR file says how many frames it has: in a Xing (or Info) header after the side information, or in a VBRI one.
  const side = frame.version === 3 ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
  const xing = at + 4 + side;
  let frames: number | undefined;
  const tag = ascii(bytes, xing, 4);
  if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= bytes.byteLength && bytes[xing + 7]! & 1) frames = u32be(bytes, xing + 8);
  else if (ascii(bytes, at + 36, 4) === 'VBRI' && at + 54 <= bytes.byteLength) frames = u32be(bytes, at + 50);
  if (frames) facts.seconds = (frames * frame.samples) / frame.sampleRate;
  else {
    // Constant bitrate: the length is the size over the rate, less an ID3v1 tag at the end.
    const end = bytes.byteLength - (bytes.byteLength >= 128 && ascii(bytes, bytes.byteLength - 128, 3) === 'TAG' ? 128 : 0);
    facts.seconds = ((end - at) * 8) / (frame.kbps * 1000);
  }
  return facts;
}

function adtsFacts(bytes: Uint8Array, at: number): AudioFacts {
  let samples = 0;
  let first: ReturnType<typeof adtsFrame> = null;
  for (let frame = adtsFrame(bytes, at); frame; frame = adtsFrame(bytes, at)) {
    first ??= frame;
    samples += frame.samples;
    at += frame.length;
  }
  return { mime: 'audio/aac', ...(first ? { seconds: samples / first.sampleRate, sampleRate: first.sampleRate, channels: first.channels } : {}) };
}

// ------------------------------------------------------------------------------------------------- WAV

function wavFacts(bytes: Uint8Array): AudioFacts {
  const facts: AudioFacts = { mime: 'audio/wav' };
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.byteLength; ) {
    const id = ascii(bytes, at, 4);
    const size = u32le(bytes, at + 4);
    if (id === 'fmt ' && at + 24 <= bytes.byteLength) {
      facts.channels = u16le(bytes, at + 10);
      facts.sampleRate = u32le(bytes, at + 12);
      byteRate = u32le(bytes, at + 16);
    } else if (id === 'data') {
      // A WAV written while it streamed has no size yet (0 or all ones): the rest of the file is the sound.
      const rest = bytes.byteLength - at - 8;
      const data = size === 0 || size === 0xffffffff || size > rest ? rest : size;
      if (byteRate > 0) facts.seconds = data / byteRate;
      break;
    }
    at += 8 + size + (size & 1);
  }
  return facts;
}

/** A WAV file around raw 16-bit little-endian samples, as Gemini and others send speech. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1, bitsPerSample = 16): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  const block = channels * (bitsPerSample / 8);
  text(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * block, true);
  view.setUint16(32, block, true);
  view.setUint16(34, bitsPerSample, true);
  text(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** The sample rate in a type such as `audio/L16;codec=pcm;rate=24000`, or the given one. */
export function pcmRate(mime: string, fallback = 24000): number {
  const rate = /rate=(\d+)/i.exec(mime)?.[1];
  return rate ? Number(rate) : fallback;
}

/** Raw samples, by their type: `audio/L16`, `audio/pcm` and the like. */
export const isPcm = (mime: string | undefined): boolean => !!mime && /^audio\/(?:l16|pcm|raw|x-raw)/i.test(mime);

// ------------------------------------------------------------------------------------------------- Ogg

function oggFacts(bytes: Uint8Array): AudioFacts {
  const facts: AudioFacts = { mime: 'audio/ogg' };
  // The first page carries the codec's identification header.
  const segments = bytes[26] ?? 0;
  const start = 27 + segments;
  let rate = 0;
  let skip = 0;
  if (ascii(bytes, start, 8) === 'OpusHead') {
    facts.channels = bytes[start + 9];
    skip = u16le(bytes, start + 10);
    facts.sampleRate = u32le(bytes, start + 12) || 48000;
    // Opus always counts at 48 kHz, whatever it was made from.
    rate = 48000;
  } else if (bytes[start] === 1 && ascii(bytes, start + 1, 6) === 'vorbis') {
    facts.channels = bytes[start + 11];
    rate = u32le(bytes, start + 12);
    facts.sampleRate = rate;
  }
  if (!rate) return facts;
  // The last page's granule position is the number of samples so far; it is near the end.
  for (let at = bytes.byteLength - 27; at >= Math.max(0, bytes.byteLength - 256 * 1024); at--) {
    if (bytes[at] !== 0x4f || ascii(bytes, at, 4) !== 'OggS') continue;
    const granule = u32le(bytes, at + 6) + u32le(bytes, at + 10) * 0x100000000;
    if (granule > skip) facts.seconds = (granule - skip) / rate;
    break;
  }
  return facts;
}

// ------------------------------------------------------------------------------------------------ FLAC

function flacFacts(bytes: Uint8Array): AudioFacts {
  const facts: AudioFacts = { mime: 'audio/flac' };
  // STREAMINFO is always the first block: 20 bits of rate, 3 of channels, 5 of bits a sample, 36 of samples.
  if (bytes.byteLength < 26 || (bytes[4]! & 0x7f) !== 0) return facts;
  const at = 18;
  const rate = (bytes[at]! << 12) | (bytes[at + 1]! << 4) | (bytes[at + 2]! >> 4);
  const samples = (bytes[at + 3]! & 0x0f) * 0x100000000 + u32be(bytes, at + 4);
  facts.channels = ((bytes[at + 2]! >> 1) & 7) + 1;
  if (rate > 0) {
    facts.sampleRate = rate;
    if (samples > 0) facts.seconds = samples / rate;
  }
  return facts;
}

// ------------------------------------------------------------------------------------- telling them apart

/** The type a file's first bytes show, or null. */
export function sniffAudio(bytes: Uint8Array): AudioMime | null {
  if (bytes.byteLength < 4) return null;
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'audio/flac';
  // MP4 and WebM hold sound alone as well as video: they are sound when no track in them is a picture.
  const container = sniffVideo(bytes);
  if (container) {
    const brand = container === 'video/mp4' ? ascii(bytes, 8, 4) : '';
    const facts = videoFacts(bytes);
    if (/^(?:M4A |M4B |F4A |F4B )$/.test(brand) || (facts.width === 0 && facts.audio)) return container === 'video/mp4' ? 'audio/mp4' : 'audio/webm';
    return null;
  }
  const at = afterId3(bytes);
  if (mp3Frame(bytes, at)) return 'audio/mpeg';
  if (adtsFrame(bytes, at)) return 'audio/aac';
  return null;
}

/** Throws what the person should read when the bytes aren't a sound Atelier can keep. */
export function checkAudio(bytes: Uint8Array): AudioMime {
  if (bytes.byteLength === 0) throw new Error('The sound came back empty.');
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error(`The sound is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`);
  const mime = sniffAudio(bytes);
  if (!mime) throw new Error("What came back isn't a sound file Atelier knows (MP3, WAV, Ogg, FLAC, AAC, M4A or WebM).");
  return mime;
}

/**
 * The length, sample rate and channels of a sound. A file damaged past reading gives no length rather than an error: it
 * may still play, and `checkAudio` is what decides whether it is kept.
 */
export function audioFacts(bytes: Uint8Array): AudioFacts {
  const mime = sniffAudio(bytes);
  if (!mime) throw new Error("That isn't a sound file Atelier knows.");
  try {
    switch (mime) {
      case 'audio/wav':
        return wavFacts(bytes);
      case 'audio/ogg':
        return oggFacts(bytes);
      case 'audio/flac':
        return flacFacts(bytes);
      case 'audio/mpeg':
        return mp3Facts(bytes, afterId3(bytes));
      case 'audio/aac':
        return adtsFacts(bytes, afterId3(bytes));
      default: {
        const seconds = videoFacts(bytes).seconds;
        return { mime, ...(seconds !== undefined ? { seconds } : {}) };
      }
    }
  } catch {
    return { mime };
  }
}
