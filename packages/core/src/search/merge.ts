import type { SearchResult } from './types.ts';
import { canonicalUrl, hostOf, titleKey } from './text.ts';

/** The same story from two feeds: the link that opens wins, and each fills in what the other lacks. */
function combine(a: SearchResult, b: SearchResult): SearchResult {
  const [base, other] = a.redirect && !b.redirect ? [b, a] : [a, b];
  const source = base.source ?? other.source;
  const published = base.published ?? other.published;
  const snippet = other.snippet.length > base.snippet.length ? other.snippet : base.snippet;
  return { ...base, snippet, ...(source ? { source } : {}), ...(published ? { published } : {}) };
}

/**
 * Reciprocal-rank fusion of ranked lists (k = 60): a result both engines rank well rises, the rest keep their order.
 * Two links with the same headline are one story. `boost` scales a result's score (recent news rises).
 */
export function fuse(lists: readonly (readonly SearchResult[])[], boost?: (result: SearchResult) => number): SearchResult[] {
  const scored = new Map<string, { result: SearchResult; score: number }>();
  const headlines = new Map<string, string>();
  for (const list of lists) {
    list.forEach((result, rank) => {
      let key = canonicalUrl(result.url);
      const headline = titleKey(result.title);
      // Short titles ("Home", "Download") are shared by unrelated pages; a whole headline is not.
      if (headline.length >= 24) {
        const known = headlines.get(headline);
        if (known) key = known;
        else headlines.set(headline, key);
      }
      const entry = scored.get(key);
      const score = 1 / (60 + rank + 1);
      if (entry) {
        entry.score += score;
        entry.result = combine(entry.result, result);
      } else scored.set(key, { result, score });
    });
  }
  return [...scored.values()]
    .map((e) => ({ result: e.result, score: e.score * (boost?.(e.result) ?? 1) }))
    .sort((a, b) => b.score - a.score)
    .map((e) => e.result);
}

/** At most `perDomain` results from one site, in the order given; the list is cut at `limit`. */
export function diversify(results: readonly SearchResult[], limit: number, perDomain = 3): SearchResult[] {
  const counts = new Map<string, number>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const host = hostOf(r.url);
    const n = counts.get(host) ?? 0;
    if (n >= perDomain) continue;
    counts.set(host, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
