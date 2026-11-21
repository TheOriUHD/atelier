#!/usr/bin/env node
/**
 * Builds the media kit (media.atelierhq.dev) into apps/media/public: logos, app icons, banners, wallpapers,
 * screenshots, the mascot, colours, fonts and words, as files and as the page that shows them, and the zip downloads.
 *
 *   node apps/media/scripts/build.mjs
 *
 * Needs Google Chrome (rendered through Playwright's `chrome` channel), ImageMagick (`magick`), `iconutil` (macOS) and
 * `zip`. The masters are in git (src/, design/, apps/site/public); everything under public/ except the hand-written files
 * is made here and ignored by git.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COLORS, GLYPH_D, logos, logoViewBox } from './brand.mjs';
import { banner, wallpaper } from './banners.mjs';
import { renderPage } from './page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '../..');
const pub = join(root, 'public');
const kit = join(pub, 'kit');
const site = join(repo, 'apps/site/public');
const SITE_FONTS = join(site, 'fonts');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
const ensure = (dir) => (mkdirSync(dir, { recursive: true }), dir);
const write = (file, text) => (ensure(dirname(file)), writeFileSync(file, text));
const kb = (file) => Math.round(statSync(file).size / 1024);

// Start from nothing: a file that is no longer made must not stay on the site.
for (const dir of ['kit', 'previews', 'downloads', '_work']) rmSync(join(pub, dir), { recursive: true, force: true });
for (const file of ['index.html', 'styles.css', 'theme.js', 'sitemap.xml']) rmSync(join(pub, file), { force: true });
rmSync(join(pub, 'fonts'), { recursive: true, force: true });

/** What the page shows, by section; every file is a path under public/. */
const manifest = { logos: [], icons: [], banners: [], wallpapers: [], screens: { desktop: [], iphone: [], ipad: [] }, pip: [], counts: {} };

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });

