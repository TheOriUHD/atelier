/**
 * Banner and wallpaper pages: HTML that build.mjs renders to PNG at the exact size. Three schemes (light, dark, clay)
 * and two layouts: `center` (logo, headline, one line, the address) and `showcase` (the same on the left, the app's
 * window on the right). The words are the website's own.
 */
import { COLORS, GLYPH_D, logos } from './brand.mjs';

export const HEADLINE = 'The AI workspace you already know how to use.';
export const SUBLINE = 'Chat and Code on any model, local or hosted.';
export const ADDRESS = 'atelierhq.dev';

const SCHEMES = {
  light: {
    bg: COLORS.paper,
    glow: 'rgba(198, 97, 63, 0.13)',
    ink: COLORS.ink,
    ink2: '#52514E',
    accent: COLORS.clay,
    lockup: () => logos.horizontal({ style: 'gradient', wordFill: COLORS.ink }),
    ghost: 'rgba(198, 97, 63, 0.09)',
  },
  dark: {
    bg: COLORS.night,
    glow: 'rgba(217, 119, 87, 0.2)',
    ink: '#F0EFEC',
    ink2: '#C3C2B7',
    accent: COLORS.clayLight,
    lockup: () => logos.horizontal({ style: 'gradient', wordFill: COLORS.white }),
    ghost: 'rgba(217, 119, 87, 0.1)',
  },
  clay: {
    bg: `linear-gradient(180deg, ${COLORS.clayLight}, ${COLORS.clay})`,
    glow: 'rgba(255, 255, 255, 0.14)',
    ink: COLORS.cream,
    ink2: 'rgba(251, 248, 242, 0.88)',
    accent: COLORS.cream,
    lockup: () => logos.horizontal({ style: 'white', wordFill: COLORS.cream }),
    ghost: 'rgba(251, 248, 242, 0.12)',
  },
};

const fontFaces = (fonts) => `
@font-face { font-family: "Inter"; src: url("${fonts}/inter-latin-wght-normal.woff2") format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Source Serif 4"; src: url("${fonts}/source-serif-4-latin-opsz-normal.woff2") format("woff2"); font-weight: 200 900; }
html, body { margin: 0; }
body { font-family: "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased; font-optical-sizing: auto; }
.b { position: relative; overflow: hidden; }
.glow { position: absolute; inset: 0; }
.lockup { display: block; width: 11.1em; height: auto; }
.lockup svg { display: block; width: 100%; height: auto; }
.h { margin: 0; font-family: "Source Serif 4", Georgia, serif; font-weight: 500; letter-spacing: -0.02em; text-wrap: balance; }
.s { margin: 0; font-weight: 400; }
.u { margin: 0; font-weight: 550; letter-spacing: 0.01em; }
`;

/** Pixel size of one `em` of the layout, so that the lockup (11.1 em wide) fits the width. */
function unit({ w, h, layout, safe }) {
  if (safe) return Math.min(safe.h / 9.6, safe.w / 14);
  if (layout === 'showcase') return Math.min(h / 12, (w * 0.38) / 11.1);
  return Math.min(h / 10.5, w / 16);
}

export function banner({ scheme, w, h, layout, safe, shot, fonts }) {
  const s = SCHEMES[scheme];
  const u = unit({ w, h, layout, safe });
  const showcase = layout === 'showcase';
  const bg = `background: ${s.bg};`;
  const text = () => `
    <div class="lockup">${s.lockup()}</div>
    <h1 class="h t">${HEADLINE}</h1>
    <p class="s sub">${SUBLINE}</p>
    <p class="u url">${ADDRESS}</p>`;
  const css = `${fontFaces(fonts)}
.b { width: ${w}px; height: ${h}px; ${bg} color: ${s.ink}; font-size: ${u}px; }
.glow { background: radial-gradient(60% 90% at ${showcase ? '0% 100%' : '50% 0%'}, ${s.glow}, transparent 70%); }
.t { font-size: ${showcase ? 1.55 : 1.4}em; line-height: 1.1; margin-top: ${showcase ? 1 : 0.9}em; max-width: ${showcase ? 9 : 15}em; }
.sub { font-size: 0.64em; line-height: 1.45; margin-top: 0.9em; color: ${s.ink2}; max-width: ${showcase ? 20 : 34}em; }
.url { font-size: 0.56em; margin-top: 1.1em; color: ${s.accent}; }
${
  showcase
    ? `.copy { position: absolute; left: 6%; top: 0; bottom: 0; width: 38%; display: flex; flex-direction: column; justify-content: center; }
.inner { width: 100%; }
.win { position: absolute; left: 47%; top: 50%; width: 60%; transform: translateY(-50%); border-radius: ${0.5}em; overflow: hidden; background: #151515; box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 ${1.6}em ${4}em -${1}em rgba(0,0,0,0.5); }
.win img { display: block; width: 100%; height: auto; }`
    : `.copy { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.inner { display: flex; flex-direction: column; align-items: center; }
.copy .t, .copy .sub { margin-inline: auto; }`
}
`;
  const maxH = safe ? safe.h : h * (showcase ? 0.78 : 0.74);
  const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>
<div class="b"><div class="glow"></div>
  <div class="copy"><div class="inner">${text()}</div></div>
  ${showcase ? `<div class="win"><img src="${shot}" alt=""></div>` : ''}
</div>
<script>
// Shrinks the text block until it fits the height it has: how much text fits depends on the banner's shape.
window.fit = () => {
  const b = document.querySelector('.b');
  const inner = document.querySelector('.inner');
  let size = parseFloat(getComputedStyle(b).fontSize);
  for (let i = 0; i < 60 && inner.scrollHeight > ${maxH}; i++) {
    size *= 0.96;
    b.style.fontSize = size + 'px';
  }
};
</script>`;
  return html;
}

/** A wallpaper: the scheme's background, the palette large and faint at the corner, the logo small at the bottom. */
export function wallpaper({ scheme, w, h, fonts }) {
  const s = SCHEMES[scheme];
  const phone = h > w;
  const u = phone ? w / 22 : h / 38;
  // The palette whole and recognisable, bigger than the screen's short side so that it bleeds off the edge.
  const size = phone ? w * 1.35 : h * 1.02;
  const css = `${fontFaces(fonts)}
.b { width: ${w}px; height: ${h}px; background: ${s.bg}; color: ${s.ink}; font-size: ${u}px; }
.glow { background: radial-gradient(70% 70% at ${phone ? '50% 0%' : '85% 15%'}, ${s.glow}, transparent 70%); }
.ghost { position: absolute; width: ${size}px; height: ${size}px; ${phone ? `left: ${(w - size) / 2}px; top: ${h * 0.2}px;` : `right: ${-size * 0.06}px; top: ${(h - size) / 2}px;`} }
.ghost svg { width: 100%; height: 100%; }
.lockup { position: absolute; ${phone ? 'left: 50%; bottom: 4.6em; transform: translateX(-50%);' : 'left: 3.4em; bottom: 2.6em;'} width: ${phone ? 9 : 8}em; }
`;
  return `<!doctype html><meta charset="utf-8"><style>${css}</style>
<div class="b"><div class="glow"></div>
  <div class="ghost"><svg viewBox="2.5 2.5 19 19"><path fill="${s.ghost}" fill-rule="evenodd" d="${GLYPH_D}"/></svg></div>
  <div class="lockup">${s.lockup()}</div>
</div>`;
}
