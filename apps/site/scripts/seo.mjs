#!/usr/bin/env node
/**
 * Writes what search engines and AI agents read on atelierhq.dev, from one place:
 *   public/compare/**     the comparison pages (data: compare-data.mjs)
 *   public/llms.txt       a plain-text map of the site for AI agents
 *   public/sitemap.xml    every page with the date it last changed
 *
 *   node apps/site/scripts/seo.mjs           write them
 *   node apps/site/scripts/seo.mjs --check   fail when a page in the repo is not what the data says (CI and tests)
 *
 * The release runs it after `releases.mjs` and before deploying, so the sitemap carries the release's date.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATELIER, CHECKED, CHECKED_TEXT, HUB, HUB_SOURCES, PAGES, POWER, ROW_LABELS, ROW_ORDER, SITE } from './compare-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PUBLIC = join(here, '../public');
const ISSUES = 'https://github.com/TheOriUHD/atelier/issues/new';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const read = (file) => readFileSync(join(PUBLIC, file), 'utf8');

/** The shared pieces, taken from the download page so the pages can't drift from the rest of the site. */
function shell() {
  const page = read('download/index.html');
  const between = (from, to) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)) + to.length);
  const sprite = between('<svg class="sprite"', '</svg>\n\n<header');
  const header = between('<header class="site-header"', '</header>')
    .replace(' aria-current="page"', '')
    .replace('href="#server"', 'href="/#self-host"');
  const footer = between('<footer class="site-footer">', '</footer>');
  return { sprite: sprite.replace(/\n\n<header$/, ''), header, footer };
}

/** The apps page's own stylesheet carries a hash of itself, so a change to it always reaches a browser that kept the old one. */
const appsCssVersion = () => createHash('sha256').update(read('apps.css')).digest('hex').slice(0, 8);

const version = () => /styles\.css\?v=([\w.-]+)/.exec(read('index.html'))?.[1] ?? '';

function layout({ path, title, description, body, graph, apps = false }) {
  const { sprite, header: shared, footer } = shell();
  // The apps page has its own stylesheet and marks its own place in the header.
  const header = apps ? shared.replace('<a href="/apps/">Apps</a>', '<a href="/apps/" aria-current="page">Apps</a>') : shared;
  const url = `${SITE}${path}`;
  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Atelier</title>
<meta name="description" content="${esc(description)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fcfcfb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151515" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/source-serif-4-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>
<script src="/theme.js"></script>
<link rel="stylesheet" href="/styles.css?v=${version()}">
${apps ? `<link rel="stylesheet" href="/apps.css?v=${appsCssVersion()}">\n` : ''}</head>
<body>
<a class="skip" href="#main">Skip to content</a>

${sprite}

${header}

<main id="main" class="${apps ? 'apps-page' : 'section'}">
  <div class="wrap${apps ? '' : ' compare'}">
${body}
  </div>
</main>

${footer}

<script src="/site.js" defer></script>
</body>
</html>
`;
  return head;
}

const link = ([label, href]) => `<a href="${esc(href)}">${esc(label)}</a>`;
const list = (items) => `<ul>\n${items.map((i) => `      <li>${esc(i)}</li>`).join('\n')}\n    </ul>`;

function comparePage(p) {
  // A row appears where the page we read said something; what it didn't say is left out, not guessed.
  const rows = ROW_ORDER.filter((key) => p.facts[key]).map((key) => `        <tr><th scope="row">${esc(ROW_LABELS[key])}</th><td>${esc(ATELIER[key])}</td><td>${esc(p.facts[key])}</td></tr>`).join('\n');
  const metaTitle = p.metaTitle ?? p.title;
  const others = PAGES.filter((o) => o.slug !== p.slug).map((o) => `<a href="/compare/${o.slug}/">${esc(o.name)}</a>`).join(', ');
  const body = `    <p class="crumbs"><a href="/compare/">Compare</a> / Atelier vs ${esc(p.name)}</p>
    <h1>${esc(p.title)}</h1>
    <p class="lead">${esc(p.short)}</p>
    <p class="fine">Facts about ${esc(p.name)} checked on ${CHECKED_TEXT}, from its own pages (listed at the end). Spotted a mistake? <a href="${ISSUES}">Tell us</a>.</p>
    ${p.about.map((t) => `<p>${esc(t)}</p>`).join('\n    ')}

    <h2>At a glance</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col"><span class="visually-hidden">Feature</span></th><th scope="col">Atelier</th><th scope="col">${esc(p.name)}</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>

    <h2>Easy to start, and nothing you give up</h2>
    <p>Atelier asks little at the start. It is also a lot of app: this is what you have once it is running.</p>
    ${list(POWER)}

    <h2>Where ${esc(p.name)} is stronger</h2>
    ${list(p.strongerThem)}

    <h2>Where Atelier is different</h2>
    ${list(p.strongerUs)}

    <h2>Choose ${esc(p.name)} if</h2>
    ${list(p.chooseThem)}

    <h2>Choose Atelier if</h2>
    ${list(p.chooseUs)}
    <p><a class="btn btn-primary" href="/download/">Download Atelier</a> <a class="btn btn-quiet" href="https://docs.atelierhq.dev/getting-started/">Get started</a></p>

    <h2>Sources</h2>
    <p class="fine">Read on ${CHECKED_TEXT}. Atelier’s side is from its <a href="https://docs.atelierhq.dev/">documentation</a>.</p>
    <ul class="sources">
${p.sources.map((s) => `      <li>${link(s)}</li>`).join('\n')}
    </ul>
    <p>More comparisons: <a href="/compare/">all of them</a>, ${others}.</p>`;
  return layout({
    path: `/compare/${p.slug}/`,
    title: metaTitle,
    description: p.description,
    body,
    graph: [
      { '@type': 'WebPage', '@id': `${SITE}/compare/${p.slug}/`, url: `${SITE}/compare/${p.slug}/`, name: metaTitle, description: p.description, dateModified: CHECKED, isPartOf: { '@id': `${SITE}/#website` }, about: { '@id': `${SITE}/#app` } },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Atelier', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Compare', item: `${SITE}/compare/` },
          { '@type': 'ListItem', position: 3, name: p.title, item: `${SITE}/compare/${p.slug}/` },
        ],
      },
    ],
  });
}