/** An SVG document as a PNG of this width, on a transparent background. */
async function svgPng(svg, file, width) {
  const [, , vw, vh] = logoViewBox(svg);
  const height = Math.round((width * vh) / vw);
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`);
  ensure(dirname(file));
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  return { width, height };
}

/** An HTML page (from the work folder, so it can load the fonts and pictures by file) as a PNG of this size. */
async function htmlPng(html, file, width, height) {
  const source = join(pub, '_work', `${basename(file)}.html`);
  write(source, html);
  await page.setViewportSize({ width, height });
  await page.goto(pathToFileURL(source).href);
  await page.evaluate('document.fonts.ready');
  await page.evaluate('window.fit && window.fit()');
  await page.evaluate('Promise.all([...document.images].map((i) => i.decode().catch(() => {})))');
  ensure(dirname(file));
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height } });
}

const thumb = (from, to, width = 960) => {
  ensure(dirname(to));
  run('magick', [from, '-resize', `${width}x`, '-quality', '80', to]);
};

// ------------------------------------------------------------------------------------------- logos
const horizontal = [
  ['color', 'gradient', COLORS.ink, 'light', 'color, for light backgrounds', 'The clay tile with the ink word.'],
  ['color-on-dark', 'gradient', COLORS.white, 'dark', 'color, for dark backgrounds', 'The clay tile with a white word.'],
  ['black', 'black', '#000000', 'light', 'black', 'One colour: the palette is cut out of the tile, so the background shows through.'],
  ['white', 'white', '#FFFFFF', 'dark', 'white', 'One colour, for dark or coloured backgrounds.'],
];
const LOGO_WIDTHS = [512, 1024, 2048];

async function logoFiles(id, svg, group) {
  const svgPath = join(kit, 'logos/svg', `atelier-${id}.svg`);
  write(svgPath, svg);
  const pngs = [];
  for (const width of LOGO_WIDTHS) {
    const file = join(kit, 'logos/png', `atelier-${id}-${width}.png`);
    await svgPng(svg, file, width);
    pngs.push({ label: `PNG ${width}`, path: file });
  }
  return { svg: svgPath, pngs, group, id };
}

for (const [id, style, word, bg, title, desc] of horizontal) {
  manifest.logos.push({ ...(await logoFiles(`logo-horizontal-${id}`, logos.horizontal({ style, wordFill: word }), 'Horizontal')), title: `Horizontal, ${title}`, desc, bg, wide: true });
}
for (const [id, style, word, bg, title, desc] of horizontal) {
  manifest.logos.push({ ...(await logoFiles(`logo-stacked-${id}`, logos.stacked({ style, wordFill: word }), 'Stacked')), title: `Stacked, ${title}`, desc, bg });
}
for (const [id, fill, bg, title] of [
  ['wordmark-ink', COLORS.ink, 'light', 'Wordmark, ink'],
  ['wordmark-white', COLORS.white, 'dark', 'Wordmark, white'],
  ['wordmark-clay', COLORS.clay, 'light', 'Wordmark, clay'],
]) manifest.logos.push({ ...(await logoFiles(id, logos.word(fill), 'Wordmark')), title, desc: 'Source Serif 4 semibold, drawn as outlines: no font needed.', bg });
for (const [id, style, bg, title, desc] of [
  ['mark-tile', 'gradient', 'light', 'Tile', 'The app icon without its rounded-corner canvas: clay gradient, cream palette.'],
  ['mark-tile-flat', 'flat', 'light', 'Tile, flat clay', 'One flat clay, for places that don’t take a gradient.'],
  ['mark-tile-ink', 'ink', 'dark', 'Tile, ink', 'The dark-mode tile: near black with a light clay palette.'],
  ['mark-tile-black', 'black', 'light', 'Tile, black', 'One colour, the palette cut out.'],
  ['mark-tile-white', 'white', 'dark', 'Tile, white', 'One colour, the palette cut out.'],
]) manifest.logos.push({ ...(await logoFiles(id, logos.mark(style), 'Mark')), title, desc, bg });
for (const [id, fill, bg, title] of [
  ['mark-clay', COLORS.clay, 'light', 'Palette, clay'],
  ['mark-black', '#000000', 'light', 'Palette, black'],
  ['mark-white', '#FFFFFF', 'dark', 'Palette, white'],
]) manifest.logos.push({ ...(await logoFiles(id, logos.glyph(fill), 'Palette')), title, desc: 'The palette on its own, with no tile, transparent.', bg });

// ----------------------------------------------------------------------------------------- app icons
const full = readFileSync(join(repo, 'design/icon-full.svg'), 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '');
const macos = readFileSync(join(repo, 'design/icon.svg'), 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '');
const GRADIENT = `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS.clayLight}"/><stop offset="1" stop-color="${COLORS.clay}"/></linearGradient></defs>`;
const glyph1024 = (fill, scale = 27.67, at = 180) => `<g transform="translate(${at} ${at}) scale(${scale})"><path fill="${fill}" fill-rule="evenodd" d="${GLYPH_D}"/></g>`;
const doc = (size, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${inner}</svg>\n`;
const icons = [
  { id: 'app-icon', title: 'App icon', desc: 'Windows, Linux, the web and anywhere the corners are yours to round. Transparent corners.', svg: full, sizes: [1024, 512, 256, 192, 128, 64, 32, 16], bg: 'checker' },
  { id: 'app-icon-macos', title: 'macOS icon', desc: 'With the margin macOS’s icon grid asks for. Transparent corners.', svg: macos, sizes: [1024, 512, 256, 128, 64, 32, 16], bg: 'checker' },
  { id: 'app-icon-ios', title: 'iPhone and iPad icon', desc: 'Square and full-bleed, no transparency: the system rounds it. 1024 is the App Store size.', svg: doc(1024, `${GRADIENT}<rect width="1024" height="1024" fill="url(#bg)"/>${glyph1024(COLORS.cream)}`), sizes: [1024, 180, 120], bg: 'light' },
  { id: 'app-icon-ios-dark', title: 'iPhone and iPad icon, dark', desc: 'For the dark appearance: near black with a light clay palette.', svg: doc(1024, `<rect width="1024" height="1024" fill="#1C1C1B"/>${glyph1024(COLORS.clayLight)}`), sizes: [1024], bg: 'dark' },
  { id: 'app-icon-ios-tinted', title: 'iPhone and iPad icon, tinted', desc: 'Grey on black, which the system tints.', svg: doc(1024, `<rect width="1024" height="1024" fill="#000"/>${glyph1024('#D6D6D6')}`), sizes: [1024], bg: 'dark' },
  { id: 'app-icon-android-foreground', title: 'Android adaptive, foreground', desc: 'The palette inside the 66% safe zone of the 108dp layer, transparent (432 px is 4×).', svg: doc(432, `<g transform="translate(72 72) scale(12)"><path fill="${COLORS.cream}" fill-rule="evenodd" d="${GLYPH_D}"/></g>`), sizes: [432], bg: 'clay' },
  { id: 'app-icon-android-background', title: 'Android adaptive, background', desc: 'The clay gradient layer behind it.', svg: doc(432, `${GRADIENT}<rect width="432" height="432" fill="url(#bg)"/>`), sizes: [432], bg: 'light' },
  { id: 'app-icon-android-monochrome', title: 'Android themed icon', desc: 'A single-colour layer the system colours itself.', svg: doc(432, `<g transform="translate(72 72) scale(12)"><path fill="#000" fill-rule="evenodd" d="${GLYPH_D}"/></g>`), sizes: [432], bg: 'light' },
  { id: 'app-icon-round', title: 'Round icon', desc: 'For avatars and places that crop to a circle (a GitHub or Discord profile, say).', svg: doc(1024, `${GRADIENT}<circle cx="512" cy="512" r="512" fill="url(#bg)"/>${glyph1024(COLORS.cream, 24)}`), sizes: [1024, 512, 256, 128], bg: 'checker' },
];
for (const icon of icons) {
  const svgPath = join(kit, 'app-icons/svg', `atelier-${icon.id}.svg`);
  write(svgPath, icon.svg);
  const pngs = [];
  for (const size of icon.sizes) {
    const file = join(kit, 'app-icons/png', `atelier-${icon.id}-${size}.png`);
    await svgPng(icon.svg, file, size);
    pngs.push({ label: `PNG ${size}`, path: file });
  }
  manifest.icons.push({ ...icon, svg: svgPath, pngs });
}
// Windows' .ico, macOS's .icns and the favicon, made from the icons' own art.
const work = ensure(join(pub, '_work/icons'));
const ladder = async (svg, sizes) => {
  const files = [];
  for (const size of sizes) {
    const file = join(work, `${basename(svg === full ? 'app' : 'macos')}-${size}.png`);
    await svgPng(svg, file, size);
    files.push(file);
  }
  return files;
};
run('magick', [...(await ladder(full, [16, 24, 32, 48, 64, 128, 256])), join(kit, 'app-icons/atelier-app-icon.ico')]);
run('magick', [...(await ladder(full, [16, 32, 48])), join(kit, 'app-icons/favicon.ico')]);
const iconset = ensure(join(pub, '_work/atelier.iconset'));
for (const [name, size] of [['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024]]) {
  await svgPng(macos, join(iconset, `${name}.png`), size);
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(kit, 'app-icons/atelier-app-icon.icns')]);
write(join(kit, 'app-icons/favicon.svg'), full);
manifest.icons.push({
  id: 'app-icon-formats',
  title: 'Ready-made files',
  desc: 'The app icon as a Windows .ico (16 to 256), a macOS .icns, a favicon.ico (16, 32, 48) and an SVG favicon. The Apple touch icon is the 180 px iPhone icon above; Android Chrome uses the 192 and 512 px app icons.',
  svg: null,
  pngs: [],
  bg: 'checker',
  preview: join(kit, 'app-icons/png/atelier-app-icon-256.png'),
  files: [
    { label: '.ico', path: join(kit, 'app-icons/atelier-app-icon.ico') },
    { label: '.icns', path: join(kit, 'app-icons/atelier-app-icon.icns') },
    { label: 'favicon.ico', path: join(kit, 'app-icons/favicon.ico') },
    { label: 'favicon.svg', path: join(kit, 'app-icons/favicon.svg') },
  ],
});

// ------------------------------------------------------------------------------- banners, wallpapers
const BANNERS = [
  ['github-social-preview', 'GitHub social preview', 1280, 640, 'showcase'],
  ['open-graph', 'Link preview (Open Graph)', 1200, 630, 'showcase'],
  ['x-post', 'X and Bluesky post', 1600, 900, 'showcase'],
  ['product-hunt-gallery', 'Product Hunt gallery', 1270, 760, 'showcase'],
  ['wide-16x9', 'Widescreen 16:9', 1920, 1080, 'showcase'],
  ['x-header', 'X header', 1500, 500, 'center'],
  ['linkedin-banner', 'LinkedIn banner', 1584, 396, 'center'],
  ['youtube-channel-art', 'YouTube channel art', 2560, 1440, 'center', { w: 1546, h: 423 }],
  ['ultrawide', 'Ultrawide 4:1', 4320, 1080, 'center'],
  ['square', 'Square', 1080, 1080, 'center'],
  ['story-9x16', 'Story 9:16', 1080, 1920, 'center'],
];
const SCHEMES = ['light', 'dark', 'clay'];
const shot = join(site, 'img/code-3840.webp');
for (const scheme of SCHEMES) {
  for (const [id, title, w, h, layout, safe] of BANNERS) {
    const file = join(kit, 'banners', scheme, `atelier-banner-${id}-${scheme}-${w}x${h}.png`);
    await htmlPng(banner({ scheme, w, h, layout, safe, shot: pathToFileURL(shot).href, fonts: pathToFileURL(SITE_FONTS).href }), file, w, h);
    const preview = join(pub, 'previews/banners', `${basename(file, '.png')}.webp`);
    thumb(file, preview, 960);
    manifest.banners.push({ scheme, id, title, w, h, path: file, preview, bytes: kb(file) });
  }
}
for (const scheme of SCHEMES) {
  for (const [id, title, w, h] of [['desktop', 'Desktop wallpaper', 3840, 2160], ['phone', 'Phone wallpaper', 1290, 2796]]) {
    const file = join(kit, 'wallpapers', `atelier-wallpaper-${id}-${scheme}-${w}x${h}.png`);
    await htmlPng(wallpaper({ scheme, w, h, fonts: pathToFileURL(SITE_FONTS).href }), file, w, h);
    const preview = join(pub, 'previews/wallpapers', `${basename(file, '.png')}.webp`);
    thumb(file, preview, id === 'phone' ? 420 : 960);
    manifest.wallpapers.push({ scheme, id, title, w, h, path: file, preview, bytes: kb(file) });
  }
}

// ------------------------------------------------------------------------------------- screenshots
const DESKTOP = [
  ['code', 'Code', 'An agentic session in a repository: the diff, the commit, the permission mode.', 3840],
  ['chat', 'Chat', 'Rich replies, projects, attachments, web search with sources.', 3840],
  ['tasks', 'Tasks', 'Longer work in a chat: files in, files out.', 3840],
  ['artifact', 'Artifacts', 'What a reply builds opens beside the conversation.', 3840],
  ['permission', 'Approvals', 'A risky command waits for a yes, with a plain description of what it does.', 3840],
  ['providers', 'Providers', 'Local and hosted models side by side.', 2496],
];
for (const [name, title, desc, width] of DESKTOP) {
  const master = join(site, 'img', `${name}-${width}.webp`);
  const webp = join(kit, 'screenshots/desktop', `atelier-${name}-${width}.webp`);
  const png = join(kit, 'screenshots/desktop', `atelier-${name}-2560.png`);
  ensure(dirname(webp));
  copyFileSync(master, webp);
  run('magick', [master, '-resize', '2560x', '-strip', png]);
  const preview = join(pub, 'previews/screens/desktop', `${name}.webp`);
  thumb(master, preview, 960);
  manifest.screens.desktop.push({ id: name, title, desc, files: [{ label: `WebP ${width}`, path: webp }, { label: 'PNG 2560', path: png }], preview });
}
const iosSrc = join(root, 'src/screens/ios');
const IOS = {
  iphone: [['01-p1-home', 'Home'], ['02-p2-conversation', 'A conversation'], ['03-p3-code', 'Code'], ['04-p4-effort', 'Effort'], ['05-p5-voice', 'Voice'], ['06-p6-usage', 'Usage'], ['07-p7-settings', 'Settings'], ['08-p8-signin', 'Sign in']],
  ipad: [['01-i1-workspace', 'Workspace'], ['02-i2-code', 'Code'], ['03-i3-effort', 'Effort'], ['04-i4-usage', 'Usage'], ['05-i5-settings', 'Settings']],
};
for (const [device, list] of Object.entries(IOS)) {
  for (const [file, title] of list) {
    const source = join(iosSrc, device, `${file}.png`);
    const out = join(kit, 'screenshots', device, `atelier-${device}-${file.replace(/^\d+-[a-z]\d+-/, '')}.png`);
    ensure(dirname(out));
    copyFileSync(source, out);
    const preview = join(pub, 'previews/screens', device, `${basename(out, '.png')}.webp`);
    thumb(source, preview, 420);
    manifest.screens[device].push({ id: file, title, files: [{ label: 'PNG', path: out }], preview });
  }
}

// ------------------------------------------------------------------------------------------- Pip
// The sprite is the terminal app's own (apps/cli/src/art/mascot.ts); esbuild turns it into something Node can import.
const mascot = join(pub, '_work/mascot.mjs');
run(join(repo, 'node_modules/.bin/esbuild'), [join(repo, 'apps/cli/src/art/mascot.ts'), '--bundle', '--format=esm', '--platform=node', '--log-level=error', `--outfile=${mascot}`]);
const { PIP_FRAMES, PIP_COLORS } = await import(pathToFileURL(mascot).href);
function pipSvg(rows) {
  const rects = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      let end = x;
      while (end < row.length && row[end] === c) end++;
      if (c !== '.') rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${PIP_COLORS[c]}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" shape-rendering="crispEdges" role="img" aria-label="Pip, Atelier's mascot">${rects.join('')}</svg>\n`;
}
const PIP_NAMES = { base: 'Pip', blink: 'Blinking', lookRight: 'Looking right', lookLeft: 'Looking left', happy: 'Happy', hop: 'Hopping' };
for (const [frame, rows] of Object.entries(PIP_FRAMES)) {
  const svg = pipSvg([...rows]);
  const svgPath = join(kit, 'pip/svg', `atelier-pip-${frame}.svg`);
  write(svgPath, svg);
  const pngs = [];
  for (const size of [192, 768, 1536]) {
    const file = join(kit, 'pip/png', `atelier-pip-${frame}-${size}.png`);
    await svgPng(svg, file, size);
    pngs.push({ label: `PNG ${size}`, path: file });
  }
  manifest.pip.push({ id: frame, title: PIP_NAMES[frame], svg: svgPath, pngs, bg: 'checker' });
}

