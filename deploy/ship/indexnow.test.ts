import { describe, expect, it } from 'vitest';
import { indexNow, KEY, requestFor, urlsSince } from './indexnow.mjs';

const xml = `<urlset><url><loc>https://x.dev/</loc><lastmod>2026-11-16</lastmod></url><url><loc>https://x.dev/old/</loc><lastmod>2026-10-01</lastmod></url><url><loc>https://x.dev/undated/</loc></url></urlset>`;

describe('IndexNow', () => {
  it('sends the pages that changed since a date, and those with no date', () => {
    expect(urlsSince(xml, '2026-11-10')).toEqual(['https://x.dev/', 'https://x.dev/undated/']);
    expect(urlsSince(xml, null)).toHaveLength(3);
  });

  it('points at the key file of the host it is for', () => {
    expect(requestFor('docs.atelierhq.dev', ['https://docs.atelierhq.dev/'])).toEqual({ host: 'docs.atelierhq.dev', key: KEY, keyLocation: `https://docs.atelierhq.dev/${KEY}.txt`, urlList: ['https://docs.atelierhq.dev/'] });
    expect(KEY).toMatch(/^[a-f0-9]{32}$/);
  });

  it('never throws when the service can’t be reached', async () => {
    const lines: string[] = [];
    await expect(indexNow({ since: null, fetchImpl: async () => Promise.reject(new Error('offline')), log: (l: string) => lines.push(l) })).resolves.toBeDefined();
    expect(lines.some((l) => /couldn't be reached|skipped/.test(l))).toBe(true);
  });
});