function hubPage() {
  const title = 'Atelier vs Open WebUI, LibreChat, LM Studio and more: easy to start, still powerful';
  const description = 'Atelier next to Open WebUI, LibreChat, LM Studio, AnythingLLM, Jan and Msty: how much setup each asks for, licence, coding agents, accounts and telemetry. Checked on 16 November 2026.';
  const cell = (h) => (h.slug ? `<a href="/compare/${h.slug}/">${esc(h.name)}</a>` : esc(h.name));
  const rows = HUB.map(
    (h) => `        <tr><th scope="row">${cell(h)}</th><td>${esc(h.start)}</td><td>${esc(h.licence)}</td><td>${esc(h.run)}</td><td>${esc(h.agent)}</td><td>${esc(h.accounts)}</td><td>${esc(h.telemetry)}</td></tr>`,
  ).join('\n');
  const body = `    <h1>Atelier compared with other self-hosted and local AI apps</h1>
    <p class="lead">Atelier is meant to be easy to start and still powerful. There are good ways to run AI on your own computer or server, and some ask a lot of you before the first message: containers, config files, networking. This is a plain comparison, from each project’s own pages, of how much each asks at the start and what it can do, next to six others.</p>
    <p class="fine">Facts checked on ${CHECKED_TEXT}. Spotted a mistake? <a href="${ISSUES}">Tell us</a>.</p>

    <h2>At a glance</h2>
    <div class="table-wrap">
      <table class="wide">
        <thead><tr><th scope="col">App</th><th scope="col">Getting started</th><th scope="col">Licence</th><th scope="col">Runs as</th><th scope="col">Agents and coding</th><th scope="col">Accounts</th><th scope="col">Telemetry</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>

    <h2>Side by side</h2>
    <ul>
${PAGES.map((p) => `      <li><a href="/compare/${p.slug}/">${esc(p.title)}</a>: ${esc(p.hubLine)}</li>`).join('\n')}
    </ul>

    <h2>Easy to start</h2>
    <p>${esc(ATELIER.start)} ${esc(ATELIER.connect)} ${esc(ATELIER.updates)}</p>

    <h2>And nothing you give up</h2>
    ${list(POWER)}
    <p>${esc(ATELIER.run)} ${esc(ATELIER.telemetry)}</p>
    <p><a class="btn btn-primary" href="/download/">Download Atelier</a> <a class="btn btn-quiet" href="https://docs.atelierhq.dev/getting-started/">Get started</a></p>

    <h2>Sources</h2>
    <p class="fine">Read on ${CHECKED_TEXT}. Each comparison page lists its own.</p>
    <ul class="sources">
${HUB_SOURCES.map((s) => `      <li>${link(s)}</li>`).join('\n')}
    </ul>`;
  return layout({
    path: '/compare/',
    title,
    description,
    body,
    graph: [
      { '@type': 'WebPage', '@id': `${SITE}/compare/`, url: `${SITE}/compare/`, name: title, description, dateModified: CHECKED, isPartOf: { '@id': `${SITE}/#website` }, about: { '@id': `${SITE}/#app` } },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Atelier', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Compare', item: `${SITE}/compare/` },
        ],
      },
    ],
  });
}

