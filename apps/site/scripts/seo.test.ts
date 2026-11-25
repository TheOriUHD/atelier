import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { files, PUBLIC } from './seo.mjs';

const read = (file: string) => readFileSync(join(PUBLIC, file), 'utf8');

describe('the pages search engines and AI agents read', () => {
  it('the comparison pages, the hub and llms.txt are what the data says (node apps/site/scripts/seo.mjs)', () => {
    for (const [path, content] of Object.entries(files())) expect(read(path), path).toBe(content);
  });

  it('the sitemap lists every page that has a canonical address', () => {
    const listed = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const path of ['/', '/download/', '/apps/', ...Object.keys(files()).filter((f) => f.endsWith('index.html') && f.startsWith('compare')).map((f) => `/${f.replace('index.html', '')}`)]) {
      expect(listed, path).toContain(`https://atelierhq.dev${path}`);
    }
    for (const url of listed) expect(url).toMatch(/\/$/);
  });

  it('the homepage’s structured data matches what the page says', () => {
    const html = read('index.html');
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
    const graph = blocks.flatMap((b) => b['@graph'] ?? [b]);
    expect(graph.map((n: { '@type': string }) => n['@type']).sort()).toEqual(['FAQPage', 'Organization', 'SoftwareApplication', 'WebSite']);
    // The FAQ in the markup is the FAQ on the page, word for word.
    const faq = graph.find((n: { '@type': string }) => n['@type'] === 'FAQPage');
    const visible = [...html.matchAll(/<details><summary>(.*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map(([, q, a]) => [q, a].map((t) => t!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()));
    expect(faq.mainEntity.map((e: { name: string; acceptedAnswer: { text: string } }) => [e.name, e.acceptedAnswer.text])).toEqual(visible);
  });

  it('every page links to the comparisons, and the data has no empty fact', () => {
    for (const page of ['index.html', 'download/index.html', 'compare/index.html']) expect(read(page), page).toContain('href="/compare/"');
    // The apps page is in every page's header and footer, and says what is true: a store that hasn't approved the phone app has no link.
    for (const page of ['index.html', 'download/index.html', 'compare/index.html', 'apps/index.html', 'join/index.html', 'impressum/index.html', 'datenschutz/index.html']) expect(read(page), page).toContain('<a href="/apps/"');
    expect(read('apps/index.html')).toContain('Coming to the App Store');
    expect(read('apps/index.html')).not.toMatch(/apps\.apple\.com/);
    for (const [path, content] of Object.entries(files())) expect(content, path).not.toMatch(/undefined|\[object/);
  });
});
