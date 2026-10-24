/**
 * The keyboard shortcuts in force for the signed-in person (their changes over the defaults in `@atelier/protocol`'s
 * SHORTCUTS), and how this computer shows and reads them.
 */
import { useMemo } from 'react';
import { bindingKeys, parseBinding, pressMatches, shortcutBindings, shortcutLabel, type KeyPress, type ShortcutBindings, type ShortcutId } from '@atelier/protocol';
import { isMac } from './platform.ts';
import { usePrefs } from './queries.ts';

export function useShortcutBindings(): ShortcutBindings {
  const { prefs } = usePrefs();
  const changes = prefs?.shortcuts;
  return useMemo(() => shortcutBindings(changes), [changes]);
}

/** One action's binding; null when it is turned off. */
export function useShortcut(id: ShortcutId): string | null {
  return useShortcutBindings()[id];
}

export const pressIs = (binding: string | null, press: KeyPress): boolean => pressMatches(binding, press, isMac);

/** ["⌘", "Shift", "N"], one per key cap; null when the shortcut is off. */
export function keysOf(binding: string): string[];
export function keysOf(binding: string | null): string[] | null;
export function keysOf(binding: string | null): string[] | null {
  return binding ? bindingKeys(binding, isMac) : null;
}

/** "⇧⌘N" or "Ctrl+Shift+N", for a menu item; undefined when the shortcut is off. */
export const shortcutText = (binding: string | null): string | undefined => (binding ? shortcutLabel(binding, isMac) : undefined);

/** `aria-keyshortcuts`' form ("Meta+Shift+E"); undefined when the shortcut is off. */
export function ariaKeysOf(binding: string | null): string | undefined {
  const parsed = binding ? parseBinding(binding) : null;
  if (!parsed) return undefined;
  const { mod, ctrl, alt, shift, key } = parsed;
  return [...(mod ? [isMac ? 'Meta' : 'Control'] : []), ...(ctrl ? ['Control'] : []), ...(alt ? ['Alt'] : []), ...(shift ? ['Shift'] : []), key].join('+');
}
