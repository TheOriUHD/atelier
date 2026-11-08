/**
 * The wordmarks (ARCHITECTURE §25): "ATELIER CLI" in big block letters for the setup wizard's splash and `atelier
 * --version`, painted left to right in the clay gradient, and a two-line one for the session header. The big one
 * needs 73 columns; narrower terminals get ATELIER alone, then the small one.
 */
import { strip, type Paint } from '../style.ts';

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
 * past the stroke aren't there yet, the stroke's edge is in the lightest colour.
 */
export function bigBanner(paint: Paint, columns: number, reveal = 1): string[] {
  const withCli = columns >= 76;
  if (columns < 54) return smallBanner(paint);
  const rows = BIG.map((row, i) => (withCli ? `${row}  ${BIG_CLI[i]}` : row));
  const width = Math.max(...rows.map((r) => [...r].length));
  const edge = Math.round(reveal * (width + 6));
  const lines = rows.map((row) => {
    const chars = [...row];
    const word = chars.slice(0, BIG[0]!.length).join('');
    const cli = withCli ? chars.slice(BIG[0]!.length).join('') : '';
    const painted = paint.gradient(word) + (cli ? paint.fg('muted', cli) : '');
    return reveal >= 1 ? painted : cutAt(painted, edge, paint);
  });
  if (!withCli) lines.push(`${' '.repeat(BIG[0]!.length - 3)}${paint.fg('muted', 'CLI')}`);
  return lines;
}

/** The two-line wordmark. */
export function smallBanner(paint: Paint): string[] {
  return SMALL.map((row) => {
    const word = row.slice(0, 27);
    return paint.gradient(word) + paint.fg('muted', row.slice(27));
  });
}

/** The first `columns` visible characters of a painted line (the rest blank), the last few in the brush's light. */
function cutAt(line: string, columns: number, paint: Paint): string {
  const plain = [...strip(line)];
  if (columns <= 0) return '';
  if (columns >= plain.length) return line;
  // Rebuild from the plain text: shown part in the gradient, the brush's tip in the light colour.
  const shown = plain.slice(0, Math.max(0, columns - 2)).join('');
  const tip = plain.slice(Math.max(0, columns - 2), columns).join('');
  return paint.gradient(shown, [paint.p.gradient[0], paint.p.gradient[1], paint.p.gradient[2]], 0) + paint.hex(paint.p.gradient[0], tip);
}
