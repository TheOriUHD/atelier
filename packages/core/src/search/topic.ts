/**
 * What a query is about, from its words alone: the news, programming, or anything else. A search about last week's
 * event is answered by the news feeds, one about an error message by the developer communities, and the general web
 * engines are always asked as well when the topic is unsure. The model can name the topic itself (the tool's `topic`
 * parameter); this is for the many times it doesn't.
 */
import type { Topic } from './types.ts';

/** Words that mean "something happened lately". */
const NEWS_STRONG =
  /\b(?:news|breaking|headlines?|today|tonight|yesterday|this (?:week|weekend|morning|month)|last (?:week|weekend|night|month)|who won|recap|announced?|announces|announcement|unveil(?:s|ed|ing)?|keynote|rumou?rs?|leaks?|leaked|earnings|just (?:released|launched|announced|dropped)|press release|live ?stream|live ?blog|results? of the|what happened)\b/i;
/** Words that often go with news but also with ordinary pages. */
const NEWS_WEAK =
  /\b(?:latest|event|winners?|standings|launch(?:es|ed)?|releases?|released|release date|reveal(?:s|ed)?|election|lawsuit|ruling|verdict|outage|acquires?|acquisition|merger|layoffs?|strike|protest|scandal|summit|trailer|finale|ceasefire|sanctions?|recall|investigation|update on|new)\b/i;

/** Failures and stack traces: the heart of a programming question. */
const DEV_ERROR = /\b(?:error|exception|traceback|stack ?trace|segfault|segmentation fault|panic(?:ked|s)?|null ?pointer|deprecat\w*|unhandled|compil(?:e|er|ation) (?:error|fail\w*)|linker|syntax error|undefined (?:reference|symbol|is not)|cannot find module|not a function|command not found|permission denied|exit code)\b/i;
const DEV_TECH =
  /\b(?:npm|pnpm|yarn|pip3?|pipx|cargo|crates?|rubygems|composer|maven|gradle|docker(?:file)?|compose|kubernetes|k8s|helm|terraform|ansible|github|gitlab|git (?:rebase|merge|stash|bisect|submodule|cherry-pick)|api|sdk|cli|regex|sql|graphql|json|yaml|toml|typescript|javascript|python|rust|golang|java|kotlin|swiftui|c\+\+|c#|php|ruby|rails|django|flask|fastapi|react|vue|svelte|angular|next\.?js|nuxt|node\.?js|deno|bun|vite|webpack|eslint|tailwind|css|html|linux|ubuntu|debian|bash|zsh|powershell|systemd|nginx|caddy|postgres(?:ql)?|mysql|sqlite|redis|mongodb|kafka|ssl|tls|cors|jwt|oauth|ssh|websocket|tcp|dns|llvm|gcc|wasm|webassembly|cuda|pytorch|tensorflow|llm|ollama|llama\.cpp|electron|hono|vitest|playwright)\b/gi;
/** Code-shaped tokens: `foo::bar`, `useEffect`, `--flag`, `file.tsx`, backticks. */
const DEV_SHAPE = /\w+::\w+|\b[a-z]{3,}[A-Z]\w+\b|\b\w+\(\)|(?:^|\s)--?[a-z][\w-]{2,}|\.(?:tsx?|jsx?|py|rs|go|java|kt|rb|php|cpp|ya?ml|toml|json|sh)\b|`[^`]+`/;

/** Questions the general engines answer better than any feed, whatever else the words say ("weather today"). */
const ORDINARY = /\b(?:weather|forecast|temperature|time in|time zone|convert|conversion|define|definition|meaning of|translate|translation|exchange rate|stock price|opening hours|near me|recipe|directions to)\b/i;

function distinct(re: RegExp, text: string): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return new Set([...text.matchAll(new RegExp(re.source, flags))].map((m) => m[0].toLowerCase())).size;
}

function scores(query: string, now: Date): { news: number; dev: number; ordinary: boolean } {
  const year = now.getFullYear();
  const years = [...query.matchAll(/\b(20\d\d)\b/g)].map((m) => Number(m[1]));
  return {
    news: 2 * distinct(NEWS_STRONG, query) + distinct(NEWS_WEAK, query) + (years.some((y) => y >= year - 1 && y <= year + 1) ? 1 : 0),
    dev: 2 * distinct(DEV_ERROR, query) + distinct(DEV_TECH, query) + (DEV_SHAPE.test(query) ? 1 : 0),
    ordinary: ORDINARY.test(query),
  };
}

export function detectTopic(query: string, now: Date = new Date()): Topic {
  const { news, dev, ordinary } = scores(query, now);
  if (ordinary) return 'general';
  // "latest" and "new" next to a programming word are about the thing, not about the news: a tie goes to programming.
  if (news >= 2 && news > dev) return 'news';
  if (dev >= 1 && (news < 2 || dev >= news)) return 'dev';
  return 'general';
}

/**
 * A general query with one hint of news in it ("Apple event", "new iPhone"): not sure enough to send it to the news
 * feeds alone, but worth asking them too, because the general engines answer such a query with the company's own pages.
 */
export function leansNews(query: string, now: Date = new Date()): boolean {
  const { news, dev, ordinary } = scores(query, now);
  return !ordinary && news === 1 && dev === 0;
}
