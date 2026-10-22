// Checks the built documentation (dist/) for broken internal links and anchors: `pnpm --filter @atelier/docs run check`
// after `build`. External links are not fetched. Exits 1 and lists every problem.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const pages = (await readdir(dist, { recursive: true })).filter((f) => f.endsWith('.html')).map((f) => f.split('\\').join('/'));
const ids = new Map();
const html = new Map();
for (const page of pages) {
  const text = await readFile(join(dist, page), 'utf8');
  html.set(page, text);
  ids.set(page, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

const exists = async (path) => stat(path).then((s) => s.isFile(), () => false);
const problems = [];
let checked = 0;
for (const [page, text] of html) {
  for (const m of text.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (/^(https?:|mailto:|tel:|data:|javascript:|#?$)/.test(raw)) continue;
    const [pathPart, hash] = raw.split('#');
    const from = '/' + dirname(page);
    const target = pathPart ? resolve(pathPart.startsWith('/') ? '/' : from + '/', pathPart.startsWith('/') ? pathPart.slice(1) : pathPart) : '/' + page;
    const rel = target.replace(/^\//, '');
    const candidates = [rel, join(rel, 'index.html'), rel + '.html'];
    let found = null;
    for (const c of candidates) if (await exists(join(dist, c))) { found = c; break; }
    checked++;
    if (!found) {
      problems.push(`${page}: ${raw} (no such file)`);
      continue;
    }
    if (hash && found.endsWith('.html') && !ids.get(found)?.has(decodeURIComponent(hash))) problems.push(`${page}: ${raw} (no anchor #${hash} in ${found})`);
  }
}
console.log(`${pages.length} pages, ${checked} internal links checked`);
if (problems.length) {
  console.log(`\n${problems.length} problems:\n${[...new Set(problems)].join('\n')}`);
  process.exit(1);
}
console.log('No broken internal links or anchors.');
