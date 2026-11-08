/**
 * Full lists to pick from in place of the message box: models (grouped by where they come from), effort, sessions to
 * resume (also those started in the browser or the desktop app), and where to rewind to. Typing filters; Enter picks,
 * Esc goes back.
 */
import { Box, Text } from 'ink';
import type { Paint } from '../style.ts';
import { FilterList } from './inputs.tsx';

export interface PickItem<T> {
  value: T;
  label: string;
  /** Muted, after the label on the same line. */
  hint?: string;
  /** A heading row above it (not pickable). */
  group?: string;
  current?: boolean;
}

export function ListPicker<T>({ paint, title, items, onPick, onCancel, rows = 10, empty = 'Nothing to show.' }: { paint: Paint; title: string; items: PickItem<T>[]; onPick(value: T): void; onCancel(): void; rows?: number; empty?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={paint.p.depth ? paint.p.accent : undefined} paddingX={1}>
      <Text>{paint.bold(paint.fg('accent', title))}</Text>
      <FilterList paint={paint} items={items.map((i) => ({ value: i.value, label: i.label, ...(i.hint ? { aside: i.hint } : {}), ...(i.group ? { group: i.group } : {}), ...(i.current ? { current: true } : {}) }))} rows={rows} onPick={onPick} onCancel={onCancel} empty={empty} />
      <Text>{paint.fg('faint', '↑/↓ choose · enter pick · esc back')}</Text>
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
