/**
 * Pip, the terminal app's mascot: a little clay figure in a painter's beret. Pixel art drawn with half blocks (two
 * pixels to a cell, the top one the foreground colour, the bottom one the background), so the 12×12 sprite takes 12
 * columns and 6 rows.
 *
 * Kept simple on purpose, so it reads at that size: a two-tone beret with its stem, one clay colour with a darker
 * right side and feet, eyes with a glint, pink cheeks. Every frame changes only the eyes (and, happy, a small mouth),
 * or moves Pip up a pixel (a hop). A still frame where there is no motion (no colour, a screen reader, `motion: false`).
 */
import { sgr, type Depth } from '../style.ts';

/** One letter per pixel; `.` is see-through. */
export const PIP_COLORS: Record<string, string> = {
  k: '#3E3552', // beret
  K: '#6A5C8E', // beret, lit
  C: '#D97757', // clay
  c: '#B5573A', // clay in shade
  p: '#2A211E', // eye
  w: '#FFF4EA', // the eye's glint
  r: '#EF8C80', // cheek
  m: '#8A3420', // mouth
};

/** The first row is air (a hop goes up into it), the last is empty: six text rows. */
const base = [
  '............',
  '.....kk.....',
  '...KKKKKKk..',
  '.kkkkkkkkkkk',
  '..CCCCCCCc..',
  '.CCwpCCwpCc.',
  '.CCppCCppCc.',
  '.CrCCCCCCrc.',
  '.CCCCCCCCCc.',
  '..cCCCCCCc..',
  '..cc....cc..',
  '............',
];

/** A copy of the sprite with some pixels changed: `[row, col, letter]`. */
function edit(rows: string[], changes: [number, number, string][]): string[] {
  const grid = rows.map((r) => [...r]);
  for (const [r, c, v] of changes) if (grid[r]) grid[r]![c] = v;
  return grid.map((r) => r.join(''));
}

/** The eyes at another place: each two pixels wide, `left` and `left + 4`, glint top left. */
const eyesAt = (left: number) =>
  edit(
    base,
    [3, 4, 7, 8].flatMap((c) => [[5, c, 'C'] as [number, number, string], [6, c, 'C'] as [number, number, string]]).concat(
      [left, left + 4].flatMap((c) => [[5, c, 'w'], [5, c + 1, 'p'], [6, c, 'p'], [6, c + 1, 'p']] as [number, number, string][]),
    ),
  );
/** Eyes closed: only their lower half, a line. */
const closed = (rows: string[]) => edit(rows, [[5, 3, 'C'], [5, 4, 'C'], [5, 7, 'C'], [5, 8, 'C']]);

export const PIP_FRAMES = {
  base,
  blink: closed(base),
  lookRight: eyesAt(4),
  lookLeft: eyesAt(2),
  /** Eyes closed in a smile, a small mouth open. */
  happy: edit(closed(base), [[8, 5, 'm'], [8, 6, 'm']]),
  /** Up a pixel, into the air row. */
  hop: [...base.slice(1), '............'],
} as const;
export type PipFrame = keyof typeof PIP_FRAMES;

/** What Pip does over time, a step every 140 ms: mostly still, a blink now and then, a look aside, a smile. About 6 s. */
export const PIP_IDLE: readonly PipFrame[] = [
  ...Array<PipFrame>(12).fill('base'),
  'blink',
  ...Array<PipFrame>(10).fill('base'),
  ...Array<PipFrame>(5).fill('lookRight'),
  'base',
  ...Array<PipFrame>(5).fill('lookLeft'),
  ...Array<PipFrame>(6).fill('base'),
  'blink',
  ...Array<PipFrame>(3).fill('base'),
  ...Array<PipFrame>(4).fill('happy'),
  ...Array<PipFrame>(6).fill('base'),
];
export const PIP_STEP_MS = 140;

/** Busy: little hops, a look around. */
export const PIP_BUSY: readonly PipFrame[] = ['base', 'hop', 'base', 'base', 'lookRight', 'lookRight', 'base', 'hop', 'base', 'blink', 'base', 'base'];

/** A hello: a hop and a smile. */
export const PIP_HELLO: readonly PipFrame[] = ['base', 'hop', 'base', 'hop', 'base', 'happy', 'happy', 'happy', 'happy', 'base'];

/** The sprite as lines of half blocks, coloured at `depth`; with depth 0, its outline with the eyes left open. */
export function drawPip(frame: PipFrame | readonly string[], depth: Depth): string[] {
  const rows = typeof frame === 'string' ? PIP_FRAMES[frame] : frame;
  const out: string[] = [];
  for (let r = 0; r < rows.length; r += 2) {
    const top = rows[r] ?? '';
    const bottom = rows[r + 1] ?? '';
    let line = '';
    for (let c = 0; c < PIP_WIDTH; c++) {
      const a = top[c] ?? '.';
      const b = bottom[c] ?? '.';
      if (depth === 0) {
        // Without colour the eyes are holes in the shape.
        const on = (ch: string) => ch !== '.' && ch !== 'p' && ch !== 'w';
        line += !on(a) && !on(b) ? ' ' : !on(a) ? '▄' : !on(b) ? '▀' : '█';
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
    out.push(line);
  }
  return out;
}

/** Columns the sprite takes. */
export const PIP_WIDTH = 12;
export const PIP_HEIGHT = base.length / 2;
