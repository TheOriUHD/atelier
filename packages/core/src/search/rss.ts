/** A small reader for the RSS the news engines return: items with the few fields the results need, nothing else. */
import { decodeEntities } from './text.ts';

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  /** The outlet's name (`<News:Source>` for Bing, `<source>` for Google). */
  source: string;
  /** The outlet's site (`<source url="…">`), when the feed gives it. */
  sourceUrl: string;
}

function field(block: string, tag: string): string {
  const found = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!found) return '';
  const raw = found[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return cdata ? cdata[1]! : decodeEntities(raw);
}

export function rssItems(xml: string): RssItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
    const block = m[1]!;
    return {
      title: field(block, 'title'),
      link: field(block, 'link'),
      description: field(block, 'description'),
      pubDate: field(block, 'pubDate'),
      source: field(block, 'News:Source') || field(block, 'source'),
      sourceUrl: decodeEntities(/<source\s[^>]*url="([^"]*)"/i.exec(block)?.[1] ?? ''),
    };
  });
}