/** The apps page: every way to use Atelier, as tiles. Statuses are the truth today; change them here when a store approves an app. */
const APPS_URL = {
  chrome: 'https://chromewebstore.google.com/detail/atelier-for-chrome/efpchbhecdgeeadmefahpgidnfplajln',
  firefox: 'https://addons.mozilla.org/firefox/addon/atelier-for-firefox/',
};
const ICON_ARROW = '<svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg>';
const tile = ({ id, cls, icon, status, soon, title, text, meta, actions, extra, shot }) => `    <article class="app ${cls}" id="${id}">
      <div class="app-top"><span class="app-icon"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg></span><span class="status ${soon ? 'status-soon' : 'status-live'}">${esc(status)}</span></div>
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
${meta ? `      <p class="app-meta">${esc(meta)}</p>\n` : ''}${extra ?? ''}${actions ? `      <div class="app-actions">${actions}</div>\n` : ''}${shot ?? ''}    </article>`;
const go = (href, label, primary = false) => (primary ? `<a class="btn btn-primary btn-sm" href="${esc(href)}">${esc(label)}</a>` : `<a class="app-link" href="${esc(href)}">${esc(label)}${ICON_ARROW}</a>`);

function appsPage() {
  const title = 'All the ways to use Atelier: desktop, phone, browser, terminal and server';
  const description = 'Atelier for macOS, Windows and Linux, for iPhone and iPad, in a browser from your own server, in your terminal, and as extensions for Chrome and Firefox.';
  const tiles = [
    tile({
      id: 'desktop', cls: 'app-desktop', icon: 'i-window', status: 'Available', title: 'Desktop app',
      text: 'Chat and Code in a window on your Mac, Windows PC or Linux computer, with the models you choose, local or hosted. It works on its own, or connects to your Atelier server.',
      meta: 'macOS, Windows and Linux. Free for noncommercial use.',
      actions: `${go('/download/#desktop', 'Download', true)}${go('https://docs.atelierhq.dev/getting-started/', 'Getting started')}`,
      shot: `      <div class="app-shot"><picture><img src="/img/chat-1280.webp" srcset="/img/chat-1280.webp 1280w, /img/chat-2560.webp 2560w" sizes="(min-width: 900px) 640px, 100vw" width="4080" height="2550" alt="The Atelier desktop app showing a conversation" loading="lazy"></picture></div>\n`,
    }),
    tile({
      id: 'ios', cls: 'app-phone', icon: 'i-phone', status: 'Coming to the App Store', soon: true, title: 'iPhone and iPad',
      text: 'Your conversations and Code sessions on your phone, from your own server. Small models can run on the phone itself.',
      meta: 'Atelier for iPhone and iPad. It is waiting for the App Store.',
      shot: `      <div class="app-shot"><picture><img src="/img/phone-code-640.webp" srcset="/img/phone-code-640.webp 640w, /img/phone-code-1160.webp 1160w" sizes="260px" width="1160" height="2521" alt="Atelier on an iPhone, listing the computers and Code sessions" loading="lazy"></picture></div>\n`,
    }),
    tile({
      id: 'web', cls: 'app-half', icon: 'i-server', status: 'Available', title: 'In your browser, from your server',
      text: 'Run the Atelier server once, with Docker, and everyone you give an account opens it in any browser: the same Chat and Code, nothing to install on the device.',
      meta: 'For you alone or for a team, with accounts, limits and single sign-on.',
      actions: `${go('/download/#server', 'Get the server', true)}${go('https://docs.atelierhq.dev/self-hosting/', 'Self-hosting guide')}`,
    }),
    tile({
      id: 'terminal', cls: 'app-half', icon: 'i-terminal', status: 'Available', title: 'Terminal app',
      text: 'A Code session where you already work, in any terminal and over SSH, with the same tools, permissions and models as the desktop app.',
      extra: `      <code class="app-command"><small>macOS and Linux</small>curl -fsSL https://updates.atelierhq.dev/cli | sh</code>\n      <code class="app-command"><small>Windows</small>irm https://updates.atelierhq.dev/cli.ps1 | iex</code>\n`,
      actions: `${go('/download/#cli', 'More about the terminal app')}${go('https://docs.atelierhq.dev/cli/', 'Guide')}`,
    }),
    tile({
      id: 'chrome', cls: 'app-half', icon: 'i-puzzle', status: 'Available', title: 'Atelier for Chrome',
      text: 'Lets Atelier open web pages in tabs of its own, read them and fill in forms you asked it to, while you keep using your browser. It needs the Atelier desktop app on the same computer.',
      meta: 'Chrome, Brave, Edge and Arc.',
      actions: `${go(APPS_URL.chrome, 'Chrome Web Store', true)}${go('https://docs.atelierhq.dev/computer-use/#web-pages-atelier-for-chrome', 'How it works')}`,
    }),
    tile({
      id: 'firefox', cls: 'app-half', icon: 'i-puzzle', status: 'Available', title: 'Atelier for Firefox',
      text: 'The same extension for Firefox: its own tabs, in a group named after the chat, never your own tabs. It needs the Atelier desktop app on the same computer.',
      meta: 'Firefox 140 or later.',
      actions: `${go(APPS_URL.firefox, 'Firefox Add-ons', true)}${go('https://docs.atelierhq.dev/computer-use/#atelier-for-firefox', 'How it works')}`,
    }),
  ].join('\n');
  const body = `    <div class="apps-intro">
      <h1>Atelier on every device</h1>
      <p class="lead">The desktop app, your browser, your phone and your terminal open the same workspace. Use whichever suits the moment.</p>
    </div>
    <svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
      <symbol id="i-phone" viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></symbol>
      <symbol id="i-puzzle" viewBox="0 0 24 24"><path d="M9.5 4.5a2 2 0 1 1 4 0V6H18a1 1 0 0 1 1 1v3.5h-1.5a2 2 0 1 0 0 4H19V18a1 1 0 0 1-1 1h-3.5v-1.5a2 2 0 1 0-4 0V19H7a1 1 0 0 1-1-1v-3.5H4.5a2 2 0 1 1 0-4H6V7a1 1 0 0 1 1-1h2.5V4.5Z"/></symbol>
    </svg>
    <div class="apps-grid">
${tiles}
    </div>
    <section class="apps-fit" aria-labelledby="fit">
      <h2 id="fit">How they fit together</h2>
      <div class="fit-cols">
        <div><h3>On their own</h3><p>The desktop app and the terminal app run by themselves, with your own models and keys. There is nothing to host and no account to make.</p></div>
        <div><h3>With a server</h3><p>Sign in to the same Atelier server from every app and browser, and your conversations, projects and Code sessions on your own computers are there on each one.</p></div>
        <div><h3>Extensions</h3><p>The browser extensions talk to the desktop app on the same computer. What a page shows goes to the desktop app and from there to the model you chose, and nowhere else.</p></div>
      </div>
      <div class="apps-cta"><a class="btn btn-primary" href="/download/">Download</a><a class="btn btn-quiet" href="https://docs.atelierhq.dev/getting-started/">Get started</a></div>
    </section>`;
  return layout({
    path: '/apps/',
    title,
    description,
    body,
    apps: true,
    graph: [
      { '@type': 'WebPage', '@id': `${SITE}/apps/`, url: `${SITE}/apps/`, name: title, description, isPartOf: { '@id': `${SITE}/#website` }, about: { '@id': `${SITE}/#app` } },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Atelier', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: 'Apps', item: `${SITE}/apps/` },
        ],
      },
    ],
  });
}

