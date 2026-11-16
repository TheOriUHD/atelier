#!/usr/bin/env node
/**
 * Tells Bing, Yandex and the other IndexNow search engines (indexnow.org) which pages of the website and the docs are
 * new or changed, right after a release deploys them, so they are read within hours instead of weeks. The key file
 * (`<key>.txt`, in the root of both sites) is how a site proves the pages are its own. Google doesn't take part: it
 * reads the sitemaps (Search Console).
 *
 *   node deploy/ship/indexnow.mjs [--all | --since=YYYY-MM-DD]     (default: the pages that changed in the last 3 days)
 *
 * The release runs it after both sites are deployed; it never fails a release.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEY = '4262dcb5710f37b307f42659921bbba0';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The sitemaps the sites publish: the website's is in the repo, the docs' is what the last build wrote. */
const SITES = [
  { host: 'atelierhq.dev', sitemap: 'apps/site/public/sitemap.xml' },
  { host: 'docs.atelierhq.dev', sitemap: 'apps/docs/dist/sitemap-0.xml' },
];

/** The addresses in a sitemap that changed on or after `since` (YYYY-MM-DD); all of them for `null`; one without a date counts as changed. */
export function urlsSince(xml, since) {
  const urls = [];
  for (const [, body] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(body)?.[1];
    const date = /<lastmod>([^<]+)<\/lastmod>/.exec(body)?.[1]?.slice(0, 10);
    if (loc && (since === null || !date || date >= since)) urls.push(loc);
  }
  return urls;
}

/** One request for a site: the pages and where its key file is. */
export const requestFor = (host, urlList) => ({ host, key: KEY, keyLocation: `https://${host}/${KEY}.txt`, urlList });

export async function indexNow({ since, fetchImpl = fetch, log = console.log } = {}) {
  const results = [];
  for (const { host, sitemap } of SITES) {
    const file = join(ROOT, sitemap);
    if (!existsSync(file)) {
      log(`${host}: no sitemap at ${sitemap}, skipped`);
      continue;
    }
    const urlList = urlsSince(readFileSync(file, 'utf8'), since);
    if (!urlList.length) {
      log(`${host}: nothing changed since ${since}`);
      continue;
    }
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(requestFor(host, urlList)) });
      // 200: taken. 202: taken, the key is checked when the engine looks. Anything else is only said.
      log(`${host}: ${urlList.length} pages sent, IndexNow answered ${response.status}`);
      results.push({ host, status: response.status, count: urlList.length });
    } catch (e) {
      log(`${host}: IndexNow couldn't be reached (${e instanceof Error ? e.message : e})`);
    }
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv.find((a) => a.startsWith('--since='))?.slice(8);
  const since = process.argv.includes('--all') ? null : (arg ?? new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10));
  await indexNow({ since });
}
