/**
 * The keyboard shortcuts people can change (Settings › Keyboard shortcuts), one table for the page, the app's key
 * handling, the shortcuts dialog and the desktop menu. A binding is written "Mod+Shift+N": Mod is ⌘ on a Mac and Ctrl
 * elsewhere, Ctrl is the Mac's Control key (Mac only), then Alt and Shift, then the key. Prefs keep only the bindings
 * someone changed (null: turned off); everything else is the default here.
 */
import { z } from 'zod';

export const SHORTCUT_IDS = ['new-chat', 'new-temporary-chat', 'search', 'settings', 'toggle-sidebar', 'lock', 'upload', 'effort'] as const;
export type ShortcutId = (typeof SHORTCUT_IDS)[number];

export interface ShortcutInfo {
  id: ShortcutId;
  label: string;
  group: 'App' | 'Message box';
  binding: string;
}

export const SHORTCUTS: readonly ShortcutInfo[] = [
  { id: 'new-chat', label: 'New chat, task or session', group: 'App', binding: 'Mod+N' },
  { id: 'new-temporary-chat', label: 'New temporary chat', group: 'App', binding: 'Mod+Shift+N' },
  { id: 'search', label: 'Search', group: 'App', binding: 'Mod+K' },
  { id: 'settings', label: 'Settings', group: 'App', binding: 'Mod+,' },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', group: 'App', binding: 'Mod+B' },
  // The screen lock exists only on "Run on this computer".
  { id: 'lock', label: 'Lock Atelier', group: 'App', binding: 'Mod+Shift+L' },
  { id: 'upload', label: 'Upload or add files', group: 'Message box', binding: 'Mod+U' },
  { id: 'effort', label: 'Change effort', group: 'Message box', binding: 'Mod+Shift+E' },
];

type Modifier = 'Mod' | 'Ctrl' | 'Alt' | 'Shift';

const NAMED_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'Insert'] as const;
/** The punctuation keys by their `KeyboardEvent.code`, for a press whose character Shift or Alt changed. */
const PUNCTUATION: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};
const PUNCTUATION_KEYS = new Set(Object.values(PUNCTUATION));

const KEY_RE = String.raw`(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|[,./;'[\]\\\-=\x60]|${NAMED_KEYS.join('|')})`;
const BINDING_RE = new RegExp(`^(?:Mod\\+)?(?:Ctrl\\+)?(?:Alt\\+)?(?:Shift\\+)?${KEY_RE}$`);

export const ShortcutBinding = z.string().max(40).regex(BINDING_RE, 'Not a shortcut');

const changed = ShortcutBinding.nullable().optional();
/** What a person changed: a binding, or null for turned off. Unknown actions are dropped. */
export const ShortcutPrefs = z.object({
  'new-chat': changed,
  'new-temporary-chat': changed,
  search: changed,
  settings: changed,
  'toggle-sidebar': changed,
  lock: changed,
  upload: changed,
  effort: changed,
});
export type ShortcutPrefs = z.infer<typeof ShortcutPrefs>;

export type ShortcutBindings = Record<ShortcutId, string | null>;

/** Every action's binding in force: the person's, or the default (null: off). */
export function shortcutBindings(changes: ShortcutPrefs | undefined): ShortcutBindings {
  return Object.fromEntries(SHORTCUTS.map((s) => [s.id, changes?.[s.id] === undefined ? s.binding : changes[s.id]!])) as ShortcutBindings;
}

export interface ParsedBinding {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseBinding(binding: string): ParsedBinding | null {
  if (!BINDING_RE.test(binding)) return null;
  // "Mod+-" and "Mod++" never occur ("=" is the plus key); the key is what follows the last modifier.
  const parts = binding.split('+');
  const mods = new Set(parts.slice(0, -1) as Modifier[]);
  return { mod: mods.has('Mod'), ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), key: parts.at(-1)! };
}

/** The fields of a key press a binding is read from (a DOM KeyboardEvent has them all). */
export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The binding a key press makes, or null for a modifier on its own or a key no shortcut can use. Letters and digits are
 * read as the layout types them (the key that says Z on a German keyboard is Z), falling back to the key's place when a
 * modifier changed the character (⌥N on a Mac types ˜).
 */
