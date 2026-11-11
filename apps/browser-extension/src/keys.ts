// Keys as Chrome's debugger dispatches them (Input.dispatchKeyEvent): a chord like ["Meta", "a"] or ["Enter"] becomes the
// modifier bits and the key's DOM key, code and Windows virtual key code.

export interface KeyEvent {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** The text a printable key inserts (none with Ctrl or Meta held). */
  text?: string;
}

export interface Chord {
  /** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  modifiers: number;
  key: KeyEvent;
}

const MODIFIERS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const NAMED: Record<string, KeyEvent> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

/** One key by name: a named key, a letter, a digit or another single character. */
export function keyNamed(name: string): KeyEvent | null {
  const named = NAMED[name.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-2])$/i.test(name)) {
    const n = Number(name.slice(1));
    return { key: `F${n}`, code: `F${n}`, windowsVirtualKeyCode: 111 + n };
  }
  if ([...name].length !== 1) return null;
  if (/^[a-z]$/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: name };
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, windowsVirtualKeyCode: name.charCodeAt(0), text: name };
  return { key: name, code: '', windowsVirtualKeyCode: 0, text: name };
}

/** A chord: any modifiers, then exactly one key. */
export function parseChord(keys: string[]): Chord {
  let modifiers = 0;
  const others: string[] = [];
  for (const k of keys.flatMap((k) => (k.length > 1 && k.includes('+') ? k.split('+') : [k]))) {
    const bit = MODIFIERS[k.toLowerCase()];
    if (bit) modifiers |= bit;
    else others.push(k);
  }
  if (others.length !== 1) throw new Error(`A key chord needs exactly one key besides the modifiers, not ${others.length}: ${keys.join('+')}`);
  const key = keyNamed(others[0]!);
  if (!key) throw new Error(`Unknown key "${others[0]}"`);
  // With Ctrl or Meta held a key is a shortcut and types nothing; Shift makes a letter uppercase.
  if (modifiers & (2 | 4)) return { modifiers, key: { ...key, text: undefined } };
  if (modifiers & 8 && key.text && /^[a-z]$/.test(key.text)) return { modifiers, key: { ...key, key: key.key.toUpperCase(), text: key.text.toUpperCase() } };
  return { modifiers, key };
}

/** Shortcuts that would open a tab or a window, or reach the browser itself rather than the page: refused. */
export function reachesTheBrowser(chord: Chord): boolean {
  if (!(chord.modifiers & (2 | 4))) return false;
  return ['t', 'n', 'w', 'q', 'l', 'h', 'm', ','].includes(chord.key.key.toLowerCase());
}
