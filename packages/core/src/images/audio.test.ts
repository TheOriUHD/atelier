import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audioFacts, checkAudio, MAX_AUDIO_BYTES, pcmRate, pcmToWav, sniffAudio } from './audio.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/audio/${name}`, import.meta.url)));
const mp4 = new Uint8Array(readFileSync(new URL('./__fixtures__/tiny.mp4', import.meta.url)));
const webmVideo = new Uint8Array(readFileSync(new URL('../../../../e2e/assets/dusk.webm', import.meta.url)));

// Made with ffmpeg from a sine tone; ffprobe's lengths are in the comments.
const CASES = [
  ['tone-cbr.mp3', 'audio/mpeg', 1.5],
  ['tone-vbr.mp3', 'audio/mpeg', 2],
  ['tone.wav', 'audio/wav', 1],
  ['tone.opus.ogg', 'audio/ogg', 1.2565],
  ['tone.flac', 'audio/flac', 1],
  ['tone.m4a', 'audio/mp4', 1],
  ['tone.aac', 'audio/aac', 1.068],
  ['tone.webm', 'audio/webm', 1.008],
] as const;

describe('sound files', () => {
  it.each(CASES)('knows %s as %s and reads its length', (name, mime, seconds) => {
    const bytes = fixture(name);
    expect(sniffAudio(bytes)).toBe(mime);
    expect(checkAudio(bytes)).toBe(mime);
    const facts = audioFacts(bytes);
    expect(facts.mime).toBe(mime);
    // MP3 and AAC encoders pad the ends a little, which the frame count includes.
    expect(facts.seconds).toBeGreaterThan(seconds - 0.12);
    expect(facts.seconds).toBeLessThan(seconds + 0.12);
  });

  it('reads the sample rate and channels where the file says them', () => {
    expect(audioFacts(fixture('tone.wav'))).toMatchObject({ sampleRate: 8000, channels: 1 });
    expect(audioFacts(fixture('tone.flac'))).toMatchObject({ sampleRate: 11025, channels: 1 });
    expect(audioFacts(fixture('tone.opus.ogg'))).toMatchObject({ sampleRate: 48000, channels: 1 });
    expect(audioFacts(fixture('tone-cbr.mp3'))).toMatchObject({ sampleRate: 22050, channels: 1 });
  });

  it('turns a video with a picture away, and anything else', () => {
    // The MP4 fixture has a picture and a sound track; the WebM is picture only.
    expect(sniffAudio(mp4)).toBeNull();
    expect(sniffAudio(webmVideo)).toBeNull();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniffAudio(png)).toBeNull();
    expect(sniffAudio(new TextEncoder().encode('<html><body>not a sound</body></html>'))).toBeNull();
    expect(() => checkAudio(new Uint8Array())).toThrow('empty');
    expect(() => checkAudio(png)).toThrow("isn't a sound file");
  });

  it('refuses a sound larger than the limit before reading it', () => {
    const huge = { byteLength: MAX_AUDIO_BYTES + 1 } as Uint8Array;
    expect(() => checkAudio(huge)).toThrow('larger than');
  });

  it('wraps raw samples in a WAV that reads back at its length', () => {
    // A second of silence at 24 kHz, 16-bit mono: 48,000 bytes.
    const wav = pcmToWav(new Uint8Array(48_000), 24_000);
    expect(sniffAudio(wav)).toBe('audio/wav');
    expect(audioFacts(wav)).toMatchObject({ seconds: 1, sampleRate: 24_000, channels: 1 });
    expect(pcmRate('audio/L16;codec=pcm;rate=16000')).toBe(16_000);
    expect(pcmRate('audio/pcm')).toBe(24_000);
  });

  it('reads a WAV that was streamed, whose sizes were never filled in', () => {
    const wav = pcmToWav(new Uint8Array(16_000), 8_000);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(audioFacts(wav).seconds).toBe(1);
  });

  it('gives no length for a file damaged past reading, rather than failing', () => {
    const cut = fixture('tone.flac').slice(0, 20);
    expect(sniffAudio(cut)).toBe('audio/flac');
    expect(audioFacts(cut).seconds).toBeUndefined();
  });
});
