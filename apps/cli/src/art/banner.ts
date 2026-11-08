/**
 * The wordmarks (ARCHITECTURE §25): "ATELIER CLI" in big block letters for the setup wizard's splash and `atelier
 * --version`, painted left to right in the clay gradient, and a two-line one for the session header. The big one
 * needs 73 columns; narrower terminals get ATELIER alone, then the small one.
 */
import type { Paint } from '../style.ts';

export const BIG = [
  ' █████╗ ████████╗███████╗██╗     ██╗███████╗██████╗ ',
  '██╔══██╗╚══██╔══╝██╔════╝██║     ██║██╔════╝██╔══██╗',
  '███████║   ██║   █████╗  ██║     ██║█████╗  ██████╔╝',
  '██╔══██║   ██║   ██╔══╝  ██║     ██║██╔══╝  ██╔══██╗',
  '██║  ██║   ██║   ███████╗███████╗██║███████╗██║  ██║',
  '╚═╝  ╚═╝   ╚═╝   ╚══════╝╚══════╝╚═╝╚══════╝╚═╝  ╚═╝',
];

export const BIG_CLI = [' ██████╗██╗     ██╗', '██╔════╝██║     ██║', '██║     ██║     ██║', '██║     ██║     ██║', '╚██████╗███████╗██║', ' ╚═════╝╚══════╝╚═╝'];

export const SMALL = ['▄▀█ ▀█▀ █▀▀ █   █ █▀▀ █▀█   █▀▀ █   █', '█▀█  █  ██▄ █▄▄ █ ██▄ █▀▄   █▄▄ █▄▄ █'];

export const TAGLINE = 'Your AI workspace, in your terminal.';

/**
 * The big wordmark for a terminal `columns` wide. `reveal` (0–1) paints it in from the left, as a brush would: letters
 * past the stroke aren't there yet, the stroke's edge is in the lightest colour. Every line keeps its full width (blank
 * past the stroke), so the wordmark stays in place while it is painted.
 */
export function bigBanner(paint: Paint, columns: number, reveal = 1): string[] {
  const withCli = columns >= 76;
  if (columns < 54) return smallBanner(paint);
  const wordWidth = [...BIG[0]!].length;
  const rows = BIG.map((row, i) => (withCli ? `${row}  ${BIG_CLI[i]}` : row));
  const width = Math.max(...rows.map((r) => [...r].length));
  const edge = reveal >= 1 ? width : Math.round(reveal * (width + 2));
  const lines = rows.map((row) => {
    const chars = [...row.padEnd(width)];
    // Each column's colour is the one it has when finished: the gradient over ATELIER, CLI muted.
    const word = paint.gradient(chars.slice(0, wordWidth).join(''));
    const painted = [...splitPainted(word), ...chars.slice(wordWidth).map((ch) => (ch === ' ' ? ' ' : paint.fg('muted', ch)))];
    return painted.map((cell, x) => (x >= edge ? ' ' : x >= edge - 2 && chars[x] !== ' ' ? paint.hex(paint.p.gradient[0], chars[x]!) : cell)).join('');
  });
  if (!withCli) lines.push(`${' '.repeat(wordWidth - 3)}${paint.fg('muted', reveal >= 1 ? 'CLI' : '   ')}`);
  return lines;
}

/** A painted string as one entry per visible character, each with its own colour. */
function splitPainted(text: string): string[] {
  const cells: string[] = [];
  let colour = '';
  // eslint-disable-next-line no-control-regex -- ANSI codes are control characters.
  for (const [, code, ch] of text.matchAll(/(\x1b\[[0-9;]*m)|([^\x1b])/gu)) {
    if (code) colour = code === '\x1b[39m' ? '' : code;
    else if (ch === ' ') cells.push(' ');
    else cells.push(colour ? `${colour}${ch}\x1b[39m` : ch!);
  }
  return cells;
}

/** The two-line wordmark. */
export function smallBanner(paint: Paint): string[] {
  return SMALL.map((row) => {
    const word = row.slice(0, 27);
    return paint.gradient(word) + paint.fg('muted', row.slice(27));
  });
}
