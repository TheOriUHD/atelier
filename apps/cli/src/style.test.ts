import { describe, expect, it } from 'vitest';
import { colorDepth, Paint, palette, sgr, strip } from './style.ts';

describe('colour', () => {
  it('reads the terminal’s colour depth from the environment', () => {
    expect(colorDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe(0);
    expect(colorDepth({ FORCE_COLOR: '2' }, false)).toBe(2);
    expect(colorDepth({}, false)).toBe(0);
    expect(colorDepth({ COLORTERM: 'truecolor' }, true)).toBe(3);
    expect(colorDepth({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, true)).toBe(2);
    expect(colorDepth({ TERM: 'xterm' }, true)).toBe(process.platform === 'win32' ? 3 : 1);
  });
  it('comes down to 256 and 16 colours', () => {
    expect(sgr('#D97757', 3)).toBe('38;2;217;119;87');
    expect(sgr('#D97757', 2)).toMatch(/^38;5;\d+$/);
    expect(sgr('#D97757', 1, true)).toMatch(/^\d+$/);
    expect(sgr('#D97757', 0)).toBe('');
  });
  it('paints nothing without colour, and strips what it painted', () => {
    expect(new Paint(palette('dark', 0)).fg('accent', 'x')).toBe('x');
    expect(strip(new Paint(palette('light', 3)).gradient('ATELIER'))).toBe('ATELIER');
  });
});
