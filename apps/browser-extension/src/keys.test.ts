import { describe, expect, it } from 'vitest';
import { keyNamed, parseChord, reachesTheBrowser } from './keys.ts';

describe('keys', () => {
  it('names keys the way the debugger wants them', () => {
    expect(keyNamed('Enter')).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(keyNamed('a')).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
    expect(keyNamed('7')).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55 });
    expect(keyNamed('F5')).toMatchObject({ key: 'F5', windowsVirtualKeyCode: 116 });
    expect(keyNamed('down')).toMatchObject({ key: 'ArrowDown' });
    expect(keyNamed('nope')).toBeNull();
  });

  it('turns a chord into modifier bits and one key', () => {
    expect(parseChord(['Meta', 'a'])).toEqual({ modifiers: 4, key: expect.objectContaining({ key: 'a', text: undefined }) });
    expect(parseChord(['ctrl+shift+Tab'])).toEqual({ modifiers: 10, key: expect.objectContaining({ key: 'Tab' }) });
    expect(parseChord(['Shift', 'b']).key).toMatchObject({ key: 'B', text: 'B' });
    expect(() => parseChord(['Meta'])).toThrow(/exactly one key/);
    expect(() => parseChord(['a', 'b'])).toThrow(/exactly one key/);
    expect(() => parseChord(['Hyper'])).toThrow(/Unknown key/);
  });

  it('refuses shortcuts that reach the browser rather than the page', () => {
    for (const keys of [['Meta', 't'], ['Meta', 'n'], ['Meta', 'w'], ['Ctrl', 'l'], ['Meta', 'q']]) expect(reachesTheBrowser(parseChord(keys))).toBe(true);
    for (const keys of [['Meta', 'a'], ['Meta', 'c'], ['Enter'], ['t']]) expect(reachesTheBrowser(parseChord(keys))).toBe(false);
  });
});
