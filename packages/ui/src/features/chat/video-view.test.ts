import type { GeneratedImageMeta, ToolResultPart } from '@atelier/protocol';
import { describe, expect, it } from 'vitest';
import { formatClock, plannedVideoShape, shownVideos, videoFailure, videoFileName, videoFraction, videoStatus } from './video-view.ts';

const clip: GeneratedImageMeta = { id: 'vid_ab12cd34', blob: 'ab12cd'.padEnd(64, '0'), mime: 'video/mp4', width: 1280, height: 720, kind: 'video', prompt: 'Waves, at dusk!', ref: 'v/m', modelName: 'M', seconds: 6 };
const picture: GeneratedImageMeta = { ...clip, id: 'img_ab12cd34', mime: 'image/png', kind: undefined as never };
const result = (over: Partial<ToolResultPart> = {}): ToolResultPart => ({ type: 'tool_result', callId: 'c', content: [{ type: 'text', text: 'Generated a video' }], generated: [clip], ...over });

describe('shownVideos', () => {
  it('takes the clips of a result, and nothing that is a picture', () => {
    expect(shownVideos(result())).toEqual([clip]);
    expect(shownVideos(result({ generated: [picture] }))).toEqual([]);
  });

  it('shows nothing for a failed result, and what progress says is done ahead of a result', () => {
    expect(shownVideos(result({ isError: true }))).toEqual([]);
    expect(shownVideos(undefined, { phase: 'finishing', images: [clip] })).toEqual([clip]);
    expect(shownVideos(undefined)).toEqual([]);
  });
});

describe('plannedVideoShape', () => {
  it('prefers the shape the backend settled on, then the ratio asked for, then wide', () => {
    expect(plannedVideoShape({ input: { aspect_ratio: '1:1' } }, { phase: 'queued', width: 563, height: 1000 })).toEqual({ width: 563, height: 1000 });
    expect(plannedVideoShape({ input: { aspect_ratio: '9:16' } }, undefined)).toEqual({ width: 9, height: 16 });
    expect(plannedVideoShape({ input: { aspect_ratio: 'wide please' } }, undefined)).toEqual({ width: 16, height: 9 });
    expect(plannedVideoShape({ input: undefined }, undefined)).toEqual({ width: 16, height: 9 });
  });
});

describe('videoStatus', () => {
  const status = (progress: Parameters<typeof videoStatus>[0], seconds: number | undefined = 6, waiting = false) => videoStatus(progress, { seconds, waiting });

  it('says what is being waited for', () => {
    expect(status(undefined, 6, true)).toBe('Waiting for your answer');
    expect(status(undefined)).toBe('Getting ready');
    expect(status({ phase: 'queued' })).toBe('Waiting in line');
    expect(status({ phase: 'queued', ahead: 2 })).toBe('2 ahead of you');
    expect(status({ phase: 'freeing' })).toBe('Freeing the GPU');
    expect(status({ phase: 'loading' })).toBe('Loading the model');
    expect(status({ phase: 'finishing' })).toBe('Saving the video');
  });

  it('counts while it makes the clip, by steps, by percent, or by what it was asked for', () => {
    expect(status({ phase: 'generating', step: 5, steps: 20, etaMs: 95_000 })).toBe('Step 5 of 20 · about 2 min');
    expect(status({ phase: 'generating', fraction: 0.42 })).toBe('42%');
    expect(status({ phase: 'generating', seconds: 8 })).toBe('Making a 8 s video');
    expect(videoStatus({ phase: 'generating' }, { seconds: undefined, waiting: false })).toBe('Making the video');
  });
});

describe('videoFraction', () => {
  it('is known only while generating, and full while saving', () => {
    expect(videoFraction({ phase: 'queued' })).toBeUndefined();
    expect(videoFraction({ phase: 'generating' })).toBeUndefined();
    expect(videoFraction({ phase: 'generating', step: 5, steps: 20 })).toBe(0.25);
    expect(videoFraction({ phase: 'finishing' })).toBe(1);
  });
});

describe('videoFailure', () => {
  it('says plainly why there is no clip', () => {
    expect(videoFailure('GenerateVideo failed: The video model refused this: policy. That is final: tell the person, and don\'t reword the prompt to get past it.')).toEqual({ kind: 'refused', text: 'The video model refused this: policy.' });
    expect(videoFailure('No video model is available. An admin adds one in Settings › Image and video providers.')).toMatchObject({ kind: 'setup' });
    expect(videoFailure('Stopped.')).toEqual({ kind: 'stopped', text: 'Stopped before it finished.' });
    expect(videoFailure('')).toEqual({ kind: 'failed', text: 'The video could not be made.' });
    expect(videoFailure("That's the limit of 2 videos in one turn. Stop here and tell the person; they can ask for more in their next message.").text).toBe("That's the limit of 2 videos in one turn.");
  });
});

describe('videoFileName and formatClock', () => {
  it('names a download from its prompt and type', () => {
    expect(videoFileName(clip)).toBe('waves-at-dusk-ab12cd.mp4');
    expect(videoFileName({ ...clip, prompt: '', mime: 'video/webm' })).toBe('video-ab12cd.webm');
  });

  it('writes a length as a player does', () => {
    expect(formatClock(6)).toBe('0:06');
    expect(formatClock(65.4)).toBe('1:05');
    expect(formatClock(-3)).toBe('0:00');
  });
});