// ------------------------------------------------------------------- colours, fonts, words, readme
const colors = [
  { id: 'clay', name: 'Clay', hex: COLORS.clay, use: 'The brand colour: the tile, accents, links to action. On white it is 4:1: use it for shapes and large text, not small text.' },
  { id: 'clay-soft', name: 'Clay, soft', hex: COLORS.claySoft, use: 'Clay for dark backgrounds, and the mascot.' },
  { id: 'clay-light', name: 'Clay, light', hex: COLORS.clayLight, use: 'The top of the tile’s gradient.' },
  { id: 'ink', name: 'Ink', hex: COLORS.ink, use: 'Text on light backgrounds, and primary buttons.' },
  { id: 'paper', name: 'Paper', hex: COLORS.paper, use: 'The light background.' },
  { id: 'night', name: 'Night', hex: COLORS.night, use: 'The dark background.' },
  { id: 'cream', name: 'Cream', hex: COLORS.cream, use: 'The palette on the tile.' },
];
write(join(kit, 'brand/colors.json'), JSON.stringify(Object.fromEntries(colors.map((c) => [c.id, c.hex])), null, 2) + '\n');
write(join(kit, 'brand/colors.css'), `:root {\n${colors.map((c) => `  --atelier-${c.id}: ${c.hex};`).join('\n')}\n}\n`);
for (const f of ['inter-latin-wght-normal.woff2', 'source-serif-4-latin-opsz-normal.woff2', 'jetbrains-mono-latin-wght-normal.woff2', 'OFL.txt']) {
  ensure(join(kit, 'brand/fonts'));
  copyFileSync(join(SITE_FONTS, f), join(kit, 'brand/fonts', f));
}
const words = JSON.parse(readFileSync(join(root, 'src/words.json'), 'utf8'));
write(
  join(kit, 'brand/atelier-about.txt'),
  `${words.blocks.map((b) => `${b.title}\n${b.text}\n`).join('\n')}\nFacts\n${words.facts.map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nContact: ${words.contact}\n`,
);
const readme = `Atelier media kit
=================

Logos, app icons, banners, wallpapers, screenshots, the mascot, colours and fonts for Atelier, the self-hosted AI
workspace. The latest version is at https://media.atelierhq.dev/

${words.usage.join('\n')}

Contact: ${words.contact}
`;
write(join(kit, 'README.txt'), readme);

