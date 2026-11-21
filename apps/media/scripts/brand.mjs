/**
 * The brand's geometry as SVG: the palette mark, the tile it sits on, the wordmark (outlines made by
 * outline-wordmark.py) and the lockups. Everything here returns strings; build.mjs renders and writes them.
 * The tile and mark are the app icon's own (design/icon-full.svg): a cream palette on a clay tile with a
 * 976/1024 body and corners of 220/976.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const wordmark = JSON.parse(readFileSync(join(here, '../src/wordmark.json'), 'utf8'));

export const COLORS = {
  clay: '#C6613F',
  claySoft: '#D97757',
  clayLight: '#DE8463',
  ink: '#0B0B0B',
  paper: '#FCFCFB',
  night: '#151515',
  cream: '#FBF8F2',
  white: '#FFFFFF',
};

/** The palette glyph on a 24-unit grid (its circle runs from 2.5 to 21.5). */
export const GLYPH_D =
  'M12 2.5a9.5 9.5 0 1 0 0 19c1.2 0 1.9-.85 1.9-1.8 0-.5-.2-.95-.55-1.3-.33-.33-.55-.78-.55-1.3 0-1 .8-1.8 1.8-1.8h1.9a5 5 0 0 0 5-5c0-4.3-4.1-7.8-9.5-7.8ZM7.5 12.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Zm3.3-4.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Zm4.6.4a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z';

let counter = 0;
const uid = (name) => `${name}${++counter}`;

/** Fills for a tile: its body, and the glyph on it (null: the glyph is cut out of the body). */
export const TILES = {
  gradient: { fill: 'url(#GRAD)', glyph: COLORS.cream },
  flat: { fill: COLORS.clay, glyph: COLORS.cream },
  ink: { fill: '#1C1C1B', glyph: COLORS.clayLight },
  black: { fill: '#000000', glyph: null },
  white: { fill: '#FFFFFF', glyph: null },
  cream: { fill: COLORS.cream, glyph: COLORS.clay },
};

/** A tile with the glyph on it, at `x, y` and `size`; returns its parts, with ids that are unique in the document. */
export function tile({ x = 0, y = 0, size = 100, style = 'gradient', radius = 220 / 976 }) {
  const spec = TILES[style];
  const rx = size * radius;
  const s = size * 0.02835;
  const off = (size - 24 * s) / 2;
  const transform = `translate(${n(x + off)} ${n(y + off)}) scale(${n(s, 5)})`;
  const grad = uid('g');
  const mask = uid('m');
  const fill = spec.fill.replace('GRAD', grad);
  let defs = '';
  let body;
  if (style === 'gradient') defs += `<linearGradient id="${grad}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS.clayLight}"/><stop offset="1" stop-color="${COLORS.clay}"/></linearGradient>`;
  if (spec.glyph) {
    body = `<rect x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" rx="${n(rx)}" fill="${fill}"/><path fill="${spec.glyph}" fill-rule="evenodd" transform="${transform}" d="${GLYPH_D}"/>`;
  } else {
    // One colour: the glyph is cut out of the tile, and its dots are the tile again.
    defs += `<mask id="${mask}" maskUnits="userSpaceOnUse" x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}"><rect x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" rx="${n(rx)}" fill="#fff"/><path fill="#000" fill-rule="evenodd" transform="${transform}" d="${GLYPH_D}"/></mask>`;
    body = `<rect x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" fill="${fill}" mask="url(#${mask})"/>`;
  }
  return { defs, body };
}

/** The wordmark's outlines at a font size, with the baseline at `baseline` and its left edge at `x`. */
export function wordmarkPath({ x, baseline, fontSize, fill }) {
  const k = fontSize / wordmark.unitsPerEm;
  return `<path fill="${fill}" transform="translate(${n(x)} ${n(baseline)}) scale(${n(k, 6)})" d="${wordmark.d}"/>`;
}

const svg = (viewBox, inner, extra = '') => {
  const [, , w, h] = viewBox.split(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}" ${extra}>${inner}</svg>\n`;
};

/** The wordmark's box at font size 100: it spans 0 to its advance, and from the tallest letter to the baseline. */
const WM_TOP = 0.74; // the "l" and "t" rise a little above the capital (in em)
const WM_W = (wordmark.width / wordmark.unitsPerEm) * 100;

export const logos = {
  /** The tile alone. */
  mark(style) {
    const t = tile({ style });
    return svg('0 0 100 100', `<defs>${t.defs}</defs>${t.body}`, `role="img" aria-label="Atelier"`);
  },
  /** The glyph without a tile, in one colour. */
  glyph(fill) {
    return svg('2.5 2.5 19 19', `<path fill="${fill}" fill-rule="evenodd" d="${GLYPH_D}"/>`, `role="img" aria-label="Atelier"`);
  },
  /** The word alone. */
  word(fill) {
    return svg(`0 0 ${n(WM_W)} ${n(100 * WM_TOP + 2)}`, wordmarkPath({ x: 0, baseline: 100 * WM_TOP, fontSize: 100, fill }), `role="img" aria-label="Atelier"`);
  },
  /** Tile and word side by side, as the website's header has them. */
  horizontal({ style, wordFill }) {
    const t = tile({ style });
    const size = 73; // the website's 22px word beside its 30px tile
    const cap = (wordmark.capHeight / wordmark.unitsPerEm) * size;
    const x = 100 + 33;
    const width = x + (wordmark.width / wordmark.unitsPerEm) * size;
    return svg(`0 0 ${n(width)} 100`, `<defs>${t.defs}</defs>${t.body}${wordmarkPath({ x, baseline: 50 + cap / 2, fontSize: size, fill: wordFill })}`, `role="img" aria-label="Atelier"`);
  },
  /** Tile above word. */
  stacked({ style, wordFill }) {
    const t = tile({ style, x: 0, y: 0 });
    const size = 82;
    const cap = (wordmark.capHeight / wordmark.unitsPerEm) * size;
    const w = (wordmark.width / wordmark.unitsPerEm) * size;
    const gap = 30;
    const baseline = 100 + gap + cap;
    const tt = tile({ style, x: (w - 100) / 2, y: 0 });
    void t;
    return svg(`0 0 ${n(w)} ${n(baseline + 2)}`, `<defs>${tt.defs}</defs>${tt.body}${wordmarkPath({ x: 0, baseline, fontSize: size, fill: wordFill })}`, `role="img" aria-label="Atelier"`);
  },
};

/** Round to a few decimals so the files stay small. */
function n(value, digits = 2) {
  return String(Number(value.toFixed(digits)));
}

export const logoViewBox = (source) => source.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
