/**
 * Full lists to pick from in place of the message box: models (grouped by where they come from), effort, sessions to
 * resume (also those started in the browser or the desktop app), and where to rewind to. Typing filters; Enter picks,
 * Esc goes back.
 */
import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { Paint } from '../style.ts';

export interface PickItem<T> {
  value: T;
  label: string;
  hint?: string;
  /** A heading row above it (not pickable). */
  group?: string;
  current?: boolean;
}

export function ListPicker<T>({ paint, title, items, onPick, onCancel, rows = 10, empty = 'Nothing to show.' }: { paint: Paint; title: string; items: PickItem<T>[]; onPick(value: T): void; onCancel(): void; rows?: number; empty?: string }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((i) => i.current)));
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return q ? items.filter((i) => `${i.label} ${i.hint ?? ''} ${i.group ?? ''}`.toLowerCase().includes(q)) : items;
  }, [items, query]);
  const at = Math.min(index, Math.max(0, shown.length - 1));
  useInput((input, key) => {
    if (key.escape) return query ? setQuery('') : onCancel();
    if (key.return) return shown[at] && onPick(shown[at]!.value);
    if (key.upArrow || (key.ctrl && input === 'p')) return setIndex((at - 1 + shown.length) % Math.max(1, shown.length));
    if (key.downArrow || (key.ctrl && input === 'n') || key.tab) return setIndex((at + 1) % Math.max(1, shown.length));
    if (key.pageUp) return setIndex(Math.max(0, at - rows));
    if (key.pageDown) return setIndex(Math.min(shown.length - 1, at + rows));
    if (key.backspace) return (setQuery(query.slice(0, -1)), setIndex(0));
    if (key.ctrl || key.meta) return;
    if (input && input >= ' ') {
      setQuery(query + input);
      setIndex(0);
    }
  });
  const start = Math.max(0, Math.min(at - Math.floor(rows / 2), shown.length - rows));
  const window = shown.slice(start, start + rows);
  let lastGroup: string | undefined;
  const lines: string[] = [];
  window.forEach((item, i) => {
    if (item.group && item.group !== lastGroup) lines.push(paint.fg('muted', item.group));
    lastGroup = item.group;
    const on = start + i === at;
    lines.push(`${on ? paint.fg('accent', '› ') : '  '}${on ? paint.bold(item.label) : item.label}${item.current ? paint.fg('accent', ' ✓') : ''}${item.hint ? paint.fg('muted', `  ${item.hint}`) : ''}`);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={paint.p.depth ? paint.p.accent : undefined} paddingX={1}>
      <Text>{`${paint.bold(paint.fg('accent', title))}${query ? paint.fg('muted', `  filter: ${query}`) : paint.fg('faint', '  type to filter')}`}</Text>
      <Text>{shown.length ? lines.join('\n') : paint.fg('muted', empty)}</Text>
      <Text>{paint.fg('faint', `↑/↓ choose · enter pick · esc back${shown.length > rows ? ` · ${at + 1} of ${shown.length}` : ''}`)}</Text>
    </Box>
  );
}

/** "3 minutes ago", "yesterday", "12 Oct". */
export function when(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86_400) return 'yesterday';
  return new Date(at).toLocaleDateString('en', { day: 'numeric', month: 'short' });
}
