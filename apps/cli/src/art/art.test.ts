import { describe, expect, it } from 'vitest';
import { Paint, palette, strip } from '../style.ts';
import { BIG, bigBanner, smallBanner } from './banner.ts';
import { drawPip, PIP_BUSY, PIP_FRAMES, PIP_HELLO, PIP_IDLE } from './mascot.ts';
import { qrLines } from './qr.ts';

const width = (s: string) => [...strip(s)].length;
const colour = new Paint(palette('dark', 3));

describe('the wordmarks', () => {
  it('fits the terminal: ATELIER CLI, ATELIER alone, then the small one', () => {
    expect(Math.max(...bigBanner(colour, 80).map(width))).toBe(73);
    const narrow = bigBanner(colour, 70);
    expect(Math.max(...narrow.map(width))).toBeLessThanOrEqual(52);
    expect(strip(narrow.at(-1)!).trim()).toBe('CLI');
    expect(bigBanner(colour, 50)).toEqual(smallBanner(colour));
  });
  it('paints in from the left, in place', () => {
    const half = bigBanner(colour, 80, 0.5).map(strip);
    const full = bigBanner(colour, 80).map(strip);
    expect(half.every((l) => l.trimEnd().length < 50)).toBe(true);
    // Every line keeps its width while it is painted, and what is painted is where it ends up.
    expect(half.map((l) => [...l].length)).toEqual(full.map((l) => [...l].length));
    expect(half[2]!.slice(0, 30)).toBe(full[2]!.slice(0, 30));
    expect(bigBanner(colour, 80, 0).map(strip).every((l) => l.trim() === '')).toBe(true);
  });
  it('draws both words in the same letters, CLI in ochre, with no brush tip left when finished', () => {
    const plain = bigBanner(colour, 80).map(strip);
    expect(plain[0]!.endsWith(' ██████╗██╗     ██╗')).toBe(true);
    expect(plain[5]!.endsWith(' ╚═════╝╚══════╝╚═╝')).toBe(true);
    // eslint-disable-next-line no-control-regex -- ANSI codes are control characters.
    const colours = (line: string) => [...line.matchAll(/\x1b\[([0-9;]*)m[^\x1b ]/g)].map((m) => m[1]);
    const row = colours(bigBanner(colour, 80)[2]!);
    const cli = row.slice([...BIG[2]!].filter((c) => c !== ' ').length);
    // Ochre has more green for its red than clay does.
    const ochre = (sgr: string) => Number(sgr.split(';')[3]) / Number(sgr.split(';')[2]) >= 0.7;
    // ATELIER starts in light clay; CLI's cells are all ochre, ending in deep ochre.
    expect(row[0]).toBe('38;2;240;160;124');
    expect(cli.length).toBeGreaterThan(5);
    expect(cli.every((c) => ochre(c!))).toBe(true);
    expect(row.slice(0, row.length - cli.length).some((c) => ochre(c!))).toBe(false);
    expect(cli.at(-1)).toBe('38;2;201;150;63');
    for (const line of bigBanner(colour, 80)) expect(colours(line).slice(-4)).not.toContain('38;2;240;160;124');
  });
});

describe('Pip', () => {
  it('has frames of one size, and every step of its loops is a frame', () => {
    expect(Object.values(PIP_FRAMES).every((f) => f.length === 12 && f.every((row) => row.length === 12))).toBe(true);
    for (const step of [...PIP_IDLE, ...PIP_BUSY, ...PIP_HELLO]) expect(PIP_FRAMES[step]).toBeDefined();
  });
  it('is drawn in half blocks, 12 wide and 6 tall, its eyes holes without colour', () => {
    for (const frame of Object.keys(PIP_FRAMES) as (keyof typeof PIP_FRAMES)[]) expect(drawPip(frame, 3).map(width)).toEqual(Array(6).fill(12));
    const plain = drawPip('base', 0);
    expect(plain).toHaveLength(6);
    expect(plain.join('')).toMatch(/^[ ▀▄█]+$/);
    // The eyes are holes, across two rows of half blocks.
    expect(plain[2]).toContain('█▀▀██▀▀█');
    expect(plain[3]).toContain('██▄▄██▄▄██');
    expect(drawPip('blink', 3).join('')).toContain('\x1b[38;2;');
  });
  it('has no pixel on its own: each touches another', () => {
    for (const rows of Object.values(PIP_FRAMES)) {
      const on = (r: number, c: number) => (rows[r]?.[c] ?? '.') !== '.';
      for (let r = 0; r < rows.length; r++)
        for (let c = 0; c < 12; c++) if (on(r, c)) expect(on(r - 1, c) || on(r + 1, c) || on(r, c - 1) || on(r, c + 1)).toBe(true);
    }
  });
});

describe('the QR code', () => {
  it('is square-ish with its quiet zone, and differs for dark and light terminals', () => {
    const dark = qrLines('https://atelier.example.com/#/link?code=K7QF-3MZD');
    expect(new Set(dark.map((l) => [...l].length)).size).toBe(1);
    expect(dark.length).toBeGreaterThan(10);
    expect(qrLines('x', 'light').join('')).not.toBe(qrLines('x', 'dark').join(''));
  });
});
