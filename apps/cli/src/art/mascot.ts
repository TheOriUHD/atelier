/**
 * Pip, the terminal app's mascot: a little clay blob of a painter in a beret, holding a brush. Pixel art drawn with
 * half blocks (two pixels to a cell, the top one the foreground colour, the bottom one the background), so the 16×13
 * sprite takes 16 columns and 7 rows. Pip blinks, dabs paint, looks around and waves; a still frame where there is
 * no motion (no colour, a screen reader, `motion: false`).
 */
import { sgr, type Depth } from '../style.ts';

/** One letter per pixel; `.` is see-through. */
export const PIP_COLORS: Record<string, string> = {
  k: '#4A3F5E', // beret
  K: '#7A6A9C', // beret, lit
  C: '#D97757', // clay
  c: '#B4532F', // clay in shade
  h: '#F0A07C', // clay in the light
  w: '#FFF6EE', // eye
  p: '#2B2320', // pupil
  r: '#F28C8C', // cheek
  m: '#7A2E1A', // mouth
  y: '#E6B86A', // brush handle
  f: '#B9B4AE', // ferrule
  t: '#4FB8AE', // paint on the brush (teal)
  u: '#F2C14E', // paint (yellow)
  b: '#5B8DEF', // paint (blue)
};

const base = [
  '.......k........',
  '....kkkkkk......',
  '..kKKkkkkkkkk...',
  '...hhCCCCCCc....',
  '..hCCCCCCCCCc...',
  '..CCwwCCCwwCc...',
  '..CCwpCCCwpCc.t.',
  '..CrCmCCCmCrcfy.',
  '..cCCCmmmCCcyy..',
  '...cCCCCCCcc....',
  '....ccCCcc......',
  '....cc..cc......',
];

/** A copy of the sprite with some pixels changed: `[row, col, letter]`. */
function edit(rows: string[], changes: [number, number, string][]): string[] {
  const grid = rows.map((r) => [...r]);
  for (const [r, c, v] of changes) if (grid[r]) grid[r]![c] = v;
  return grid.map((r) => r.join(''));
}

const blink = edit(base, [
  [5, 4, 'C'], [5, 5, 'C'], [5, 9, 'C'], [5, 10, 'C'],
  [6, 4, 'p'], [6, 5, 'p'], [6, 9, 'p'], [6, 10, 'p'],
]);
/** Looking to the side (the pupils move over). */
const lookRight = edit(base, [[6, 4, 'w'], [6, 5, 'p'], [6, 9, 'w'], [6, 10, 'p'], [5, 5, 'w'], [5, 10, 'w']]);
const lookLeft = edit(base, [[6, 4, 'p'], [6, 5, 'w'], [6, 9, 'p'], [6, 10, 'w']]);
/** The brush lifted, then down for a dab of paint. */
const brushUp = edit(base, [[6, 14, '.'], [7, 13, '.'], [7, 14, '.'], [8, 12, 'c'], [8, 13, '.'], [5, 15, 't'], [6, 14, 'f'], [7, 13, 'y'], [8, 12, 'y']]);
const dab = edit(base, [[6, 14, '.'], [7, 14, '.'], [7, 13, 'c'], [8, 13, 'y'], [8, 14, 'f'], [9, 14, 't'], [10, 14, 't'], [10, 15, 'u']]);
/** Eyes closed in a smile, the mouth open. */
const happy = edit(base, [
  [5, 4, 'p'], [5, 5, 'p'], [5, 9, 'p'], [5, 10, 'p'],
  [6, 4, 'C'], [6, 5, 'C'], [6, 9, 'C'], [6, 10, 'C'],
  [8, 6, 'm'], [8, 7, 'm'], [8, 8, 'm'], [9, 6, 'm'], [9, 7, 'r'], [9, 8, 'm'],
]);
/** Each frame has a free row on top, so Pip can hop up a pixel when work is going on. */
const air = (rows: string[]) => ['................', ...rows];
const hop = [...base, '................'];

export const PIP_FRAMES = {
  base: air(base),
  blink: air(blink),
  lookRight: air(lookRight),
  lookLeft: air(lookLeft),
  brushUp: air(brushUp),
  dab: air(dab),
  happy: air(happy),
  hop,
} as const;
export type PipFrame = keyof typeof PIP_FRAMES;

/**
 * What Pip does over time, a step every 140 ms: mostly still, a blink now and then, a look aside, a dab of paint, a
 * smile. A loop of about 6 seconds.
 */
export const PIP_IDLE: readonly PipFrame[] = [
  ...Array<PipFrame>(10).fill('base'),
  'blink',
  ...Array<PipFrame>(8).fill('base'),
  'lookRight', 'lookRight', 'lookRight', 'lookRight', 'lookRight', 'base', 'lookLeft', 'lookLeft', 'lookLeft', 'lookLeft',
  'base', 'base', 'brushUp', 'brushUp', 'dab', 'dab', 'dab', 'brushUp', 'base',
  ...Array<PipFrame>(6).fill('base'),
  'blink',
  'base', 'base', 'happy', 'happy', 'happy', 'happy',
  ...Array<PipFrame>(6).fill('base'),
];
export const PIP_STEP_MS = 140;

/** Busy: little hops while dabbing, faster. */
export const PIP_BUSY: readonly PipFrame[] = ['base', 'hop', 'base', 'brushUp', 'dab', 'dab', 'brushUp', 'base', 'hop', 'base', 'blink', 'base'];

/** A hello: a wave of the brush and a smile (the setup wizard's splash). */
export const PIP_HELLO: readonly PipFrame[] = ['base', 'brushUp', 'base', 'brushUp', 'base', 'happy', 'happy', 'happy', 'happy', 'base'];

/** The sprite as lines of half blocks, coloured at `depth` (with depth 0, a plain outline). */
export function drawPip(frame: PipFrame | readonly string[], depth: Depth): string[] {
  const rows = typeof frame === 'string' ? PIP_FRAMES[frame] : frame;
  const out: string[] = [];
  for (let r = 0; r < rows.length; r += 2) {
    const top = rows[r] ?? '';
    const bottom = rows[r + 1] ?? '';
    let line = '';
    for (let c = 0; c < Math.max(top.length, bottom.length); c++) {
      const a = top[c] ?? '.';
      const b = bottom[c] ?? '.';
      if (depth === 0) {
        line += a === '.' && b === '.' ? ' ' : a === '.' ? '▄' : b === '.' ? '▀' : '█';
        continue;
      }
      const fa = PIP_COLORS[a];
      const fb = PIP_COLORS[b];
      if (!fa && !fb) line += ' ';
      else if (fa && !fb) line += `\x1b[${sgr(fa, depth)}m▀\x1b[39m`;
      else if (!fa && fb) line += `\x1b[${sgr(fb, depth)}m▄\x1b[39m`;
      else if (fa === fb) line += `\x1b[${sgr(fa!, depth)}m█\x1b[39m`;
      else line += `\x1b[${sgr(fa!, depth)};${sgr(fb!, depth, true)}m▀\x1b[39;49m`;
    }
    out.push(line.replace(/ +$/, ''));
  }
  return out;
}

/** Columns the sprite takes. */
export const PIP_WIDTH = 16;
export const PIP_HEIGHT = Math.ceil((base.length + 1) / 2);
