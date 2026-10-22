/**
 * Stack Overflow's questions and answers through the Stack Exchange API (keyless, a few hundred requests a day per
 * address). It finds the error message, the exact API call, the question someone asked three years ago, which general
 * engines rarely do. The excerpt endpoint returns the matching passage, so no page has to be read for a snippet.
 */
import type { Attempt, Engine, SearchRequest, SearchResult } from '../types.ts';
import { clean, decodeEntities, isoDate } from '../text.ts';
import { page } from './common.ts';

interface Body {
  items?: {
    title?: string;
    excerpt?: string;
    item_type?: string;
    question_id?: number;
    answer_id?: number;
    answer_count?: number;
    is_answered?: boolean;
    has_accepted_answer?: boolean;
    score?: number;
    creation_date?: number;
    tags?: string[];
  }[];
  backoff?: number;
  quota_remaining?: number;
  error_name?: string;
}

export function parseStackExchange(body: string, origin = 'https://stackoverflow.com'): { results: SearchResult[]; blocked?: string } {
  let json: Body;
  try {
    json = JSON.parse(body) as Body;
  } catch {
    return { results: [] };
  }
  if (json.backoff) return { results: [], blocked: 'Stack Exchange asked for a pause' };
  if (json.error_name === 'throttle_violation' || json.quota_remaining === 0) return { results: [], blocked: "Stack Exchange's daily allowance for this address is used up" };
  const results = (json.items ?? []).flatMap((item) => {
    if (!item.title || !item.question_id) return [];
    const answers = item.answer_count ?? 0;
    const meta = `${answers} answer${answers === 1 ? '' : 's'}${item.has_accepted_answer ? ', one accepted' : ''}, score ${item.score ?? 0}${item.tags?.length ? `, tags: ${item.tags.slice(0, 5).join(', ')}` : ''}`;
    const passage = clean(decodeEntities((item.excerpt ?? '').replace(/<[^>]+>/g, '')), 380);
    const published = isoDate(item.creation_date);
    return [
      {
        title: clean(decodeEntities(item.title), 200),
        url: item.item_type === 'answer' && item.answer_id ? `${origin}/a/${item.answer_id}` : `${origin}/questions/${item.question_id}`,
        snippet: `${item.item_type === 'answer' ? 'Answer' : 'Question'} (${meta}). ${passage}`.trim(),
        source: 'Stack Overflow',
        ...(published ? { published } : {}),
      },
    ];
  });
  return { results };
}

export function stackExchange(endpoint = 'https://api.stackexchange.com/2.3/search/excerpts'): Engine {
  return {
    id: 'stack-exchange',
    name: 'Stack Overflow',
    family: 'stack-exchange',
    gapMs: 1_000,
    kind: 'api',
    async search(req: SearchRequest, fetch, signal): Promise<Attempt> {
      const url = new URL(endpoint);
      for (const [k, v] of Object.entries({ order: 'desc', sort: 'relevance', q: req.query, site: 'stackoverflow', pagesize: '8' })) url.searchParams.set(k, v);
      const got = await page(fetch, url.href, { headers: { 'User-Agent': 'Atelier (self-hosted assistant)', Accept: 'application/json' } }, signal);
      if ('failed' in got) return got.failed;
      const parsed = parseStackExchange(got.body);
      if (parsed.blocked || got.status === 429 || got.status === 502) return { outcome: 'blocked', reason: parsed.blocked ?? `Stack Exchange answered HTTP ${got.status}` };
      if (got.status >= 400) return { outcome: 'error', reason: `Stack Exchange answered HTTP ${got.status}` };
      return parsed.results.length ? { outcome: 'ok', results: parsed.results } : { outcome: 'empty' };
    },
  };
}
