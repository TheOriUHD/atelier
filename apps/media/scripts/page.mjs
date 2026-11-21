/** The media kit's page (index.html), from what build.mjs made. Same header, footer, fonts and tokens as atelierhq.dev. */
import { logos } from './brand.mjs';
import { ADDRESS, HEADLINE } from './banners.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rgb = (hex) => hex.slice(1).match(/../g).map((x) => parseInt(x, 16)).join(', ');

export function renderPage({ manifest, colors, zips, words, rel }) {
  const dl = (files) => files.map((f) => `<a href="${rel(f.path)}" download>${esc(f.label)}</a>`).join('');
  const sizes = (item) => [item.svg ? { label: 'SVG', path: item.svg } : null, ...(item.pngs ?? [])].filter(Boolean);

  const asset = (item, extraClass = '') => `
        <article class="asset${item.wide ? ' asset-wide' : ''}${extraClass}">
          <div class="pv pv-${item.bg ?? 'light'}"><img src="${rel(item.preview ?? item.svg)}" alt="${esc(item.title)}" loading="lazy"></div>
          <div class="meta">
            <h3>${esc(item.title)}</h3>
            ${item.desc ? `<p>${esc(item.desc)}</p>` : ''}
            <p class="dl">${dl(item.files ?? sizes(item))}</p>
          </div>
        </article>`;

  const group = (title, items) => `
      <h3 class="group">${esc(title)}</h3>
      <div class="assets">${items.map((i) => asset(i)).join('')}</div>`;

  const logoGroups = ['Horizontal', 'Stacked', 'Wordmark', 'Mark', 'Palette'].map((g) => ({ g, items: manifest.logos.filter((l) => l.group === g) }));
  const logoText = {
    Horizontal: 'Horizontal',
    Stacked: 'Stacked',
    Wordmark: 'Wordmark',
    Mark: 'Tile',
    Palette: 'Palette alone',
  };

  const bannerCard = (b) => `
        <article class="asset">
          <div class="pv pv-flat"><img src="${rel(b.preview)}" alt="${esc(b.title)}, ${esc(b.scheme)}" width="${b.w}" height="${b.h}" loading="lazy"></div>
          <div class="meta">
            <h3>${esc(b.title)}</h3>
            <p class="dim">${b.w} × ${b.h}</p>
            <p class="dl"><a href="${rel(b.path)}" download>PNG, ${b.bytes >= 1024 ? (b.bytes / 1024).toFixed(1) + ' MB' : b.bytes + ' KB'}</a></p>
          </div>
        </article>`;

  const schemeNames = { light: 'Light', dark: 'Dark', clay: 'Clay' };
  const bannerPanels = ['light', 'dark', 'clay']
    .map((s, i) => `
      <div class="panel" role="tabpanel" id="banners-${s}" aria-labelledby="tab-banners-${s}"${i ? '' : ''}>
        <div class="assets assets-banners">${manifest.banners.filter((b) => b.scheme === s).map(bannerCard).join('')}</div>
      </div>`)
    .join('');
  const bannerTabs = ['light', 'dark', 'clay']
    .map((s, i) => `<button class="tab" role="tab" type="button" id="tab-banners-${s}" aria-controls="banners-${s}" aria-selected="${i === 0}"${i ? ' tabindex="-1"' : ''}>${schemeNames[s]}</button>`)
    .join('');

  const wallpaperCards = (list) => list
    .map((b) => `
        <article class="asset${b.id === 'phone' ? ' asset-narrow' : ''}">
          <div class="pv pv-flat"><img src="${rel(b.preview)}" alt="${esc(b.title)}, ${esc(b.scheme)}" width="${b.w}" height="${b.h}" loading="lazy"></div>
          <div class="meta"><h3>${esc(b.title)}, ${esc(b.scheme)}</h3><p class="dim">${b.w} × ${b.h}</p><p class="dl"><a href="${rel(b.path)}" download>PNG</a></p></div>
        </article>`)
    .join('');

  const shotCard = (s, narrow) => `
        <article class="asset${narrow ? ' asset-narrow' : ''}">
          <div class="pv pv-flat"><img src="${rel(s.preview)}" alt="${esc(s.title)}" loading="lazy"></div>
          <div class="meta"><h3>${esc(s.title)}</h3>${s.desc ? `<p>${esc(s.desc)}</p>` : ''}<p class="dl">${dl(s.files)}</p></div>
        </article>`;

  const pipCards = manifest.pip.map((p) => asset({ ...p, preview: p.pngs[1].path })).join('');

  const swatches = colors
    .map(
      (c) => `
        <div class="sw-card">
          <div class="sw sw-${c.id}"></div>
          <div class="sw-meta">
            <h3>${esc(c.name)}</h3>
            <p class="codes"><button class="copy" type="button" data-copy="${c.hex}" aria-label="Copy ${esc(c.name)} hex">${c.hex}</button><span>RGB ${rgb(c.hex)}</span></p>
            <p>${esc(c.use)}</p>
          </div>
        </div>`,
    )
    .join('');

  const blocks = words.blocks
    .map(
      (b) => `
        <div class="copyblock">
          <div class="copyhead"><h3>${esc(b.title)}</h3><button class="copy" type="button" data-copy-from="#t-${b.id}">Copy</button></div>
          <p id="t-${b.id}">${esc(b.text)}</p>
        </div>`,
    )
    .join('');

  // The clear space, drawn: the horizontal logo with half the tile's height around it.
  const lockup = logos.horizontal({ style: 'gradient', wordFill: '#0B0B0B' }).replace(/<svg [^>]*>/, '<svg x="50" y="50" width="348" height="100" viewBox="0 0 348 100">');
  const clearSpace = `<svg class="clear" viewBox="0 0 448 200" role="img" aria-label="The logo with clear space of half the tile's height on every side"><rect class="clear-box" x="1" y="1" width="446" height="198" rx="6"/><rect class="clear-in" x="50" y="50" width="348" height="100"/>${lockup}</svg>`;

  const zipRows = zips.map((z) => `<li><a class="zip" href="/downloads/${z.name}" download><strong>${esc(z.name)}</strong><span>${esc(z.desc)}</span><span class="size">${z.mb} MB</span></a></li>`).join('');

  const list = (items) => items.map((t) => `<li>${esc(t)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atelier media kit: logos, icons, banners, screenshots</title>
<meta name="description" content="Atelier's logos in light, dark and transparent versions, app icons, banners and social images, wallpapers, screenshots, the mascot, colours and fonts, free to use when you write about Atelier.">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fcfcfb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#151515" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:title" content="Atelier media kit">
<meta property="og:description" content="Logos, app icons, banners, screenshots and the mascot, in light, dark and transparent versions.">
<meta property="og:url" content="https://media.atelierhq.dev/">
<meta property="og:image" content="https://media.atelierhq.dev${rel(manifest.banners.find((b) => b.id === 'open-graph' && b.scheme === 'light').path)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/kit/app-icons/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="https://media.atelierhq.dev/">
<link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/source-serif-4-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<script src="/theme.js"></script>
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/media.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></symbol>
  <symbol id="i-github" viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></symbol>
</svg>

<header class="site-header" id="top">
  <div class="wrap bar">
    <a class="brand" href="https://atelierhq.dev/" aria-label="Atelier, home"><img src="/kit/app-icons/favicon.svg" width="30" height="30" alt="">Atelier</a>
    <nav class="nav" aria-label="Media kit">
      <a href="#logos">Logos</a>
      <a href="#icons">App icons</a>
      <a href="#banners">Banners</a>
      <a href="#screenshots">Screenshots</a>
      <a href="#pip">Pip</a>
      <a href="#colors">Colors</a>
      <a href="#words">Words</a>
      <a href="#using">Using these</a>
    </nav>
    <div class="bar-end">
      <button class="icon-btn" id="theme" type="button" aria-label="Switch theme">
        <svg class="icon i-moon" aria-hidden="true"><use href="#i-moon"/></svg>
        <svg class="icon i-sun" aria-hidden="true"><use href="#i-sun"/></svg>
      </button>
      <a class="icon-btn" href="https://github.com/TheOriUHD/atelier" aria-label="Atelier on GitHub"><svg class="icon icon-fill" aria-hidden="true"><use href="#i-github"/></svg></a>
      <a class="btn btn-primary btn-sm" href="https://atelierhq.dev/download/">Download</a>
    </div>
  </div>
</header>

<main id="main">
  <section class="hero">
    <div class="wrap">
      <h1>Media kit</h1>
      <p class="lead">Logos, app icons, banners, screenshots and the mascot, with a light, a dark and a transparent version of everything you would put on a page. Free to use when you write about Atelier.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/downloads/${zips[0].name}" download><svg class="icon" aria-hidden="true"><use href="#i-download"/></svg>Download the brand kit (${zips[0].mb} MB)</a>
        <a class="btn btn-quiet" href="#downloads">All downloads</a>
      </div>
      <p class="fine"><span>The brand kit has the logos, icons and Pip; banners and screenshots are their own downloads</span><span>${esc(words.contact)}</span></p>
    </div>
  </section>

  <section class="section" id="logos">
    <div class="wrap">
      <div class="section-head"><h2>Logos</h2>
        <p class="lead">The tile is the app icon: a cream palette on clay. The word is Source Serif 4, drawn as outlines, so the files need no font. Every logo is an SVG and a transparent PNG at 512, 1024 and 2048 pixels wide.</p></div>
      ${logoGroups.map(({ g, items }) => group(logoText[g], items)).join('')}
    </div>
  </section>

  <section class="section" id="icons">
    <div class="wrap">
      <div class="section-head"><h2>App icons</h2>
        <p class="lead">The icon as each platform wants it: with and without rounded corners, the system's own grid, dark and tinted for iPhone and iPad, Android's adaptive layers, and the ready-made .ico and .icns.</p></div>
      <div class="assets">${manifest.icons.map((i) => asset({ ...i, preview: i.preview ?? i.pngs[0].path })).join('')}</div>
    </div>
  </section>

  <section class="section" id="banners">
    <div class="wrap">
      <div class="section-head"><h2>Banners and social images</h2>
        <p class="lead">The sizes the places people share Atelier ask for, in a light, a dark and a clay version. They carry the website's own words: “${esc(HEADLINE)}” and ${esc(ADDRESS)}.</p></div>
      <div class="tabs" role="tablist" aria-label="Banner color">${bannerTabs}</div>
      ${bannerPanels}

      <h3 class="group" id="wallpapers">Wallpapers</h3>
      <div class="assets assets-banners">${wallpaperCards(manifest.wallpapers.filter((b) => b.id === 'desktop'))}</div>
      <div class="assets assets-narrow assets-phone">${wallpaperCards(manifest.wallpapers.filter((b) => b.id === 'phone'))}</div>
    </div>
  </section>

  <section class="section" id="screenshots">
    <div class="wrap">
      <div class="section-head"><h2>Screenshots</h2>
        <p class="lead">The real interface in dark mode, running against a scripted demo model, so there is nothing of anyone's in them. The desktop ones are 4K-class masters.</p></div>
      <h3 class="group">Desktop</h3>
      <div class="assets assets-banners">${manifest.screens.desktop.map((s) => shotCard(s, false)).join('')}</div>
      <h3 class="group">iPhone</h3>
      <div class="assets assets-narrow">${manifest.screens.iphone.map((s) => shotCard(s, true)).join('')}</div>
      <h3 class="group">iPad</h3>
      <div class="assets assets-narrow">${manifest.screens.ipad.map((s) => shotCard(s, true)).join('')}</div>
    </div>
  </section>

  <section class="section" id="pip">
    <div class="wrap">
      <div class="section-head"><h2>Pip</h2>
        <p class="lead">The terminal app's mascot: a little clay figure in a painter's beret, drawn on a 12 by 12 grid. The SVGs are pixel-exact; the PNGs are whole multiples of the grid (16, 64 and 128 times), so they stay sharp. Transparent.</p></div>
      <div class="assets assets-narrow">${pipCards}</div>
    </div>
  </section>

  <section class="section" id="colors">
    <div class="wrap">
      <div class="section-head"><h2>Colors and type</h2>
        <p class="lead">Paper, ink and clay, the same in the app and on the website. <a href="/kit/brand/colors.json" download>colors.json</a> and <a href="/kit/brand/colors.css" download>colors.css</a> have them as data.</p></div>
      <div class="swatches">${swatches}</div>
      <div class="type">
        <div class="specimen specimen-serif"><p class="spec-name">Source Serif 4 <span>titles</span></p><p class="spec-text">${esc(HEADLINE)}</p></div>
        <div class="specimen specimen-sans"><p class="spec-name">Inter <span>the interface</span></p><p class="spec-text">Chat and Code on any model, local or hosted.</p></div>
        <div class="specimen specimen-mono"><p class="spec-name">JetBrains Mono <span>code</span></p><p class="spec-text">atelier --server https://atelier.example.com</p></div>
      </div>
      <p class="fine">The three are open source under the SIL Open Font License. The font files are in the <a href="/downloads/atelier-colors-and-fonts.zip" download>brand download</a>.</p>
    </div>
  </section>

  <section class="section" id="words">
    <div class="wrap">
      <div class="section-head"><h2>Words</h2>
        <p class="lead">What Atelier is, at four lengths, and the facts that stay the same. Copy, shorten or quote them.</p></div>
      <div class="copyblocks">${blocks}</div>
      <h3 class="group">Facts</h3>
      <dl class="facts">${words.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v.startsWith('http') ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v)}</dd></div>`).join('')}</dl>
      <p class="fine">Press and other questions: <a href="mailto:${esc(words.contact)}">${esc(words.contact)}</a></p>
    </div>
  </section>

  <section class="section" id="using">
    <div class="wrap">
      <div class="section-head"><h2>Using these</h2></div>
      <div class="split using">
        <div>
          <ul class="plain">${list(words.usage)}</ul>
        </div>
        <figure class="clear-fig">${clearSpace}<figcaption>Clear space: half the tile's height on every side.</figcaption></figure>
      </div>
      <div class="dos">
        <div><h3>Do</h3><ul class="ticks">${list(words.do)}</ul></div>
        <div><h3>Don't</h3><ul class="ticks ticks-no">${list(words.dont)}</ul></div>
      </div>
    </div>
  </section>

  <section class="section" id="downloads">
    <div class="wrap">
      <div class="section-head"><h2>All downloads</h2>
        <p class="lead">The whole kit as one zip, or one part at a time.</p></div>
      <ul class="zips">${zipRows}</ul>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="wrap">
    <div class="foot">
      <div>
        <a class="brand" href="https://atelierhq.dev/" aria-label="Atelier, home"><img src="/kit/app-icons/favicon.svg" width="30" height="30" alt="">Atelier</a>
        <p class="tagline">A self-hosted AI workspace with Chat and Code, on the model you choose.</p>
      </div>
      <div>
        <h3>Product</h3>
        <ul>
          <li><a href="https://atelierhq.dev/">Website</a></li>
          <li><a href="https://atelierhq.dev/download/">Download</a></li>
          <li><a href="https://atelierhq.dev/compare/">Compare</a></li>
          <li><a href="https://docs.atelierhq.dev/">Documentation</a></li>
        </ul>
      </div>
      <div>
        <h3>Resources</h3>
        <ul>
          <li><a href="https://github.com/TheOriUHD/atelier">GitHub</a></li>
          <li><a href="https://github.com/TheOriUHD/atelier/releases">Releases</a></li>
          <li><a href="https://github.com/TheOriUHD/atelier/blob/main/LICENSE">License</a></li>
          <li><a href="https://media.atelierhq.dev/">Media kit</a></li>
          <li><a href="https://atelierhq.dev/impressum/">Impressum</a></li>
          <li><a href="https://atelierhq.dev/datenschutz/">Datenschutz</a></li>
        </ul>
      </div>
    </div>
    <p class="legal">© 2026 TheOriUHD. Atelier is an independent project and is not affiliated with or endorsed by any model provider. Screenshots show the real interface running against a scripted demo model.</p>
  </div>
</footer>
<script src="/media.js"></script>
</body>
</html>
`;
}