await browser.close();

// ------------------------------------------------------------------------------------------- zips
function zipIn(name, paths) {
  ensure(join(pub, 'downloads'));
  const file = join(pub, 'downloads', name);
  execFileSync('zip', ['-q', '-r', '-X', file, ...paths], { cwd: kit, stdio: ['ignore', 'pipe', 'inherit'] });
  return file;
}
const zips = [
  ['atelier-brand-kit.zip', ['logos', 'app-icons', 'pip', 'brand', 'README.txt'], 'Logos, app icons, Pip, colours, fonts and the words: the brand without the big pictures'],
  ['atelier-logos.zip', ['logos', 'README.txt'], 'Every logo, SVG and PNG'],
  ['atelier-app-icons.zip', ['app-icons', 'README.txt'], 'App icons, .ico, .icns, favicons'],
  ['atelier-banners.zip', ['banners', 'wallpapers', 'README.txt'], 'Banners and wallpapers, light, dark and clay'],
  ['atelier-screenshots.zip', ['screenshots', 'README.txt'], 'Desktop, iPhone and iPad screenshots'],
  ['atelier-pip.zip', ['pip', 'README.txt'], 'Pip, the mascot'],
  ['atelier-colors-and-fonts.zip', ['brand', 'README.txt'], 'Colours, fonts and the words'],
].map(([name, paths, desc]) => ({ name, desc, file: zipIn(name, paths), paths }));
for (const z of zips) z.mb = (statSync(z.file).size / (1024 * 1024)).toFixed(1);
for (const z of zips) if (statSync(z.file).size > 25 * 1024 * 1024) throw new Error(`${z.name} is over the 25 MB a file may have on the host; split it.`);

// ------------------------------------------------------------------------------------- the page
ensure(join(pub, 'fonts'));
for (const f of readdirSync(SITE_FONTS)) copyFileSync(join(SITE_FONTS, f), join(pub, 'fonts', f));
copyFileSync(join(site, 'styles.css'), join(pub, 'styles.css'));
copyFileSync(join(site, 'theme.js'), join(pub, 'theme.js'));
const rel = (p) => '/' + p.slice(pub.length + 1);
writeFileSync(join(pub, 'index.html'), renderPage({ manifest, colors, zips, words, rel }));
write(join(pub, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://media.atelierhq.dev/</loc></url>\n</urlset>\n`);
rmSync(join(pub, '_work'), { recursive: true, force: true });

const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const all = files(kit);
console.log(`Built ${all.length} files in kit/, ${zips.length} zips (${zips.map((z) => `${z.name} ${z.mb} MB`).join(', ')}).`);
