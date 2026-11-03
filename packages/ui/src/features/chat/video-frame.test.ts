import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstFrame } from './video-frame.ts';

// jsdom plays no video, so the player and the canvas are stood in for; what is tested is the order of things and the errors.
let video: HTMLVideoElement;
let drawn: unknown[];
const listeners = new Map<string, () => void>();

beforeEach(() => {
  drawn = [];
  listeners.clear();
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') {
      video = {
        videoWidth: 160,
        videoHeight: 90,
        muted: false,
        preload: '',
        playsInline: false,
        crossOrigin: null,
        src: '',
        addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
        removeAttribute: vi.fn(),
        load: vi.fn(),
      } as unknown as HTMLVideoElement;
      return video;
    }
    return {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args: unknown[]) => drawn.push(args) }),
      toBlob: (done: (blob: Blob | null) => void) => done(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement;
  }) as typeof document.createElement);
});
afterEach(() => vi.restoreAllMocks());

describe('firstFrame', () => {
  it('loads the clip with crossorigin in a player of its own and draws its first picture to a PNG file', async () => {
    const taken = firstFrame('atelier-blob://abc');
    // The source is set and loading starts; nothing is drawn before the first frame is there.
    expect(video.crossOrigin).toBe('anonymous');
    expect(video.muted).toBe(true);
    expect(video.src).toBe('atelier-blob://abc');
    expect(drawn).toEqual([]);
    listeners.get('loadeddata')!();
    const file = await taken;
    expect(file.name).toBe('first-frame.png');
    expect(file.type).toBe('image/png');
    expect(drawn).toHaveLength(1);
    // The hidden player is let go of.
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('says so when the clip cannot be loaded', async () => {
    const taken = firstFrame('atelier-blob://gone');
    listeners.get('error')!();
    await expect(taken).rejects.toThrow('The video could not be loaded.');
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('says so when the clip has no picture', async () => {
    const taken = firstFrame('atelier-blob://audio');
    (video as { videoWidth: number }).videoWidth = 0;
    listeners.get('loadeddata')!();
    await expect(taken).rejects.toThrow('has no picture');
  });
});
