import { describe, expect, it, vi } from 'vitest';
import { checkImage, downloadImage } from './download.ts';

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
