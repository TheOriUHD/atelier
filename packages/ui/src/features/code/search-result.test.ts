import { describe, expect, it } from 'vitest';
import { parseSearchResult } from './search-result.ts';

describe('parseSearchResult', () => {
  it('reads the list, the engine and a note', () => {
    const view = parseSearchResult(
      'Only Wikipedia answered.\n\n1. Tokio (software)\n   https://en.wikipedia.org/wiki/Tokio_(software)\n   A library for Rust\n\n2. Rust\n   https://www.rust-lang.org/\n\n(via Wikipedia · 2 results · cached)',
    );
    expect(view).toMatchObject({ via: 'Wikipedia', cached: true, note: 'Only Wikipedia answered.' });
    expect(view.rows).toEqual([
      { title: 'Tokio (software)', url: 'https://en.wikipedia.org/wiki/Tokio_(software)', host: 'en.wikipedia.org', snippet: 'A library for Rust', published: '' },
      { title: 'Rust', url: 'https://www.rust-lang.org/', host: 'rust-lang.org', snippet: '', published: '' },
    ]);
  });

  it('reads the date and outlet of a story, keeps the page passages out of the row, and ignores a remark after the link', () => {
    const view = parseSearchResult(
      '1. Welcome Home recap\n   https://www.pcmag.com/a\n   Published: Oct 13, 2026 (4 days ago) · PCMag\n   A snippet.\n   Page: The passage the model reads.\n\n2. In the Loop\n   https://news.google.com/rss/articles/x  (not fetchable: a Google News redirect)\n   Published: Oct 8, 2026 (9 days ago) · Apple\n\n(via Bing News and Google News · 2 results)',
    );
    expect(view.via).toBe('Bing News and Google News');
    expect(view.rows[0]).toMatchObject({ url: 'https://www.pcmag.com/a', snippet: 'A snippet.', published: 'Oct 13, 2026 (4 days ago) · PCMag' });
    expect(view.rows[1]).toMatchObject({ url: 'https://news.google.com/rss/articles/x', snippet: '', published: 'Oct 8, 2026 (9 days ago) · Apple' });
    expect(parseSearchResult('1. tokio-rs/tokio\n   https://github.com/tokio-rs/tokio\n   Source: GitHub\n   A runtime for Rust.').rows[0]).toMatchObject({ snippet: 'A runtime for Rust.', published: 'GitHub' });
  });

  it('has no rows for "no results" or an error', () => {
    expect(parseSearchResult('No results for “x”.').rows).toEqual([]);
    expect(parseSearchResult('Web search is unavailable right now: …').via).toBeNull();
  });
});
