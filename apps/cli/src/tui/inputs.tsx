/**
 * Small input pieces shared by the prompts, pickers and the setup wizard: a one-line text field (hidden for keys and
 * passwords) and a list of choices with a cursor, numbers and a line of explanation each.
 */
import { Box, Text, useInput, usePaste } from 'ink';
import { useState } from 'react';
import type { Paint } from '../style.ts';
import * as ed from './editor.ts';

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
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
  const update = (next: ed.EditorState) => {
    set(next);
    if (next.text !== s.text) onChange?.(next.text);
  };
  usePaste((text) => update(ed.insert(s, text.replace(/\r?\n/g, mask ? '' : ' '))), { isActive: active });
  useInput(
    (input, key) => {
      if (key.return) return onSubmit(s.text);
      if (key.escape) return onCancel?.();
      if (key.backspace || (key.ctrl && input === 'h')) return update(ed.backspace(s));
      if (key.delete) return update(ed.del(s));
      if (key.leftArrow) return update(key.ctrl || key.meta ? ed.wordLeft(s) : ed.left(s));
      if (key.rightArrow) return update(key.ctrl || key.meta ? ed.wordRight(s) : ed.right(s));
      if (key.home || (key.ctrl && input === 'a')) return update(ed.home(s));
      if (key.end || (key.ctrl && input === 'e')) return update(ed.end(s));
      if (key.ctrl && input === 'u') return update(ed.killToStart(s));
      if (key.ctrl && input === 'k') return update(ed.killToEnd(s));
      if (key.ctrl && input === 'w') return update(ed.killWordBack(s));
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
      if (input) update(ed.insert(s, input));
    },
    { isActive: active },
  );
  const shown = mask ? '•'.repeat([...s.text].length) : s.text;
  const body = s.text ? withCursor(shown, mask ? [...s.text.slice(0, s.cursor)].length : s.cursor, paint, active) : `${withCursor('', 0, paint, active)}${paint.fg('faint', placeholder)}`;
  return <Text>{`${paint.fg('accent', prefix)}${body}`}</Text>;
}

/**
 * Choices with ↑/↓ (or 1–9) and Enter; Esc cancels. The picked row has the accent's › and its hint shows beneath it.
 */
export function Choices<T>({ paint, choices, active = true, onPick, onCancel, initial = 0, onMove, numbered = true, showHints = 'focused' }: { paint: Paint; choices: Choice<T>[]; active?: boolean; onPick(value: T, index: number): void; onCancel?(): void; initial?: number; onMove?(index: number): void; numbered?: boolean; showHints?: 'focused' | 'all' | 'none' }) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initial), choices.length - 1));
  const move = (to: number) => {
    let next = to;
    for (let tries = 0; tries < choices.length && choices[(next + choices.length) % choices.length]?.disabled; tries++) next += to > index ? 1 : -1;
    const i = (next + choices.length) % choices.length;
    setIndex(i);
    onMove?.(i);
  };
  useInput(
    (input, key) => {
      if (key.upArrow || (key.ctrl && input === 'p')) return move(index - 1);
      if (key.downArrow || (key.ctrl && input === 'n') || key.tab) return move(index + 1);
      if (key.escape) return onCancel?.();
      if (key.return) {
        const c = choices[index];
        if (c && !c.disabled) onPick(c.value, index);
        return;
      }
      const n = Number(input);
      if (numbered && n >= 1 && n <= Math.min(9, choices.length) && !choices[n - 1]?.disabled) {
        setIndex(n - 1);
        onPick(choices[n - 1]!.value, n - 1);
      }
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      {choices.map((c, i) => {
        const on = i === index;
        const mark = on ? paint.fg('accent', '› ') : '  ';
        const number = numbered ? paint.fg('muted', `${i + 1}. `) : '';
        const label = c.disabled ? paint.fg('faint', c.label) : on ? paint.bold(c.label) : c.label;
        const hint = c.hint && (showHints === 'all' || (showHints === 'focused' && on)) ? `\n${' '.repeat(numbered ? 5 : 2)}${paint.fg('muted', c.hint)}` : '';
        return <Text key={i}>{`${mark}${number}${label}${hint}`}</Text>;
      })}
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
