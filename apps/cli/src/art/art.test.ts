import { describe, expect, it } from 'vitest';
import { Paint, palette, strip } from '../style.ts';
import { bigBanner, smallBanner } from './banner.ts';
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
  it('paints in from the left', () => {
    const half = bigBanner(colour, 80, 0.5).map(strip);
    expect(half.every((l) => [...l].length < 50)).toBe(true);
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
    expect(plain.every((l) => width(l) <= 16)).toBe(true);
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