function llmsTxt() {
  return `# Atelier

> Atelier is an AI workspace that is easy to start and still powerful: Chat and Code on the models you choose, local (Ollama, llama.cpp, LM Studio) or hosted (Anthropic, OpenAI, Mistral, GitHub Copilot, OpenRouter, any OpenAI-compatible endpoint). Download the app, open it and type your name: no Docker, config files or account. It finds the models you already run, updates itself, and has MCP, skills, image, video and audio generation, dictation, computer use and a server mode with accounts. Desktop apps for macOS, Windows and Linux, a web app you host with Docker and a terminal app share one backend. Source-available under the PolyForm Noncommercial license (free for noncommercial use). No telemetry.

Atelier is an independent project, not affiliated with any model provider. The website is atelierhq.dev, the documentation docs.atelierhq.dev and the source github.com/TheOriUHD/atelier.

## Start here
- [Download](${SITE}/download/): desktop apps, the terminal app and the Docker server
- [All the ways to use Atelier](${SITE}/apps/): the desktop app, iPhone and iPad, a browser, the terminal app, the server and the Chrome and Firefox extensions
- [Get started](https://docs.atelierhq.dev/getting-started/): install, connect a model, first conversation
- [Documentation](https://docs.atelierhq.dev/): every feature, the settings and the self-hosting guide
- [Documentation for language models](https://docs.atelierhq.dev/llms.txt): an index of the documentation pages in Markdown, and [the whole documentation in one file](https://docs.atelierhq.dev/llms-full.txt)

## Compared with other apps
- [All comparisons](${SITE}/compare/): Atelier next to Open WebUI, LibreChat, LM Studio, AnythingLLM, Jan and Msty, with how much setup each asks for
${PAGES.map((p) => `- [${p.title}](${SITE}/compare/${p.slug}/): ${p.description.replace(/ Facts checked.*$/, '')}`).join('\n')}

## Source and releases
- [GitHub](https://github.com/TheOriUHD/atelier): source, issues and releases
- [Releases](https://github.com/TheOriUHD/atelier/releases): the changelog of every version
- [System prompts](https://docs.atelierhq.dev/prompts/): every prompt Atelier sends to a model, published as it is

## Optional
- [Privacy](https://docs.atelierhq.dev/privacy/): what leaves your computer and when
- [FAQ](https://docs.atelierhq.dev/faq/): short answers about cost, models, privacy and platforms
`;
}

