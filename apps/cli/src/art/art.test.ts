import { describe, expect, it } from 'vitest';
import { Paint, palette, strip } from '../style.ts';
import { bigBanner, smallBanner } from './banner.ts';
import { drawPip, PIP_BUSY, PIP_FRAMES, PIP_HELLO, PIP_IDLE } from './mascot.ts';
import { qrLines } from './qr.ts';

const width = (s: string) => [...strip(s)].length;
const colour = new Paint(palette('dark', 3));

describe('the wordmarks', () => {
  it('fits the terminal: ATELIER CLI, ATELIER alone, then the small one', () => {
    expect(Math.max(...bigBanner(colour, 80).map(width))).toBe(75);
    const narrow = bigBanner(colour, 77);
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
    // Finished, no cell keeps the brush tip's light colour: CLI's last cells are its own clay and grey.
    // eslint-disable-next-line no-control-regex -- ANSI codes are control characters.
    const colours = (line: string) => [...line.matchAll(/\x1b\[([0-9;]*)m[^\x1b ]/g)].map((m) => m[1]);
    for (const row of bigBanner(colour, 80)) expect(new Set(colours(row).slice(-4)).size).toBe(2);
  });
  it('draws ATELIER in flat blocks and CLI with prompts on the same five rows, its last _ a cursor that blinks', () => {
    const plain = bigBanner(colour, 80).map((l) => strip(l).trimEnd());
    expect(plain).toHaveLength(5);
    // Flat letters: no shadow lines anywhere, in ATELIER or in CLI.
    expect(plain.join('')).not.toMatch(/[╔╗╚╝║═]/);
    expect(plain[0]!.endsWith('  >_>_>_  >_        >_')).toBe(true);
    expect(plain.slice(1, 4).every((l) => l.endsWith('>_        >_        >_'))).toBe(true);
    expect(plain[4]!.startsWith('██   ██')).toBe(true);
    expect(plain[4]!.endsWith('  >_>_>_  >_>_>_>_  >_')).toBe(true);
    const off = bigBanner(colour, 80, 1, false).map((l) => strip(l).trimEnd());
    expect(off[4]).toBe(plain[4]!.slice(0, -1).trimEnd());
    expect(off.slice(0, 4)).toEqual(plain.slice(0, 4));
  });
});

describe('Pip', () => {
  it('has frames of one size, and every step of its loops is a frame', () => {
    const heights = Object.values(PIP_FRAMES).map((f) => f.length);
    expect(new Set(heights).size).toBe(1);
    expect(Object.values(PIP_FRAMES).every((f) => f.every((row) => row.length === 16))).toBe(true);
    for (const step of [...PIP_IDLE, ...PIP_BUSY, ...PIP_HELLO]) expect(PIP_FRAMES[step]).toBeDefined();
  });
  it('is drawn in half blocks, 16 wide and 7 tall, plain without colour', () => {
    const plain = drawPip('base', 0);
    expect(plain).toHaveLength(7);
    // Every line of every frame is 16 wide, so nothing beside Pip moves as it does.
    for (const frame of Object.keys(PIP_FRAMES) as (keyof typeof PIP_FRAMES)[]) expect(drawPip(frame, 3).map(width)).toEqual(Array(7).fill(16));
    expect(plain.every((l) => width(l) === 16)).toBe(true);
    expect(plain.join('')).toMatch(/^[ ▀▄█]+$/);
    expect(drawPip('blink', 3).join('')).toContain('\x1b[38;2;');
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
