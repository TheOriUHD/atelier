import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkImage, downloadAudio, downloadImage, downloadVideo } from './download.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const publicLookup = async () => ['93.184.216.34'];
const signal = new AbortController().signal;

describe('downloadImage', () => {
  it('takes an image from a public host, without any credentials', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(PNG));
    await expect(downloadImage({ fetch, lookup: publicLookup }, 'https://cdn.example.com/a.png', signal)).resolves.toMatchObject({ mime: 'image/png' });
    const init = fetch.mock.calls[0]![1];
    expect(init.redirect).toBe('manual');
    expect(init.headers).toBeUndefined();
  });

  it('refuses a private address', async () => {
    const fetch = vi.fn();
    await expect(downloadImage({ fetch, lookup: async () => ['192.168.1.4'] }, 'https://cdn.example.com/a.png', signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks every redirect, and refuses one into the network', async () => {
    const lookup = async (host: string) => (host === 'cdn.example.com' ? ['93.184.216.34'] : ['10.0.0.8']);
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://internal.example.com/secret' } }));
    await expect(downloadImage({ fetch, lookup }, 'https://cdn.example.com/a.png', signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops following a chain of redirects', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/next' } }));
    await expect(downloadImage({ fetch, lookup: publicLookup }, 'https://cdn.example.com/a.png', signal)).rejects.toThrow('Too many');
  });

  it('refuses an error page that came back as a success', async () => {
    const fetch = async () => new Response('<html>nope</html>');
    await expect(downloadImage({ fetch, lookup: publicLookup }, 'https://cdn.example.com/a.png', signal)).rejects.toThrow("isn't an image");
  });

  it('refuses URLs with credentials and other schemes', async () => {
    await expect(downloadImage({ fetch: vi.fn(), lookup: publicLookup }, 'https://me:pw@cdn.example.com/a.png', signal)).rejects.toThrow('credentials');
    await expect(downloadImage({ fetch: vi.fn(), lookup: publicLookup }, 'file:///etc/passwd', signal)).rejects.toThrow();
  });
});

describe('checkImage', () => {
  it('refuses empty and unknown bytes', () => {
    expect(() => checkImage(new Uint8Array())).toThrow('empty');
    expect(() => checkImage(new TextEncoder().encode('<svg/>'))).toThrow("isn't an image");
    expect(checkImage(PNG)).toBe('image/png');
  });
});

describe('downloadVideo', () => {
  const clip = new Uint8Array(readFileSync(new URL('./__fixtures__/tiny.webm', import.meta.url)));

  it('takes a clip from a public host the way an image is taken', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(clip));
    await expect(downloadVideo({ fetch, lookup: publicLookup }, 'https://cdn.example.com/a.webm', signal)).resolves.toMatchObject({ mime: 'video/webm' });
    expect(fetch.mock.calls[0]![1].redirect).toBe('manual');
    expect(fetch.mock.calls[0]![1].headers).toBeUndefined();
  });

  it('refuses a private address, a redirect into the network and credentials, as for images', async () => {
    const fetch = vi.fn();
    await expect(downloadVideo({ fetch, lookup: async () => ['192.168.1.4'] }, 'https://cdn.example.com/a.mp4', signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const lookup = async (host: string) => (host === 'cdn.example.com' ? ['93.184.216.34'] : ['10.0.0.8']);
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://internal.example.com/v.mp4' } }));
    await expect(downloadVideo({ fetch: redirect, lookup }, 'https://cdn.example.com/a.mp4', signal)).rejects.toThrow();
    await expect(downloadVideo({ fetch, lookup: publicLookup }, 'https://me:pw@cdn.example.com/a.mp4', signal)).rejects.toThrow('credentials');
  });

  it('refuses an error page, and a picture, that came back as a success', async () => {
    await expect(downloadVideo({ fetch: async () => new Response('<html>nope</html>'), lookup: publicLookup }, 'https://cdn.example.com/a.mp4', signal)).rejects.toThrow("isn't an MP4 or WebM");
    await expect(downloadVideo({ fetch: async () => new Response(PNG), lookup: publicLookup }, 'https://cdn.example.com/a.mp4', signal)).rejects.toThrow("isn't an MP4 or WebM");
  });

  it('says it was a video that failed', async () => {
    await expect(downloadVideo({ fetch: async () => new Response('gone', { status: 404 }), lookup: publicLookup }, 'https://cdn.example.com/a.mp4', signal)).rejects.toThrow('Fetching the video failed (404)');
  });
});

describe('downloadAudio', () => {
  const sound = new Uint8Array(readFileSync(new URL('./__fixtures__/audio/tone-cbr.mp3', import.meta.url)));
  const clip = new Uint8Array(readFileSync(new URL('./__fixtures__/tiny.mp4', import.meta.url)));

  it('takes a sound from a public host the way an image is taken', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(sound));
    await expect(downloadAudio({ fetch, lookup: publicLookup }, 'https://cdn.example.com/a.mp3', signal)).resolves.toMatchObject({ mime: 'audio/mpeg' });
    expect(fetch.mock.calls[0]![1].redirect).toBe('manual');
    expect(fetch.mock.calls[0]![1].headers).toBeUndefined();
  });

  it('refuses a private address and an error page, and a video, that came back as a success', async () => {
    const fetch = vi.fn();
    await expect(downloadAudio({ fetch, lookup: async () => ['10.1.2.3'] }, 'https://cdn.example.com/a.mp3', signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(downloadAudio({ fetch: async () => new Response('<html>nope</html>'), lookup: publicLookup }, 'https://cdn.example.com/a.mp3', signal)).rejects.toThrow("isn't a sound file");
    await expect(downloadAudio({ fetch: async () => new Response(clip), lookup: publicLookup }, 'https://cdn.example.com/a.mp3', signal)).rejects.toThrow("isn't a sound file");
  });

  it('says it was a sound that failed', async () => {
    await expect(downloadAudio({ fetch: async () => new Response('gone', { status: 410 }), lookup: publicLookup }, 'https://cdn.example.com/a.mp3', signal)).rejects.toThrow('Fetching the sound failed (410)');
  });
});