export function bindingOf(press: KeyPress, mac: boolean): string | null {
  const key = keyOf(press);
  if (!key) return null;
  const mods: Modifier[] = [];
  if (mac ? press.metaKey : press.ctrlKey) mods.push('Mod');
  if (mac && press.ctrlKey) mods.push('Ctrl');
  if (press.altKey) mods.push('Alt');
  if (press.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

function keyOf({ key, code }: KeyPress): string | null {
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  const place = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  if (place) return place[1] ?? place[2]!;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (PUNCTUATION_KEYS.has(key)) return key;
  if (PUNCTUATION[code]) return PUNCTUATION[code];
  if (code === 'Space') return 'Space';
  return (NAMED_KEYS as readonly string[]).includes(key) ? key : null;
}

/** Whether a key press is this binding (null never matches). */
export function pressMatches(binding: string | null, press: KeyPress, mac: boolean): boolean {
  return binding !== null && bindingOf(press, mac) === binding;
}

/** Shortcuts that belong to the system, the editor or the window, by binding, with what they do. */
const RESERVED: Record<string, string> = {
  'Mod+Z': 'Undo',
  'Mod+Shift+Z': 'Redo',
  'Mod+Y': 'Redo',
  'Mod+X': 'Cut',
  'Mod+C': 'Copy',
  'Mod+V': 'Paste',
  'Mod+A': 'Select all',
  'Mod+0': 'Actual size',
  'Mod+=': 'Zoom in',
  'Mod+-': 'Zoom out',
  'Mod+M': 'Minimize',
  'Mod+W': 'Close window',
  'Mod+Q': 'Quit',
  'Mod+R': 'Reload',
  'Mod+T': 'New tab in a browser',
  'Mod+Alt+I': 'Developer tools',
};
const RESERVED_MAC: Record<string, string> = { 'Mod+H': 'Hide Atelier', 'Mod+Alt+H': 'Hide others', 'Mod+Ctrl+F': 'Full screen', 'Mod+Ctrl+Space': 'Emoji & Symbols' };
const RESERVED_OTHER: Record<string, string> = { F11: 'Full screen' };

/**
 * Why a binding can't be used for `id`, in a sentence, or null when it can: it needs ⌘/Ctrl (Control also works on a
 * Mac) unless it is a function key, mustn't be one the system or the editor uses, nor another action's.
 */
export function bindingProblem(id: ShortcutId, binding: string, bindings: ShortcutBindings, mac: boolean): string | null {
  const parsed = parseBinding(binding);
  if (!parsed) return 'That key can’t be used in a shortcut.';
  if (!parsed.mod && !parsed.ctrl && !/^F\d+$/.test(parsed.key)) return `Add ${mac ? '⌘ or ⌃' : 'Ctrl'}, so the shortcut doesn’t type text.`;
  const reserved = RESERVED[binding] ?? (mac ? RESERVED_MAC : RESERVED_OTHER)[binding];
  if (reserved) return `${shortcutLabel(binding, mac)} is ${reserved}.`;
  const other = SHORTCUTS.find((s) => s.id !== id && bindings[s.id] === binding);
  return other ? `${shortcutLabel(binding, mac)} already does “${other.label}”.` : null;
}

const MAC_KEYS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↩', Backspace: '⌫', Delete: '⌦', Tab: '⇥' };
const OTHER_KEYS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

/** The keys to press, one per key cap: ["⌘", "Shift", "N"] on a Mac, ["Ctrl", "Shift", "N"] elsewhere. */
export function bindingKeys(binding: string, mac: boolean): string[] {
  const p = parseBinding(binding);
  if (!p) return [binding];
  return [
    ...(p.mod ? [mac ? '⌘' : 'Ctrl'] : []),
    ...(p.ctrl ? ['⌃'] : []),
    ...(p.alt ? [mac ? '⌥' : 'Alt'] : []),
    ...(p.shift ? ['Shift'] : []),
    (mac ? MAC_KEYS : OTHER_KEYS)[p.key] ?? p.key,
  ];
}

/** One string, as a menu shows it: "⇧⌘N" on a Mac (Apple's order), "Ctrl+Shift+N" elsewhere. */
export function shortcutLabel(binding: string, mac: boolean): string {
  const p = parseBinding(binding);
  if (!p) return binding;
  const key = (mac ? MAC_KEYS : OTHER_KEYS)[p.key] ?? p.key;
  if (mac) return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod ? '⌘' : ''}${key}`;
  return [...(p.mod ? ['Ctrl'] : []), ...(p.alt ? ['Alt'] : []), ...(p.shift ? ['Shift'] : []), key].join('+');
}

const ACCELERATOR_KEYS: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return' };

/** Electron's accelerator for a binding ("Mod+Shift+N" → "CmdOrCtrl+Shift+N"); undefined when off or unreadable. */
export function toAccelerator(binding: string | null | undefined): string | undefined {
  const p = binding ? parseBinding(binding) : null;
  if (!p) return undefined;
  return [...(p.mod ? ['CmdOrCtrl'] : []), ...(p.ctrl ? ['Ctrl'] : []), ...(p.alt ? ['Alt'] : []), ...(p.shift ? ['Shift'] : []), ACCELERATOR_KEYS[p.key] ?? p.key].join('+');
}
