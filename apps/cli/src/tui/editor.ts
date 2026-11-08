/**
 * The message box's text and cursor, as plain operations: typing, moving by character, word and line, deleting,
 * killing and yanking (as in a shell), and undo. Pure, so the keys can be tested without a terminal.
 */
export interface EditorState {
  text: string;
  cursor: number;
  /** The last killed text (Ctrl+K, Ctrl+U, Ctrl+W), for Ctrl+Y. */
  killed: string;
  undo: { text: string; cursor: number }[];
}

export const emptyEditor = (text = ''): EditorState => ({ text, cursor: text.length, killed: '', undo: [] });

const save = (s: EditorState): EditorState['undo'] => [...s.undo.slice(-99), { text: s.text, cursor: s.cursor }];

export function insert(s: EditorState, chars: string): EditorState {
  const text = s.text.slice(0, s.cursor) + chars + s.text.slice(s.cursor);
  return { ...s, text, cursor: s.cursor + chars.length, undo: save(s) };
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const prev = previousGrapheme(s.text, s.cursor);
  return { ...s, text: s.text.slice(0, prev) + s.text.slice(s.cursor), cursor: prev, undo: save(s) };
}

export function del(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  const next = nextGrapheme(s.text, s.cursor);
  return { ...s, text: s.text.slice(0, s.cursor) + s.text.slice(next), undo: save(s) };
}

export const left = (s: EditorState): EditorState => ({ ...s, cursor: previousGrapheme(s.text, s.cursor) });
export const right = (s: EditorState): EditorState => ({ ...s, cursor: nextGrapheme(s.text, s.cursor) });

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const i = text.indexOf('\n', at);
  return i === -1 ? text.length : i;
};

export const home = (s: EditorState): EditorState => ({ ...s, cursor: lineStart(s.text, s.cursor) });
export const end = (s: EditorState): EditorState => ({ ...s, cursor: lineEnd(s.text, s.cursor) });

/** Up a line, keeping the column; null at the first line (the caller goes back in history instead). */
export function up(s: EditorState): EditorState | null {
  const start = lineStart(s.text, s.cursor);
  if (start === 0) return null;
  const column = s.cursor - start;
  const prevStart = lineStart(s.text, start - 1);
  return { ...s, cursor: Math.min(prevStart + column, start - 1) };
}

export function down(s: EditorState): EditorState | null {
  const endOf = lineEnd(s.text, s.cursor);
  if (endOf === s.text.length) return null;
  const column = s.cursor - lineStart(s.text, s.cursor);
  const nextStart = endOf + 1;
  return { ...s, cursor: Math.min(nextStart + column, lineEnd(s.text, nextStart)) };
}

const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

export function wordLeft(s: EditorState): EditorState {
  let i = s.cursor;
  while (i > 0 && !isWord(s.text[i - 1])) i--;
  while (i > 0 && isWord(s.text[i - 1])) i--;
  return { ...s, cursor: i };
}

export function wordRight(s: EditorState): EditorState {
  let i = s.cursor;
  while (i < s.text.length && !isWord(s.text[i])) i++;
  while (i < s.text.length && isWord(s.text[i])) i++;
  return { ...s, cursor: i };
}

/** Ctrl+W, Alt+Backspace: the word before the cursor. */
export function killWordBack(s: EditorState): EditorState {
  const to = wordLeft(s).cursor;
  if (to === s.cursor) return s;
  return { ...s, text: s.text.slice(0, to) + s.text.slice(s.cursor), cursor: to, killed: s.text.slice(to, s.cursor), undo: save(s) };
}

/** Ctrl+K: to the end of the line (the line break when already there). */
export function killToEnd(s: EditorState): EditorState {
  const to = lineEnd(s.text, s.cursor);
  const stop = to === s.cursor && to < s.text.length ? to + 1 : to;
  if (stop === s.cursor) return s;
  return { ...s, text: s.text.slice(0, s.cursor) + s.text.slice(stop), killed: s.text.slice(s.cursor, stop), undo: save(s) };
}

/** Ctrl+U: to the start of the line. */
export function killToStart(s: EditorState): EditorState {
  const from = lineStart(s.text, s.cursor);
  if (from === s.cursor) return s;
  return { ...s, text: s.text.slice(0, from) + s.text.slice(s.cursor), cursor: from, killed: s.text.slice(from, s.cursor), undo: save(s) };
}

export const yank = (s: EditorState): EditorState => (s.killed ? insert(s, s.killed) : s);

export function undo(s: EditorState): EditorState {
  const last = s.undo.at(-1);
  return last ? { ...s, text: last.text, cursor: last.cursor, undo: s.undo.slice(0, -1) } : s;
}

export const replace = (s: EditorState, text: string): EditorState => ({ ...s, text, cursor: text.length, undo: save(s) });

/** The cursor's line and column, for drawing it. */
export function position(s: EditorState): { line: number; column: number } {
  const before = s.text.slice(0, s.cursor);
  const line = before.split('\n').length - 1;
  return { line, column: s.cursor - lineStart(s.text, s.cursor) };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function previousGrapheme(text: string, at: number): number {
  if (at <= 0) return 0;
  let last = 0;
  for (const { index } of segmenter.segment(text.slice(Math.max(0, at - 16), at))) last = index;
  return Math.max(0, at - 16) + last;
}
function nextGrapheme(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const first = segmenter.segment(text.slice(at, at + 16))[Symbol.iterator]().next().value;
  return at + (first?.segment.length ?? 1);
}
