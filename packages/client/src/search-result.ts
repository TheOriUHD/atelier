/**
 * Reads a WebSearch result back into rows: the tool's text is a numbered list with a `(via Engine · 8 results)` footer.
 * Each entry is a title, its URL (sometimes followed by a remark), then optional `Published:` or `Source:`, snippet and
 * `Page:` lines; the page passages are for the model and not shown.
 */
export interface SearchRow {
  title: string;
  url: string;
  host: string;
  snippet: string;
  /** When and by whom, for news ("Oct 13, 2026 (4 days ago) · PCMag"); empty for ordinary pages. */
  published: string;
}

export interface SearchView {
  rows: SearchRow[];
  /** The engine that answered ("DuckDuckGo"); null when the text isn't a result list (an error, a refusal). */
  via: string | null;
  cached: boolean;
  /** A line the tool put before the list (only Wikipedia answered, one engine reached). */
  note: string | null;
}

const META = /^(?:Published|Source|Page): /;
const FOOTER = /^\(via (.+?) · \d+ results?( · cached)?\)$/;

export function parseSearchResult(text: string): SearchView {
  const rows: SearchRow[] = [];
  const notes: string[] = [];
  let via: string | null = null;
  let cached = false;
  for (const block of text.split(/\n{2,}/)) {
    const footer = FOOTER.exec(block.trim());
    if (footer) {
      via = footer[1]!;
      cached = !!footer[2];
      continue;
    }
    const lines = block.split('\n');
    const head = /^\d+\. (.*)$/.exec(lines[0]!);
    const url = (lines[1]?.trim() ?? '').split(/\s+/)[0] ?? '';
    if (head && /^https?:\/\//.test(url)) {
      const rest = lines.slice(2).map((l) => l.trim());
      rows.push({
        title: head[1]!,
        url,
        host: URL.parse(url)?.hostname.replace(/^www\./, '') ?? url,
        snippet: rest.filter((l) => !META.test(l)).join(' ').trim(),
        published: rest.find((l) => META.test(l) && !l.startsWith('Page: '))?.replace(META, '') ?? '',
      });
    } else if (block.trim() && !block.startsWith('No results')) notes.push(block.trim());
  }
  return { rows, via, cached, note: rows.length ? notes.join(' ') || null : null };
}
