import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkVideo, MAX_VIDEO_BYTES, sniffVideo, videoFacts } from './video.ts';

// Real files made once with ffmpeg: 160×90, 12 fps, one second. The MP4 has an AAC track, the WebM none.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe('sniffVideo', () => {
  it('knows MP4 and WebM by their structure', () => {
    expect(sniffVideo(fixture('tiny.mp4'))).toBe('video/mp4');
    expect(sniffVideo(fixture('tiny.webm'))).toBe('video/webm');
  });

  it('refuses what only looks like one', () => {
    expect(sniffVideo(new TextEncoder().encode('<html>video/mp4</html>'))).toBeNull();
    expect(sniffVideo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    // Still images share the ftyp box.
    expect(sniffVideo(new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypavif'), 0, 0, 0, 0]))).toBeNull();
    expect(sniffVideo(new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]))).toBeNull();
    // Matroska has the EBML magic but isn't WebM.
    expect(sniffVideo(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, ...new TextEncoder().encode('matroska')]))).toBeNull();
  });
});

describe('videoFacts', () => {
  it('reads an MP4 with sound', () => {
    expect(videoFacts(fixture('tiny.mp4'))).toEqual({ mime: 'video/mp4', width: 160, height: 90, seconds: 1, fps: 12, audio: true });
  });

  it('reads a silent WebM', () => {
    const facts = videoFacts(fixture('tiny.webm'));
    expect(facts).toMatchObject({ mime: 'video/webm', width: 160, height: 90, audio: false });
    expect(facts.seconds).toBeCloseTo(1, 1);
    expect(facts.fps).toBe(12);
  });

  it('gives a zero size, not an error, for a container cut short', () => {
    const cut = fixture('tiny.mp4').slice(0, 60);
    expect(videoFacts(cut)).toMatchObject({ mime: 'video/mp4', width: 0, height: 0 });
  });
});

describe('checkVideo', () => {
  it('returns the type of a good clip', () => {
    expect(checkVideo(fixture('tiny.webm'))).toBe('video/webm');
  });

  it('says why it refused', () => {
    expect(() => checkVideo(new Uint8Array())).toThrow('came back empty');
    expect(() => checkVideo(new TextEncoder().encode('{"error":"nope"}'))).toThrow("isn't an MP4 or WebM");
  });

  it('keeps the size limit one place', () => {
    expect(MAX_VIDEO_BYTES).toBe(512 * 1024 * 1024);
  });
});
