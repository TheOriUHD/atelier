import { afterEach, describe, expect, it } from 'vitest';
import { trackTabFocus } from './focus-mode.ts';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  delete document.documentElement.dataset.focus;
});

const key = (init: KeyboardEventInit) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));

describe('focus rings', () => {
  it('show from a Tab press until the next click, and never after other keys', () => {
    stop = trackTabFocus();
    const focus = () => document.documentElement.dataset.focus;

    // A shortcut, the keys of a screenshot, typing, Enter: no ring.
    for (const k of [{ key: 'k', metaKey: true }, { key: '4', metaKey: true, shiftKey: true }, { key: 'S', shiftKey: true }, { key: 'a' }, { key: 'Enter' }]) key(k);
    expect(focus()).toBeUndefined();

    key({ key: 'Tab' });
    expect(focus()).toBe('tab');
    // Keys after Tab keep the rings while the person works with the keyboard.
    key({ key: 'Enter' });
    expect(focus()).toBe('tab');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(focus()).toBeUndefined();

    key({ key: 'Tab', shiftKey: true });
    expect(focus()).toBe('tab');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    // Ctrl+Tab and ⌘Tab switch tabs or apps.
    key({ key: 'Tab', ctrlKey: true });
    key({ key: 'Tab', metaKey: true });
    expect(focus()).toBeUndefined();
  });
});
