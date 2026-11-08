/**
 * The wordmarks (ARCHITECTURE §25): "ATELIER CLI" in big block letters for the setup's first screen and `atelier
 * --version`, ATELIER in the clay gradient and CLI in an ochre one of its own (the colour of Pip's brush), painted in
 * from the left. The big one needs 73 columns; narrower terminals get ATELIER alone, then a two-line one.
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

/** CLI's colours: ochre, light to deep, a little apart from ATELIER's clay. */
const CLI_GRADIENT = { dark: ['#F5D58E', '#E6B86A', '#C9963F'], light: ['#C9963F', '#A87A2A', '#86601C'] } as const;

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
    // Each column's colour is the one it has when finished: the clay gradient over ATELIER, the ochre one over CLI.
    const word = paint.gradient(chars.slice(0, wordWidth).join(''));
    const cli = paint.gradient(chars.slice(wordWidth).join(''), CLI_GRADIENT[paint.p.shade]);
    const painted = [...splitPainted(word), ...splitPainted(cli)];
    // The brush's tip, in the light colour, only while it paints: finished, every cell has its own colour.
    const tip = (x: number) => reveal < 1 && x >= edge - 2 && chars[x] !== ' ';
    return painted.map((cell, x) => (x >= edge ? ' ' : tip(x) ? paint.hex(paint.p.gradient[0], chars[x]!) : cell)).join('');
  });
  if (!withCli) lines.push(`${' '.repeat(wordWidth - 3)}${reveal >= 1 ? paint.gradient('CLI', CLI_GRADIENT[paint.p.shade]) : '   '}`);
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
