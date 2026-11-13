/**
 * Small input pieces shared by the prompts, pickers and the setup wizard: a one-line text field (hidden for keys and
 * passwords) and a list of choices with a cursor, numbers and a line of explanation each.
 */
import { Box, Text, useInput, usePaste } from 'ink';
import { useMemo, useRef, useState } from 'react';
import type { Paint } from '../style.ts';
import * as ed from './editor.ts';

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  /** Muted, after the label on the same line. */
  aside?: string;
  /** Shown but not pickable. */
  disabled?: boolean;
}

/** The cursor as an inverted cell. */
export function withCursor(text: string, cursor: number, paint: Paint, show = true): string {
  if (!show) return text;
  const at = text[cursor];
  const ch = at === undefined || at === '\n' ? ' ' : at;
  const before = text.slice(0, cursor);
  const after = text.slice(cursor + (at === undefined || at === '\n' ? 0 : ch.length));
  return `${before}${paint.p.depth > 0 ? paint.inverse(ch) : `\x1b[7m${ch}\x1b[27m`}${after}`;
}

export function TextLine({
  paint,
  active = true,
  mask = false,
  placeholder = '',
  initial = '',
  onSubmit,
  onCancel,
  onChange,
  prefix = '› ',
}: {
  paint: Paint;
  active?: boolean;
  mask?: boolean;
  placeholder?: string;
  initial?: string;
  onSubmit(value: string): void;
  onCancel?(): void;
  onChange?(value: string): void;
  prefix?: string;
}) {
  const [s, set] = useState(() => ed.emptyEditor(initial));
  // Keys can come faster than the screen redraws (a busy moment, a console that sends several at once): each one builds
  // on the text as the last one left it, not on the last drawn one, or keys were lost and a password came out short.
  const latest = useRef(s);
  const update = (next: ed.EditorState) => {
    const before = latest.current.text;
    latest.current = next;
    set(next);
    if (next.text !== before) onChange?.(next.text);
  };
  usePaste((text) => update(ed.insert(latest.current, text.replace(/\r?\n/g, mask ? '' : ' '))), { isActive: active });
  useInput(
    (input, key) => {
      const now = latest.current;
      if (key.return) return onSubmit(now.text);
      if (key.escape) return onCancel?.();
      if (key.backspace || (key.ctrl && input === 'h')) return update(ed.backspace(now));
      if (key.delete) return update(ed.del(now));
      if (key.leftArrow) return update(key.ctrl || key.meta ? ed.wordLeft(now) : ed.left(now));
      if (key.rightArrow) return update(key.ctrl || key.meta ? ed.wordRight(now) : ed.right(now));
      if (key.home || (key.ctrl && input === 'a')) return update(ed.home(now));
      if (key.end || (key.ctrl && input === 'e')) return update(ed.end(now));
      if (key.ctrl && input === 'u') return update(ed.killToStart(now));
      if (key.ctrl && input === 'k') return update(ed.killToEnd(now));
      if (key.ctrl && input === 'w') return update(ed.killWordBack(now));
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
      if (!input) return;
      // The last letters and Enter in one read: the letters, then Enter (it went into the password as a character).
      const end = input.search(/[\r\n]/);
      if (end === -1) return update(ed.insert(now, input));
      const typed = end > 0 ? ed.insert(now, input.slice(0, end)) : now;
      if (end > 0) update(typed);
      onSubmit(typed.text);
    },
    { isActive: active },
  );
  const shown = mask ? '•'.repeat([...s.text].length) : s.text;
  const body = s.text ? withCursor(shown, mask ? [...s.text.slice(0, s.cursor)].length : s.cursor, paint, active) : `${withCursor('', 0, paint, active)}${paint.fg('faint', placeholder)}`;
  return <Text>{`${paint.fg('accent', prefix)}${body}`}</Text>;
}

/**
 * Choices with ↑/↓ (or 1–9) and Enter; Esc cancels; Space calls `onToggle` (checkboxes). The picked row has the accent's
 * ›. A choice's hint goes beneath it, indented under its label when it wraps; its `aside` follows it on the same line.
 * Once moved, the cursor stays on the same choice when choices are added or removed around it.
 */
export function Choices<T>({
  paint,
  choices,
  active = true,
  onPick,
  onCancel,
  onToggle,
  initial = 0,
  numbered = true,
  showHints = 'focused',
}: {
  paint: Paint;
  choices: Choice<T>[];
  active?: boolean;
  onPick(value: T, index: number): void;
  onCancel?(): void;
  onToggle?(value: T, index: number): void;
  initial?: number;
  numbered?: boolean;
  showHints?: 'focused' | 'all' | 'none';
}) {
  // Until the person moves, the cursor is at `initial` (a list that is still filling in starts on its first row).
  const [picked, setPicked] = useState<{ value: T } | null>(null);
  const start = Math.min(Math.max(0, initial), Math.max(0, choices.length - 1));
  const indexOf = (p: { value: T } | null) => {
    const found = p ? choices.findIndex((c) => Object.is(c.value, p.value)) : -1;
    return found === -1 ? start : found;
  };
  const index = indexOf(picked);
  // Each step builds on the last one, so keys pressed faster than the screen redraws (a held arrow) all count.
  const move = (delta: number) =>
    setPicked((prev) => {
      let i = indexOf(prev);
      for (let tries = 0; tries < choices.length; tries++) {
        i = (i + delta + choices.length) % choices.length;
        if (!choices[i]?.disabled) break;
      }
      return choices[i] ? { value: choices[i]!.value } : prev;
    });
  useInput(
    (input, key) => {
      if (key.upArrow || (key.ctrl && input === 'p')) return move(-1);
      if (key.downArrow || (key.ctrl && input === 'n') || key.tab) return move(1);
      if (key.escape) return onCancel?.();
      const c = choices[index];
      if (key.return) {
        if (c && !c.disabled) onPick(c.value, index);
        return;
      }
      if (input === ' ' && onToggle) {
        if (c && !c.disabled) onToggle(c.value, index);
        return;
      }
      const n = Number(input);
      if (numbered && n >= 1 && n <= Math.min(9, choices.length) && !choices[n - 1]?.disabled) {
        setPicked({ value: choices[n - 1]!.value });
        onPick(choices[n - 1]!.value, n - 1);
      }
    },
    { isActive: active },
  );
  const indent = numbered ? 5 : 2;
  return (
    <Box flexDirection="column">
      {choices.map((c, i) => {
        const on = i === index;
        const mark = on ? paint.fg('accent', '› ') : '  ';
        const number = numbered ? paint.fg('muted', `${i + 1}. `) : '';
        const label = c.disabled ? paint.fg('faint', c.label) : on ? paint.bold(c.label) : c.label;
        const aside = c.aside ? paint.fg('muted', `  ${c.aside}`) : '';
        const hint = c.hint && (showHints === 'all' || (showHints === 'focused' && on));
        return (
          <Box key={i} flexDirection="column">
            <Text>{`${mark}${number}${label}${aside}`}</Text>
            {hint && (
              <Box paddingLeft={indent}>
                <Text>{paint.fg('muted', c.hint!)}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export interface FormField {
  name: string;
  label: string;
  mask?: boolean;
  placeholder?: string;
  initial?: string;
}

/**
 * Fields on one screen, a label column beside each: Enter goes to the next field and sends from the last, Tab and ↓
 * go down, Shift+Tab and ↑ go up, Esc cancels. An `extra` row below the fields (an invite code instead) is reached with
 * ↓ and picked with Enter.
 */
export function Form({ paint, fields, onSubmit, onCancel, extra, active = true }: { paint: Paint; fields: FormField[]; onSubmit(values: Record<string, string>): void; onCancel(): void; extra?: { label: string; onPick(): void }; active?: boolean }) {
  // The first empty field has the cursor: a remembered username starts on the password.
  const [at, setAt] = useState(() => Math.max(0, fields.findIndex((f) => !f.initial)));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ''])));
  /** What is typed, as of the last key (the drawn `values` can be a key behind). */
  const typed = useRef(values);
  const last = fields.length - 1 + (extra ? 1 : 0);
  const go = (to: number) => setAt(Math.min(last, Math.max(0, to)));
  const step = (delta: number) => setAt((a) => Math.min(last, Math.max(0, a + delta)));
  useInput(
    (input, key) => {
      if (key.tab && key.shift) return step(-1);
      if (key.upArrow) return step(-1);
      if (key.tab || key.downArrow) return step(1);
      if (extra && at === fields.length && key.return) return extra.onPick();
      if (extra && at === fields.length && key.escape) return onCancel();
      void input;
    },
    { isActive: active },
  );
  const width = Math.max(...fields.map((f) => [...f.label].length)) + 2;
  const submit = (name: string, value: string) => {
    const all = { ...typed.current, [name]: value };
    typed.current = all;
    setValues(all);
    // Enter goes to the next empty field; when none is left, it sends.
    const i = fields.findIndex((f) => f.name === name);
    const empty = (f: FormField) => !(all[f.name] ?? '').trim();
    const next = fields.findIndex((f, j) => j > i && empty(f));
    if (next !== -1) return go(next);
    const before = fields.findIndex(empty);
    if (before !== -1) return go(before);
    onSubmit(Object.fromEntries(fields.map((f) => [f.name, f.mask ? all[f.name]! : all[f.name]!.trim()])));
  };
  return (
    <Box flexDirection="column">
      {fields.map((f, i) => (
        <Box key={f.name} flexDirection="row">
          <Box width={width} flexShrink={0}>
            <Text>{i === at ? paint.bold(f.label) : paint.fg('secondary', f.label)}</Text>
          </Box>
          <TextLine
            key={f.name}
            paint={paint}
            active={active && i === at}
            mask={!!f.mask}
            placeholder={f.placeholder ?? ''}
            initial={values[f.name] ?? ''}
            prefix={i === at ? '› ' : '  '}
            onChange={(v) => {
              typed.current = { ...typed.current, [f.name]: v };
              setValues(typed.current);
            }}
            onSubmit={(v) => submit(f.name, v)}
            onCancel={onCancel}
          />
        </Box>
      ))}
      {extra && (
        <Box marginTop={1}>
          <Text>{at === fields.length ? `${paint.fg('accent', '› ')}${paint.bold(extra.label)}` : `  ${paint.fg('muted', extra.label)}`}</Text>
        </Box>
      )}
    </Box>
  );
}

export interface ListItem<T> {
  value: T;
  label: string;
  /** Muted, after the label on the same line. */
  aside?: string;
  /** A heading row above it (not pickable). */
  group?: string;
  current?: boolean;
}

/**
 * A long list to pick from: typing filters it, ↑/↓ (and Page Up/Down) move, Enter picks, Esc clears the filter, then
 * cancels. Each row is one line, cut short rather than wrapped, and the list keeps the same height as it scrolls.
 */
export function FilterList<T>({ paint, items, rows = 10, active = true, initial, onPick, onCancel, empty = 'Nothing to show.' }: { paint: Paint; items: ListItem<T>[]; rows?: number; active?: boolean; initial?: T; onPick(value: T): void; onCancel?(): void; empty?: string }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<{ value: T } | null>(() => {
    const first = items.find((i) => (initial === undefined ? i.current : Object.is(i.value, initial))) ?? items[0];
    return first ? { value: first.value } : null;
  });
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return q ? items.filter((i) => `${i.label} ${i.aside ?? ''} ${i.group ?? ''}`.toLowerCase().includes(q)) : items;
  }, [items, query]);
  const indexOf = (p: { value: T } | null) => Math.max(0, p ? shown.findIndex((i) => Object.is(i.value, p.value)) : 0);
  const at = indexOf(picked);
  // Each step builds on the last one, so keys pressed faster than the screen redraws (a held arrow) all count.
  const move = (delta: number, wrap = true) =>
    setPicked((prev) => {
      if (!shown.length) return prev;
      const from = indexOf(prev);
      const to = wrap ? (from + delta + shown.length) % shown.length : Math.min(shown.length - 1, Math.max(0, from + delta));
      return { value: shown[to]!.value };
    });
  useInput(
    (input, key) => {
      if (key.escape) return query ? setQuery('') : onCancel?.();
      if (key.return) return shown[at] && onPick(shown[at]!.value);
      if (key.upArrow || (key.ctrl && input === 'p')) return move(-1);
      if (key.downArrow || (key.ctrl && input === 'n')) return move(1);
      if (key.pageUp) return move(-rows, false);
      if (key.pageDown) return move(rows, false);
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) return;
      if (input && input >= ' ') setQuery((q) => q + input);
    },
    { isActive: active },
  );
  // The rows as lines, group headings included; the window keeps the cursor's line in view.
  const lines: { text: string; item?: number }[] = [];
  let group: string | undefined;
  shown.forEach((item, i) => {
    if (item.group && item.group !== group) lines.push({ text: paint.fg('muted', item.group) });
    group = item.group;
    const on = i === at;
    lines.push({ item: i, text: `${on ? paint.fg('accent', '› ') : '  '}${on ? paint.bold(item.label) : item.label}${item.current ? paint.fg('accent', ' ✓') : ''}${item.aside ? paint.fg('muted', `  ${item.aside}`) : ''}` });
  });
  const cursor = lines.findIndex((l) => l.item === at);
  const height = Math.min(rows, Math.max(lines.length, 1));
  let start = Math.max(0, Math.min(cursor - Math.floor(height / 2), lines.length - height));
  // A group's first row shows with its heading.
  if (start > 0 && lines[start]?.item !== undefined && lines[start - 1]?.item === undefined && start === cursor) start -= 1;
  const window = lines.slice(start, start + height);
  const more = lines.length > height;
  return (
    <Box flexDirection="column">
      <Text>{query ? `${paint.fg('accent', '/')} ${query}` : paint.fg('faint', 'type to filter')}</Text>
      {shown.length === 0 && <Text>{paint.fg('muted', empty)}</Text>}
      {window.map((l, i) => (
        <Text key={start + i} wrap="truncate-end">
          {l.text}
        </Text>
      ))}
      {Array.from({ length: Math.max(0, height - window.length) }, (_, i) => (
        <Text key={`pad${i}`}> </Text>
      ))}
      {more && <Text>{paint.fg('faint', `${at + 1} of ${shown.length}${start > 0 ? ' · ↑ more' : ''}${start + height < lines.length ? ' · ↓ more' : ''}`)}</Text>}
    </Box>
  );
}

/** A rounded box with a title in the accent (or the warning colour). */
export function Panel({ paint, title, tone = 'accent', children, width }: { paint: Paint; title?: string; tone?: 'accent' | 'warn' | 'bad' | 'info'; children: React.ReactNode; width?: number }) {
  const colour = paint.p[tone];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={paint.p.depth ? colour : undefined} paddingX={1} marginBottom={1} {...(width ? { width } : {})}>
      {title && <Text>{paint.bold(paint.hex(colour, title))}</Text>}
      {children}
    </Box>
  );
}
