/**
 * `pnpm --filter @atelier/core exec tsx evals/search.ts` (Node's `fetch`, the web server's floor), or bundled and run
 * under Electron (`--chromium`, what the desktop app does): ten real queries through the built-in web search, against the
 * live engines, at the pace the app uses. Prints which engine answered each one, how many results and how long it took,
 * so a change in an engine's markup or behaviour shows up here before it shows up in a chat. Opt-in: it uses the network
 * and a handful of search requests; it is never part of CI.
 *
 * It uses Node's `fetch`, which is what the web server has. The desktop app uses Chromium's network stack instead and
 * does better; this is the floor.
 */
import { createRequire } from 'node:module';
import { SearchService, SearchUnavailable } from '../src/search/service.ts';
import type { Fetcher } from '../src/search/types.ts';

const QUERIES = [
  'tokio async runtime',
  'who is the ceo of nvidia',
  'postgres vacuum full vs analyze',
  'python 3.14 release date',
  'sveltekit form actions docs',
  'how to cook basmati rice',
  'electron utilityProcess net module',
  'kubernetes ingress nginx retirement',
  'weather in berlin tomorrow',
  'qzxvw lkjhgf zzqqxx wplmnb',
];

/** Under Electron the result pages go through Chromium's network stack, as in the desktop app. */
async function chromium(): Promise<{ webFetch: Fetcher; quit(): void } | null> {
  if (!process.versions.electron) return null;
  // Bundled to CommonJS for Electron there is no import.meta; `__filename` is what a bundle has.
  const load = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  const { app, net } = load('electron') as { app: { whenReady(): Promise<void>; quit(): void }; net: { fetch: Fetcher } };
  await app.whenReady();
  return {
    webFetch: (url, init) => net.fetch(url, { ...init, credentials: 'omit', headers: { ...(init.headers as Record<string, string>), 'User-Agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36` } }),
    quit: () => app.quit(),
  };
}

async function main() {
  const browser = await chromium();
  console.log(browser ? 'transport: Chromium (net.fetch)' : 'transport: Node fetch');
  const service = new SearchService({ fetch: (url, init) => fetch(url, init), ...(browser ? { webFetch: browser.webFetch } : {}), config: async () => ({ provider: 'auto' }) });
  let answered = 0;
  const byEngine = new Map<string, number>();
  for (const query of QUERIES) {
    const started = Date.now();
    try {
      const a = await service.search({ query }, AbortSignal.timeout(60_000));
      const ms = Date.now() - started;
      if (a.results.length) {
        answered++;
        byEngine.set(a.engine, (byEngine.get(a.engine) ?? 0) + 1);
      }
      console.log(`${a.results.length ? 'ok  ' : 'none'} ${String(ms).padStart(5)} ms  ${a.engine.padEnd(22)} ${query}${a.note ? '  [' + a.note.slice(0, 50) + '…]' : ''}`);
      if (a.results[0]) console.log(`       ${a.results[0].title.slice(0, 70)} — ${a.results[0].url.slice(0, 70)}`);
    } catch (e) {
      console.log(`FAIL ${String(Date.now() - started).padStart(5)} ms  ${(e instanceof SearchUnavailable ? e.kind : 'error').padEnd(22)} ${query}  ${(e as Error).message.slice(0, 60)}`);
    }
  }
  console.log(`\n${answered}/${QUERIES.length} answered (the last query has no results on purpose)`, Object.fromEntries(byEngine));
  console.log(JSON.stringify(await service.status()));
  browser?.quit();
}

void main();
