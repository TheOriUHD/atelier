import { describe, expect, it } from 'vitest';
import { UserPrefs } from './accounts.ts';
import { bindingKeys, bindingOf, bindingProblem, parseBinding, pressMatches, shortcutBindings, shortcutLabel, toAccelerator, type KeyPress } from './shortcuts.ts';

const press = (key: string, code: string, mods: Partial<Omit<KeyPress, 'key' | 'code'>> = {}): KeyPress => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('keyboard shortcuts', () => {
  it('keeps the defaults until someone changes one, and null turns one off', () => {
    expect(shortcutBindings(undefined)).toMatchObject({ 'new-chat': 'Mod+N', settings: 'Mod+,', effort: 'Mod+Shift+E' });
    expect(shortcutBindings({ search: 'Mod+J', upload: null })).toMatchObject({ search: 'Mod+J', upload: null, 'new-chat': 'Mod+N' });
  });

  it('reads a key press as a binding, the same way on every keyboard', () => {
    expect(bindingOf(press('n', 'KeyN', { metaKey: true }), true)).toBe('Mod+N');
    expect(bindingOf(press('N', 'KeyN', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+N');
    // A Mac's Control is its own modifier; Windows has no ⌘.
    expect(bindingOf(press('n', 'KeyN', { metaKey: true, ctrlKey: true }), true)).toBe('Mod+Ctrl+N');
    expect(bindingOf(press('n', 'KeyN', { metaKey: true }), false)).toBe('N');
    // What the layout types (QWERTZ's Z sits where QWERTY has Y), unless ⌥ or Shift changed the character.
    expect(bindingOf(press('z', 'KeyY', { metaKey: true }), true)).toBe('Mod+Z');
    expect(bindingOf(press('˜', 'KeyN', { metaKey: true, altKey: true }), true)).toBe('Mod+Alt+N');
    expect(bindingOf(press('!', 'Digit1', { ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+1');
    expect(bindingOf(press('<', 'Comma', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+,');
    expect(bindingOf(press('F5', 'F5'), false)).toBe('F5');
    expect(bindingOf(press(' ', 'Space', { ctrlKey: true }), false)).toBe('Mod+Space');
    expect(bindingOf(press('Shift', 'ShiftLeft', { shiftKey: true }), true)).toBeNull();
    expect(bindingOf(press('Meta', 'MetaLeft', { metaKey: true }), true)).toBeNull();
  });

  it('matches a press against a binding', () => {
    expect(pressMatches('Mod+K', press('k', 'KeyK', { metaKey: true }), true)).toBe(true);
    expect(pressMatches('Mod+K', press('k', 'KeyK', { metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(pressMatches(null, press('k', 'KeyK', { metaKey: true }), true)).toBe(false);
  });

  it('refuses a binding without ⌘ or Ctrl, one the system uses, or another action’s', () => {
    const bindings = shortcutBindings(undefined);
    expect(bindingProblem('search', 'Mod+J', bindings, true)).toBeNull();
    expect(bindingProblem('search', 'F6', bindings, false)).toBeNull();
    expect(bindingProblem('search', 'Mod+Ctrl+J', bindings, true)).toBeNull();
    expect(bindingProblem('search', 'Shift+J', bindings, true)).toBe('Add ⌘ or ⌃, so the shortcut doesn’t type text.');
    expect(bindingProblem('search', 'Alt+J', bindings, false)).toBe('Add Ctrl, so the shortcut doesn’t type text.');
    expect(bindingProblem('search', 'Mod+C', bindings, true)).toBe('⌘C is Copy.');
    expect(bindingProblem('search', 'Mod+H', bindings, true)).toBe('⌘H is Hide Atelier.');
    expect(bindingProblem('search', 'Mod+H', bindings, false)).toBeNull();
    expect(bindingProblem('search', 'Mod+B', bindings, false)).toBe('Ctrl+B already does “Show or hide the sidebar”.');
    // Its own binding again is fine, and a binding turned off frees its keys.
    expect(bindingProblem('search', 'Mod+K', bindings, true)).toBeNull();
    expect(bindingProblem('search', 'Mod+B', { ...bindings, 'toggle-sidebar': null }, true)).toBeNull();
  });

  it('shows a binding as key caps, a menu label and an Electron accelerator', () => {
    expect(bindingKeys('Mod+Shift+N', true)).toEqual(['⌘', 'Shift', 'N']);
    expect(bindingKeys('Mod+Alt+ArrowUp', false)).toEqual(['Ctrl', 'Alt', '↑']);
    expect(shortcutLabel('Mod+Shift+L', true)).toBe('⇧⌘L');
    expect(shortcutLabel('Mod+Ctrl+Alt+K', true)).toBe('⌃⌥⌘K');
    expect(shortcutLabel('Mod+Shift+L', false)).toBe('Ctrl+Shift+L');
    expect(toAccelerator('Mod+Shift+N')).toBe('CmdOrCtrl+Shift+N');
    expect(toAccelerator('Mod+Ctrl+ArrowLeft')).toBe('CmdOrCtrl+Ctrl+Left');
    expect(toAccelerator('Mod+,')).toBe('CmdOrCtrl+,');
    expect(toAccelerator('F6')).toBe('F6');
    expect(toAccelerator(null)).toBeUndefined();
    expect(toAccelerator('Hyper+N')).toBeUndefined();
  });

  it('parses only well-formed bindings', () => {
    expect(parseBinding('Mod+Shift+=')).toEqual({ mod: true, ctrl: false, alt: false, shift: true, key: '=' });
    expect(parseBinding('Shift+Mod+N')).toBeNull();
    expect(parseBinding('Mod+')).toBeNull();
    expect(parseBinding('Mod+Escape')).toBeNull();
  });

  it('is a preference that keeps only what was changed', () => {
    expect(UserPrefs.parse({}).shortcuts).toEqual({});
    expect(UserPrefs.parse({ shortcuts: { search: 'Mod+J', upload: null, nonsense: 'Mod+X' } }).shortcuts).toEqual({ search: 'Mod+J', upload: null });
    expect(UserPrefs.safeParse({ shortcuts: { search: 'J+Mod' } }).success).toBe(false);
  });
});
