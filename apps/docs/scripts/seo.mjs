// Runs after `astro build`, before headers.mjs: what search engines and AI agents read besides the pages themselves.
//   dist/<page>.md     every page as Markdown (the page's <link rel="alternate"> points at it)
//   dist/llms.txt      an index of those, in the sidebar's order, as https://llmstxt.org describes
//   dist/llms-full.txt the guides in one file (the system prompts and the long references stay out: they are in llms.txt)
//   dist/sitemap-0.xml gets a <lastmod> for each page: the date of the last commit that touched its source
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIDEBAR } from '../src/sidebar.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const content = join(root, 'src/content/docs');
const SITE = 'https://docs.atelierhq.dev';

/** Pages whose text is too long to repeat in llms-full.txt. */
const LONG = (slug) => slug.startsWith('prompts') || slug === 'reference/tools' || slug === 'reference/settings';

function sourceOf(slug) {
  for (const file of [`${slug}.md`, `${slug}.mdx`, `${slug}/index.md`, `${slug}/index.mdx`]) if (existsSync(join(content, file))) return join(content, file);
  return null;
}

/** A frontmatter value: plain, "double" or 'single' quoted. */
function field(front, key) {
  const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(front)?.[1]?.trim();
  if (!line) return '';
  if (line.startsWith('"')) {
    try {
      return JSON.parse(line);
    } catch {
      return line.slice(1, -1);
    }
  }
  if (line.startsWith("'")) return line.slice(1, -1).replace(/''/g, "'");
  return line;
}

function page(slug) {
  const file = sourceOf(slug);
  if (!file) return null;
  const raw = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const front = m?.[1] ?? '';
  return { slug, file, title: field(front, 'title') || slug, description: field(front, 'description'), body: m?.[2] ?? raw };
}

/** The page's Markdown for a reader that isn't a browser: links absolute, pictures as their text, asides as labels. */
function markdown(p) {
  const body = p.body
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `_${alt}_` : ''))
    .replace(/\]\(\/([^)]*)\)/g, `](${SITE}/$1)`)
    .replace(/^:::(\w+)(?:\[([^\]]*)\])?\s*$/gm, (_, kind, title) => `**${title || kind[0].toUpperCase() + kind.slice(1)}:**`)
    .replace(/^:::\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `# ${p.title}\n\n${p.description ? `> ${p.description}\n\n` : ''}${body}\n`;
}

const slugs = SIDEBAR.flatMap((group) => group.items);
// Every page that has a source gets its Markdown (the ones outside the sidebar too, such as the page for Cowork).
const everything = [...new Set([...slugs, ...(await readdir(content, { recursive: true })).filter((f) => /\.mdx?$/.test(f)).map((f) => f.replace(/(\/index)?\.mdx?$/, '')).filter((slug) => slug && slug !== 'index')])];
const pages = slugs.map(page).filter(Boolean);

for (const p of everything.map(page).filter(Boolean)) {
  const out = join(dist, `${p.slug}.md`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, markdown(p));
}

const summary =
  'Atelier is a self-hosted AI workspace with Chat and Code, on the models you choose: local (Ollama, llama.cpp, LM Studio) or hosted. Desktop apps for macOS, Windows and Linux, a web app you host with Docker and a terminal app share one backend. Source-available (PolyForm Noncommercial), no telemetry.';

const index = [
  '# Atelier documentation',
  '',
  `> ${summary}`,
  '',
  `The website is https://atelierhq.dev. Every page below is also a Markdown file at its address plus \`.md\`. The guides in one file: ${SITE}/llms-full.txt.`,
  '',
  ...SIDEBAR.flatMap((group) => [
    `## ${group.label}`,
    ...group.items.map(page).filter(Boolean).map((p) => `- [${p.title}](${SITE}/${p.slug}.md)${p.description ? `: ${p.description}` : ''}`),
    '',
  ]),
].join('\n');
await writeFile(join(dist, 'llms.txt'), index);

const full = [
  '# Atelier documentation',
  '',
  `> ${summary}`,
  '',
  `The guides, in the order of the documentation's sidebar. The system prompts and the references for tools and settings are not repeated here: they are listed in ${SITE}/llms.txt.`,
  '',
  ...pages.filter((p) => !LONG(p.slug)).flatMap((p) => ['---', '', `Source: ${SITE}/${p.slug}/`, '', markdown(p)]),
].join('\n');
await writeFile(join(dist, 'llms-full.txt'), full);

// The sitemap: a date for each page.
const gitDate = (file) => {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const sitemapFile = join(dist, 'sitemap-0.xml');
let dated = 0;
if (existsSync(sitemapFile)) {
  const xml = await readFile(sitemapFile, 'utf8');
  const next = xml.replace(/<url><loc>([^<]*)<\/loc>(?:<lastmod>[^<]*<\/lastmod>)?<\/url>/g, (whole, loc) => {
    const slug = loc.replace(SITE, '').replace(/^\/|\/$/g, '') || 'index';
    const file = sourceOf(slug);
    const date = file ? gitDate(file) : '';
    if (!date) return whole;
    dated++;
    return `<url><loc>${loc}</loc><lastmod>${date}</lastmod></url>`;
  });
  await writeFile(sitemapFile, next);
}
console.log(`seo: ${everything.length} Markdown pages, llms.txt, llms-full.txt (${Math.round(full.length / 1000)} kB), ${dated} sitemap dates`);
