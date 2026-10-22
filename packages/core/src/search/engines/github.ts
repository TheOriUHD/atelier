/** GitHub's repository search (keyless: about ten requests a minute per address): the project behind a library or tool name. */
import type { Attempt, Engine, SearchRequest, SearchResult } from '../types.ts';
import { aboutQuery, clean, keywords } from '../text.ts';
import { page } from './common.ts';

interface Body {
  items?: { full_name?: string; html_url?: string; description?: string | null; stargazers_count?: number; language?: string | null; pushed_at?: string; archived?: boolean }[];
}

export function parseGitHub(body: string): SearchResult[] {
  let json: Body;
  try {
    json = JSON.parse(body) as Body;
  } catch {
    return [];
  }
  return (json.items ?? []).flatMap((repo) => {
    if (!repo.full_name || !repo.html_url) return [];
    const facts = [`${(repo.stargazers_count ?? 0).toLocaleString('en-US')} stars`, repo.language, repo.pushed_at ? `last push ${repo.pushed_at.slice(0, 10)}` : null, repo.archived ? 'archived' : null].filter(Boolean).join(', ');
    return [
      {
        title: repo.full_name,
        url: repo.html_url,
        snippet: `${clean(repo.description, 300)}${repo.description ? ' ' : ''}(${facts})`,
        source: 'GitHub',
      },
    ];
  });
}

/** Words that say what is wanted from a project rather than which project. */
const ABOUT = /^(?:release|releases|notes|changelog|docs?|documentation|guide|tutorial|how|install|installation|setup|error|errors|issue|issues|fix|fixing|version|versions|example|examples|vs|versus|best|latest|new|migration|upgrade|panic|exception|cannot|failed|not|working)$/i;

export function gitHub(endpoint = 'https://api.github.com/search/repositories'): Engine {
  return {
    id: 'github',
    name: 'GitHub',
    family: 'github',
    gapMs: 3_500,
    kind: 'api',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      // The search is an AND over every word: a sentence finds nothing. The subject of the query finds the project (the
      // words that say what is wanted from it, and version numbers, are left out), and the most starred is usually the
      // one meant.
      const subject = keywords(req.query).filter((k) => !ABOUT.test(k) && !/^v?\d+(?:\.\d+)*$/.test(k));
      url.searchParams.set('q', (subject.length ? subject : keywords(req.query)).slice(0, 2).join(' '));
      url.searchParams.set('sort', 'stars');
      url.searchParams.set('order', 'desc');
      url.searchParams.set('per_page', '6');
      const got = await page(fetch, url.href, { headers: { 'User-Agent': 'Atelier (self-hosted assistant)', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }, signal);
      if ('failed' in got) return got.failed;
      if (got.status === 403 || got.status === 429) return { outcome: 'blocked', reason: `GitHub answered HTTP ${got.status} (its rate limit)` };
      if (got.status >= 400) return { outcome: 'error', reason: `GitHub answered HTTP ${got.status}` };
      const results = parseGitHub(got.body).filter((r) => aboutQuery(req.query, r, 0.3));
      return results.length ? { outcome: 'ok', results } : { outcome: 'empty' };
    },
  };
}