const gitDate = (file) => {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: PUBLIC, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

export function sitemap() {
  const releases = existsSync(join(PUBLIC, 'releases.json')) ? JSON.parse(read('releases.json')) : null;
  const download = releases?.publishedAt?.slice(0, 10) ?? gitDate('download/index.html');
  const urls = [
    ['/', gitDate('index.html') || CHECKED],
    ['/download/', download || CHECKED],
    ['/apps/', gitDate('apps/index.html') || CHECKED],
    ['/compare/', CHECKED],
    ...PAGES.map((p) => [`/compare/${p.slug}/`, CHECKED]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([path, date]) => `  <url><loc>${SITE}${path}</loc><lastmod>${date}</lastmod></url>`).join('\n')}
</urlset>
`;
}

/** Every generated file but the sitemap (whose dates come from git and the release), by path under public/. */
export function files() {
  return {
    'apps/index.html': appsPage(),
    'compare/index.html': hubPage(),
    ...Object.fromEntries(PAGES.map((p) => [`compare/${p.slug}/index.html`, comparePage(p)])),
    'llms.txt': llmsTxt(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [path, content] of Object.entries({ ...files(), 'sitemap.xml': sitemap() })) {
    const file = join(PUBLIC, path);
    const now = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (path === 'sitemap.xml' && check) continue;
    if (now === content) continue;
    if (check) {
      console.error(`${path} is out of date: run node apps/site/scripts/seo.mjs`);
      stale++;
    } else {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
      console.log(`wrote ${path}`);
    }
  }
  if (stale) process.exit(1);
}
