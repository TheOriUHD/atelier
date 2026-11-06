import { describe, expect, it } from 'vitest';
import type { AudioCapabilities, ImageCapabilities } from '@atelier/protocol';
import { AudioAskError, findVoice, fitAudio, NotASoundModel } from './audio-params.ts';

const base: Omit<ImageCapabilities, 'audio'> = {
  output: 'audio',
  family: 'hosted',
  promptStyle: 'natural',
  negativePrompt: false,
  sizes: { kind: 'fixed', list: [{ width: 1, height: 1 }] },
  maxCount: 1,
  edit: false,
  mask: false,
  maxReferences: 0,
  transparent: false,
  seed: false,
  previews: false,
  tunable: false,
};
const caps = (audio: AudioCapabilities, extra: Partial<ImageCapabilities> = {}): ImageCapabilities => ({ ...base, ...extra, audio });

const SPEECH = caps({
  kinds: ['speech'],
  voices: [
    { id: 'alloy', name: 'Alloy' },
    { id: 'v-91', name: 'Rachel - calm narrator', description: 'calm, American' },
  ],
  defaultVoice: 'alloy',
  direction: true,
  speed: true,
  maxChars: 40,
  maxSpeakers: 2,
});
const MUSIC = caps({ kinds: ['music', 'sound'], durations: { kind: 'range', min: 5, max: 190, step: 1 }, defaultSeconds: 30, lyrics: true, vocals: 'optional' }, { seed: true, negativePrompt: true });

describe('fitAudio', () => {
  it('takes a voice by its id or its name, and says when there is no such voice', () => {
    expect(fitAudio(SPEECH, { kind: 'speech', text: 'Hi', voice: 'V-91' })).toMatchObject({ voice: 'v-91', voiceName: 'Rachel - calm narrator', notes: [] });
    expect(fitAudio(SPEECH, { kind: 'speech', text: 'Hi', voice: 'rachel' })).toMatchObject({ voice: 'v-91' });
    const missing = fitAudio(SPEECH, { kind: 'speech', text: 'Hi', voice: 'Morgan' });
    expect(missing).toMatchObject({ voice: 'alloy' });
    expect(missing.notes[0]).toContain('no voice "Morgan"');
  });

  it("uses the person's voice for the model, then the model's own", () => {
    expect(fitAudio(SPEECH, { kind: 'speech', text: 'Hi' }, { voice: 'v-91' }).voice).toBe('v-91');
    expect(fitAudio(SPEECH, { kind: 'speech', text: 'Hi' }).voice).toBe('alloy');
  });

  it('passes any voice name to a service without a list of voices', () => {
    const open = caps({ kinds: ['speech'] });
    expect(fitAudio(open, { kind: 'speech', text: 'Hi', voice: 'af_bella' })).toMatchObject({ voice: 'af_bella', notes: [] });
    expect(fitAudio(open, { kind: 'speech', text: 'Hi' }).voice).toBeUndefined();
  });

  it('refuses text longer than the model reads at once, and too many speakers', () => {
    expect(() => fitAudio(SPEECH, { kind: 'speech', text: 'x'.repeat(41) })).toThrow(AudioAskError);
    expect(() => fitAudio(SPEECH, { kind: 'speech', text: 'Hi', speakers: [{ name: 'A', voice: 'alloy' }, { name: 'B', voice: 'alloy' }, { name: 'C', voice: 'alloy' }] })).toThrow('at most 2 speakers');
    expect(() => fitAudio(caps({ kinds: ['speech'] }), { kind: 'speech', text: 'Hi', speakers: [{ name: 'A', voice: 'x' }, { name: 'B', voice: 'y' }] })).toThrow('one voice at a time');
  });

  it("gives each speaker a voice the model has", () => {
    const fit = fitAudio(SPEECH, { kind: 'speech', text: 'A: hi\nB: hello', speakers: [{ name: 'A', voice: 'Rachel' }, { name: 'B', voice: 'nobody' }] });
    expect(fit.speakers).toEqual([{ name: 'A', voice: 'v-91' }, { name: 'B', voice: 'alloy' }]);
    expect(fit.notes[0]).toContain('B speaks in Alloy');
  });

  it('keeps direction and speed where the model takes them, and says it left them out elsewhere', () => {
    expect(fitAudio(SPEECH, { kind: 'speech', text: 'Hi', direction: ' whisper ', speed: 3 })).toMatchObject({ direction: 'whisper', speed: 2 });
    const plain = fitAudio(caps({ kinds: ['speech'] }), { kind: 'speech', text: 'Hi', direction: 'whisper', speed: 1.2, seconds: 5 });
    expect(plain.direction).toBeUndefined();
    expect(plain.speed).toBeUndefined();
    expect(plain.notes).toHaveLength(3);
  });

  it('fits the length of music and says so', () => {
    expect(fitAudio(MUSIC, { kind: 'music' }).seconds).toBe(30);
    expect(fitAudio(MUSIC, { kind: 'music' }, { seconds: 12 }).seconds).toBe(12);
    const long = fitAudio(MUSIC, { kind: 'music', seconds: 600 });
    expect(long.seconds).toBe(190);
    expect(long.notes[0]).toContain('5 to 190 seconds');
  });

  it('keeps lyrics or an instrumental as the model allows', () => {
    expect(fitAudio(MUSIC, { kind: 'music', lyrics: 'la la' })).toMatchObject({ lyrics: 'la la' });
    expect(fitAudio(MUSIC, { kind: 'music', instrumental: true, lyrics: 'la' })).toMatchObject({ instrumental: true });
    expect(fitAudio(MUSIC, { kind: 'music' }).instrumental).toBeUndefined();
    const instrumentalOnly = caps({ kinds: ['music'], vocals: 'none' });
    expect(fitAudio(instrumentalOnly, { kind: 'music', lyrics: 'la' }).notes[0]).toContain('instrumentals only');
    const singer = caps({ kinds: ['music'], vocals: 'always', lyrics: true });
    expect(fitAudio(singer, { kind: 'music', instrumental: true }).notes[0]).toContain('always sings');
  });

  it("refuses a kind the model doesn't make, and a picture model", () => {
    expect(() => fitAudio(SPEECH, { kind: 'music' })).toThrow('makes speech, not music');
    expect(() => fitAudio({ ...base, output: 'image' }, { kind: 'speech' })).toThrow(NotASoundModel);
  });

  it('keeps a seed and a negative prompt only where the model takes them', () => {
    expect(fitAudio(MUSIC, { kind: 'sound', seed: 7, negativePrompt: 'voices' })).toMatchObject({ seed: 7, negativePrompt: 'voices' });
    expect(fitAudio(SPEECH, { kind: 'speech', text: 'Hi', seed: 7 }).notes[0]).toContain('seed');
  });
});

describe('findVoice', () => {
  it('matches the first word of a long voice name', () => {
    expect(findVoice([{ id: '1', name: 'Rachel (legacy)' }], 'rachel')?.id).toBe('1');
    expect(findVoice(undefined, 'x')).toBeUndefined();
  });
});
