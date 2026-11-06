import { describe, expect, it } from 'vitest';
import { shownSounds, soundFailure, soundFileName, soundKind, soundLabel, soundStatus, soundSubject } from './audio-view.ts';

const call = (input: unknown) => ({ input });

describe('what a sound call shows', () => {
  it('reads the kind and the words, speech unless it says otherwise', () => {
    expect(soundKind(call({ kind: 'music', prompt: 'lofi' }))).toBe('music');
    expect(soundKind(call({}))).toBe('speech');
    expect(soundSubject(call({ kind: 'speech', text: 'Hi', prompt: 'ignored' }))).toBe('Hi');
    expect(soundSubject(call({ kind: 'sound', prompt: 'door creak' }))).toBe('door creak');
  });

  it('names the card by its kind and, for speech, its voice', () => {
    expect(soundLabel('speech', 'Bella')).toBe('Speech · Bella');
    expect(soundLabel('music', 'Bella')).toBe('Music');
    expect(soundLabel('sound', undefined)).toBe('Sound effect');
  });

  it('says what is being waited for', () => {
    expect(soundStatus(undefined, { kind: 'speech', seconds: undefined, waiting: true })).toBe('Waiting for your answer');
    expect(soundStatus({ phase: 'freeing' }, { kind: 'music', seconds: 30, waiting: false })).toBe('Freeing the GPU');
    expect(soundStatus({ phase: 'generating' }, { kind: 'music', seconds: 30, waiting: false })).toBe('Making 30 s of music');
    expect(soundStatus({ phase: 'generating', fraction: 0.5, etaMs: 30_000 }, { kind: 'sound', seconds: undefined, waiting: false })).toBe('50% · about 30 s');
    expect(soundStatus({ phase: 'finishing' }, { kind: 'speech', seconds: undefined, waiting: false })).toBe('Saving the sound');
  });

  it('only takes sounds from a result', () => {
    expect(shownSounds({ type: 'tool_result', callId: 'c', content: [], generated: [{ id: 'img_1', blob: 'b', mime: 'image/png', width: 1, height: 1, prompt: 'p', ref: 'r', modelName: 'm' }, { id: 'aud_1', blob: 'a', mime: 'audio/mpeg', width: 0, height: 0, kind: 'audio', prompt: 'p', ref: 'r', modelName: 'm' }] }).map((s) => s.id)).toEqual(['aud_1']);
  });

  it('tells a setup problem from a refusal', () => {
    expect(soundFailure('No model here makes music; the sound models here make speech. Tell the person.')).toEqual({ kind: 'setup', text: 'No model here makes music; the sound models here make speech.' });
    expect(soundFailure('GenerateAudio failed: ')).toEqual({ kind: 'failed', text: 'The sound could not be made.' });
  });

  it('names a download by its type', () => {
    expect(soundFileName({ prompt: 'Rain!', blob: '123456789', mime: 'audio/flac' })).toBe('rain-123456.flac');
    expect(soundFileName({ prompt: '', blob: 'abcdef1', mime: 'audio/mp4' })).toBe('sound-abcdef.m4a');
  });
});
