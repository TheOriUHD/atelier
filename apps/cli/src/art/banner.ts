/**
 * The wordmarks (ARCHITECTURE §25): ATELIER in big block letters with their shadow, painted left to right in the clay
 * gradient, and CLI beside it drawn with command-line prompts (`>_`) and a shadow of colons, its last `_` a blinking cursor: for the setup's first screen and
 * `atelier --version`. The whole is 77 columns wide and shows from 79; narrower terminals get ATELIER alone, then a small one.
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

/** C, L and I as pixels (`#`), each drawn as a prompt, `>_`, on the five rows of ATELIER's letters. */
const CLI_PIXELS = [' ### #    #', '#    #    #', '#    #    #', '#    #    #', ' ### #### #'];
const CLI_LETTERS = CLI_PIXELS.map((row) => row.replace(/#/g, '>_').replace(/ /g, '  '));
/**
 * CLI with its own shadow, in command-line dots rather than ATELIER's lines: a colon one row down and one column right
 * of every letter cell, where that cell is empty. Its last row is ATELIER's shadow row, so both are six rows tall.
 */
export const BIG_CLI = Array.from({ length: BIG.length }, (_, r) =>
  Array.from({ length: Math.max(...CLI_LETTERS.map((l) => l.length)) + 1 }, (_, x) => {
    const own = CLI_LETTERS[r]?.[x] ?? ' ';
    if (own !== ' ') return own;
    return (CLI_LETTERS[r - 1]?.[x - 1] ?? ' ') !== ' ' ? ':' : ' ';
  }).join(''),
);

export const SMALL = ['▄▀█ ▀█▀ █▀▀ █   █ █▀▀ █▀█   █▀▀ █   █', '█▀█  █  ██▄ █▄▄ █ ██▄ █▀▄   █▄▄ █▄▄ █'];

export const TAGLINE = 'Your AI workspace, in your terminal.';

/**
 * The big wordmark for a terminal `columns` wide. `reveal` (0–1) paints it in from the left, as a brush would: letters
 * past the stroke aren't there yet, the stroke's edge is in the lightest colour. Every line keeps its full width (blank
 * past the stroke), so the wordmark stays in place while it is painted.
 */
export function bigBanner(paint: Paint, columns: number, reveal = 1, cursor = true): string[] {
  const withCli = columns >= 79;
  if (columns < 54) return smallBanner(paint);
  const wordWidth = [...BIG[0]!].length;
  const rows = BIG.map((row, i) => (withCli ? `${row}  ${BIG_CLI[i]}` : row));
  const width = Math.max(...rows.map((r) => [...r].length));
  const edge = reveal >= 1 ? width : Math.round(reveal * (width + 2));
  // The last `_` (the foot of the I) is the prompt's cursor.
  const last = CLI_PIXELS.length - 1;
  const cursorAt = { row: last, x: [...rows[last]!].lastIndexOf('_') };
  const lines = rows.map((row, r) => {
    const chars = [...row.padEnd(width)];
    // Each column's colour is the one it has when finished: the gradient over ATELIER; in CLI, > in clay and _ in grey.
    const word = paint.gradient(chars.slice(0, wordWidth).join(''));
    const cli = chars.slice(wordWidth).map((ch, i) => {
      if (r === cursorAt.row && wordWidth + i === cursorAt.x && !cursor) return ' ';
      // Bold, so the thin glyphs hold their own beside the solid blocks; the shadow faint.
      if (ch === '>') return paint.bold(paint.fg('accent', ch));
      if (ch === '_') return paint.bold(paint.fg('muted', ch));
      return ch === ':' ? paint.fg('faint', ch) : ch;
    });
    const painted = [...splitPainted(word), ...cli];
    // The brush's tip, in the light colour, only while it paints: finished, every cell has its own colour.
    const tip = (x: number) => reveal < 1 && x >= edge - 2 && chars[x] !== ' ';
    return painted.map((cell, x) => (x >= edge ? ' ' : tip(x) ? paint.hex(paint.p.gradient[0], chars[x]!) : cell)).join('');
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
