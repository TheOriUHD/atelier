/**
 * Colour in the terminal: the app's own colours (packages/ui/theme/colors.json, generated from the design tokens) at
 * whatever depth the terminal has, light or dark, or none at all (`NO_COLOR`, a pipe, `--plain`). Strings come out
 * with ANSI codes already in them, so Ink only lays them out.
 */
import colors from '../../../packages/ui/theme/colors.json' with { type: 'json' };

export type Depth = 0 | 1 | 2 | 3;
export type Shade = 'dark' | 'light';

/** How many colours the terminal shows: 0 none, 1 the basic 16, 2 256, 3 millions. */
export function colorDepth(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): Depth {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force === '0' || force === 'false' ? 0 : force === '1' ? 1 : force === '2' ? 2 : 3;
  if (!isTTY || env.TERM === 'dumb') return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 3;
  if (env.WT_SESSION || /^(iTerm\.app|WezTerm|vscode|ghostty|Hyper|Tabby|rio)$/.test(env.TERM_PROGRAM ?? '')) return 3;
  if (/kitty|alacritty|foot|contour/.test(env.TERM ?? '')) return 3;
  if (/-256(color)?$/.test(env.TERM ?? '') || env.TERM_PROGRAM === 'Apple_Terminal') return 2;
  if (process.platform === 'win32') return 3;
  return 1;
}

type Rgb = [number, number, number];

export function hex(value: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(value);
  if (!m) return [128, 128, 128];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** An `rgba(…)` token over the theme's background, as the app's CSS would draw it. */
function resolve(value: string, background: string): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!m) return value === 'transparent' ? background : value;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const a = Number(m[4]);
  const [br, bg, bb] = hex(background);
  const mix = (c: number, d: number) => Math.round(c * a + d * (1 - a));
  return `#${[mix(r, br), mix(g, bg), mix(b, bb)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [hex(a), hex(b)];
  return `#${x.map((c, i) => Math.round(c + (y[i]! - c) * t).toString(16).padStart(2, '0')).join('')}`;
};

const ANSI16: [Rgb, number][] = [
  [[0, 0, 0], 30], [[205, 49, 49], 31], [[13, 188, 121], 32], [[229, 229, 16], 33], [[36, 114, 200], 34], [[188, 63, 188], 35], [[17, 168, 205], 36], [[229, 229, 229], 37],
  [[102, 102, 102], 90], [[241, 76, 76], 91], [[35, 209, 139], 92], [[245, 245, 67], 93], [[59, 142, 234], 94], [[214, 112, 214], 95], [[41, 184, 219], 96], [[255, 255, 255], 97],
];

function to256([r, g, b]: Rgb): number {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round(((r - 8) / 247) * 24) + 232;
  const q = (c: number) => Math.round((c / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function to16(rgb: Rgb): number {
  let best = 37;
  let dist = Infinity;
  for (const [c, code] of ANSI16) {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < dist) [best, dist] = [code, d];
  }
  return best;
}

/** The SGR parameters for a colour, foreground or background, at this depth. */
export function sgr(color: string, depth: Depth, background = false): string {
  if (depth === 0) return '';
  const rgb = hex(color);
  if (depth === 3) return `${background ? 48 : 38};2;${rgb.join(';')}`;
  if (depth === 2) return `${background ? 48 : 38};5;${to256(rgb)}`;
  const code = to16(rgb);
  return String(background ? code + 10 : code);
}

export interface Palette {
  shade: Shade;
  depth: Depth;
  text: string;
  secondary: string;
  muted: string;
  faint: string;
  accent: string;
  accentSoft: string;
  accentDeep: string;
  info: string;
  good: string;
  warn: string;
  bad: string;
  added: string;
  removed: string;
  addedBg: string;
  removedBg: string;
  userBg: string;
  codeBg: string;
  keyword: string;
  type: string;
  string: string;
  comment: string;
  /** The wordmark's gradient, left to right. */
  gradient: [string, string, string];
}

export function palette(shade: Shade, depth: Depth): Palette {
  const c = colors[shade] as Record<string, string>;
  const bg = c.background!;
  const r = (name: string) => resolve(c[name] ?? '#808080', bg);
  return {
    shade,
    depth,
    text: r('text-primary'),
    secondary: r('text-secondary'),
    muted: r('text-muted'),
    faint: shade === 'dark' ? '#5C5A55' : '#B5B3AC',
    accent: r('accent-hover'),
    accentSoft: shade === 'dark' ? '#F0A07C' : '#C6613F',
    accentDeep: shade === 'dark' ? '#C6613F' : '#8A3E21',
    info: r('interactive-text'),
    good: r('success-text'),
    warn: r('warning-text'),
    bad: r('danger-text'),
    added: r('diff-added-text'),
    removed: r('diff-removed-text'),
    addedBg: r('diff-added-bg'),
    removedBg: r('diff-removed-bg'),
    userBg: shade === 'dark' ? '#262624' : '#EFEEEA',
    codeBg: shade === 'dark' ? '#1E1E1C' : '#F4F3EF',
    keyword: r('code-keyword'),
    type: r('code-type'),
    string: r('code-string'),
    comment: r('code-comment'),
    gradient: shade === 'dark' ? ['#F0A07C', '#C6613F', '#8A3E21'] : ['#D97757', '#B4532F', '#7A3218'],
  };
}

/** Painting text with a palette: `p.fg('accent', 'Atelier')`, bold, dim, a background. */
export class Paint {
  constructor(readonly p: Palette) {}
  private wrap(open: string, text: string, close: string): string {
    return open && this.p.depth > 0 ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  }
  hex(color: string, text: string): string {
    return this.wrap(sgr(color, this.p.depth), text, '39');
  }
  fg(role: keyof Omit<Palette, 'shade' | 'depth' | 'gradient'>, text: string): string {
    return this.hex(this.p[role], text);
  }
  bg(color: string, text: string): string {
    return this.wrap(sgr(color, this.p.depth, true), text, '49');
  }
  bold(text: string): string {
    return this.wrap('1', text, '22');
  }
  dim(text: string): string {
    return this.wrap('2', text, '22');
  }
  italic(text: string): string {
    return this.wrap('3', text, '23');
  }
  underline(text: string): string {
    return this.wrap('4', text, '24');
  }
  inverse(text: string): string {
    return this.wrap('7', text, '27');
  }
  /** Each character a step along a gradient (the wordmark). */
  gradient(text: string, stops: readonly string[] = this.p.gradient, offset = 0): string {
    const chars = [...text];
    if (this.p.depth === 0) return text;
    return chars
      .map((ch, i) => {
        if (ch === ' ') return ch;
        const t = Math.min(1, Math.max(0, chars.length <= 1 ? 0 : i / (chars.length - 1) + offset));
        const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
        const local = t * (stops.length - 1) - seg;
        return `\x1b[${sgr(mix(stops[seg]!, stops[seg + 1]!, local), this.p.depth)}m${ch}`;
      })
      .join('')
      .concat('\x1b[39m');
  }
}

/** Removes ANSI codes (for measuring and for plain output). */
// eslint-disable-next-line no-control-regex -- ANSI codes are control characters.
export const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, '');
