import { describe, expect, it } from 'vitest';
import { smallWindow } from './code-page.tsx';

describe('the small window note', () => {
  it('warns below 16k tokens and says nothing otherwise', () => {
    expect(smallWindow(8192)).toBe("This model's 8.2k window is small for Code: long tasks compact often. Raise it in Settings › Admin › Models.");
    expect(smallWindow(15_999)).toMatch(/16k window/);
    expect(smallWindow(16_000)).toBeUndefined();
    expect(smallWindow(131_072)).toBeUndefined();
    expect(smallWindow(undefined)).toBeUndefined();
  });
});
