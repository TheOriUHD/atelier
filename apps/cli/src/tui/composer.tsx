/**
 * The message box (ARCHITECTURE §25): multi-line text with a cursor, between two rules like Claude Code's. Enter sends;
 * Shift+Enter, Alt+Enter, Ctrl+J or a `\` before Enter make a new line. `/` opens the commands, `@` finds a file here,
 * `!` runs a shell command. ↑/↓ go through what was sent before (from the first or last line). A long paste becomes a
 * chip ("[Pasted text #1 +120 lines]") that is put back in full when sent; a pasted path to an image attaches it.
 */
import { Box, Text, useInput, usePaste } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { Paint } from '../style.ts';
import * as ed from './editor.ts';
import { withCursor } from './inputs.tsx';

export interface SlashItem {
  name: string;
  description: string;
  argumentHint?: string;
}

export type ComposerKey = 'escape' | 'shift-tab' | 'ctrl-c' | 'ctrl-d' | 'ctrl-o' | 'ctrl-t' | 'ctrl-l' | 'ctrl-g' | 'ctrl-v' | 'ctrl-r' | 'down-empty' | 'ctrl-b';

export interface ComposerProps {
  paint: Paint;
  columns: number;
  active: boolean;
  placeholder: string;
  commands: SlashItem[];
  findFiles(query: string): Promise<string[]>;
  history: readonly string[];
  suggestion: string | null;
  attachments: string[];
  onSubmit(text: string, how: 'send' | 'join'): void;
  onShell(command: string): void;
  onKey(key: ComposerKey, empty: boolean): void;
  onAttachPath(path: string): boolean;
  /** Text the app puts in (a queued message taken back, the editor's result); a new object each time. */
  inject?: { text: string } | null;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** Fuzzy enough: a prefix first, then the letters in order. */
export function filterSlash(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  const prefix = items.filter((i) => i.name.toLowerCase().startsWith(q));
  const loose = items.filter((i) => !prefix.includes(i) && (i.name.toLowerCase().includes(q) || isSubsequence(q, i.name.toLowerCase())));
  return [...prefix, ...loose];
}
const isSubsequence = (q: string, s: string) => {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
};

/** The `@word` at the cursor, if any: where it starts and what is typed so far. */
export function mentionAt(text: string, cursor: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  return m ? { start: cursor - m[2]!.length - 1, query: m[2]! } : null;
}

export function Composer(props: ComposerProps) {
  const { paint, columns, active } = props;
  const [s, setS] = useState(() => ed.emptyEditor());
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const pastes = useRef(new Map<number, string>());
  const nextPaste = useRef(1);
  const lastQuery = useRef<string | null>(null);

  // Text put in from outside replaces what is typed, once per new object (derived state, set while rendering).
  const [injected, setInjected] = useState(props.inject);
  if (props.inject !== injected) {
    setInjected(props.inject);
    if (props.inject) setS(ed.replace(s, props.inject.text));
  }

  const slashQuery = /^\/([^\s]*)$/.exec(s.text.slice(0, s.cursor)) && s.cursor === s.text.length ? s.text.slice(1) : null;
  const slash = slashQuery !== null ? filterSlash(props.commands, slashQuery).slice(0, 8) : [];
  const mention = slashQuery === null ? mentionAt(s.text, s.cursor) : null;

  useEffect(() => {
    if (!mention) return void (lastQuery.current = null);
    if (lastQuery.current === mention.query) return;
    lastQuery.current = mention.query;
    const q = mention.query;
    const timer = setTimeout(() => {
      props
        .findFiles(q)
        .then((found) => lastQuery.current === q && (setFiles(found.slice(0, 8)), setMenuIndex(0)))
        .catch(() => setFiles([]));
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mention?.query]);

  const menu: { label: string; hint: string; apply(): ed.EditorState }[] = slash.length
    ? slash.map((c) => ({ label: `/${c.name}`, hint: c.argumentHint ? `${c.argumentHint}  ${c.description}` : c.description, apply: () => ed.replace(s, `/${c.name} `) }))
    : mention && files.length
      ? files.map((f) => ({ label: f, hint: '', apply: () => ({ ...ed.insert({ ...s, text: s.text.slice(0, mention.start) + s.text.slice(s.cursor), cursor: mention.start }, `@${f} `) }) }))
      : [];

  const expand = (text: string) => text.replace(/\[Pasted text #(\d+) \+\d+ lines?\]/g, (all, n: string) => pastes.current.get(Number(n)) ?? all);

  const submit = (how: 'send' | 'join') => {
    const text = expand(s.text).trim();
    if (!text && !props.attachments.length) return;
    setS(ed.emptyEditor());
    setHistoryAt(null);
    pastes.current.clear();
    if (text.startsWith('!') && text.length > 1) props.onShell(text.slice(1).trim());
    else props.onSubmit(text, how);
  };

  usePaste(
    (text) => {
      const clean = text.replace(/\r\n?/g, '\n');
      const path = clean.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
      if (IMAGE.test(path) && !path.includes('\n') && props.onAttachPath(path)) return;
      const lines = clean.split('\n').length;
      if (clean.length > 800 || lines > 12) {
        const n = nextPaste.current++;
        pastes.current.set(n, clean);
        setS(ed.insert(s, `[Pasted text #${n} +${lines} ${lines === 1 ? 'line' : 'lines'}]`));
      } else setS(ed.insert(s, clean));
    },
    { isActive: active },
  );

  useInput(
    (input, key) => {
      // Focus reports (`ESC [ I` / `ESC [ O`) are the app's business, not text.
      if (input === '[I' || input === '[O') return;
      const empty = s.text.length === 0;
      if (menu.length) {
        if (key.upArrow) return setMenuIndex((menuIndex - 1 + menu.length) % menu.length);
        if (key.downArrow) return setMenuIndex((menuIndex + 1) % menu.length);
        if (key.tab || (key.return && mention)) return setS(menu[Math.min(menuIndex, menu.length - 1)]!.apply());
        if (key.escape) return setS(ed.insert(s, ' '));
        if (key.return && slash.length) {
          const pick = slash[Math.min(menuIndex, slash.length - 1)]!;
          // A command picked from the menu runs at once unless it takes arguments.
          if (pick.argumentHint) return setS(ed.replace(s, `/${pick.name} `));
          setS(ed.emptyEditor());
          return props.onSubmit(`/${pick.name}`, 'send');
        }
      }
      if (key.return) {
        if (key.shift || key.meta) return setS(ed.insert(s, '\n'));
        if (s.text[s.cursor - 1] === '\\' && s.cursor === s.text.length) return setS(ed.insert(ed.backspace(s), '\n'));
        return submit('send');
      }
      if (key.ctrl && input === 'j') return setS(ed.insert(s, '\n'));
      if (key.ctrl && input === 's') return submit('join');
      if (key.tab && key.shift) return props.onKey('shift-tab', empty);
      if (key.tab) {
        if (empty && props.suggestion) return setS(ed.replace(s, props.suggestion));
        return;
      }
      if (key.escape) return props.onKey('escape', empty);
      if (key.ctrl && input === 'c') {
        if (!empty) return setS(ed.emptyEditor());
        return props.onKey('ctrl-c', empty);
      }
      if (key.ctrl && input === 'd') return empty ? props.onKey('ctrl-d', true) : setS(ed.del(s));
      if (key.ctrl && 'otlgvrb'.includes(input) && input) return props.onKey(`ctrl-${input}` as ComposerKey, empty);
      if (key.ctrl && input === 'z') return setS(ed.undo(s));
      if (key.ctrl && input === '_') return setS(ed.undo(s));
      if (key.upArrow) {
        const moved = ed.up(s);
        if (moved) return setS(moved);
        if (!props.history.length) return;
        const at = historyAt === null ? props.history.length - 1 : Math.max(0, historyAt - 1);
        if (historyAt === null) setDraft(s.text);
        setHistoryAt(at);
        return setS(ed.replace(s, props.history[at]!));
      }
      if (key.downArrow) {
        const moved = ed.down(s);
        if (moved) return setS(moved);
        if (historyAt === null) return empty ? props.onKey('down-empty', true) : undefined;
        const at = historyAt + 1;
        if (at >= props.history.length) {
          setHistoryAt(null);
          return setS(ed.replace(s, draft));
        }
        setHistoryAt(at);
        return setS(ed.replace(s, props.history[at]!));
      }
      if (key.backspace || (key.ctrl && input === 'h')) return setS(key.meta ? ed.killWordBack(s) : ed.backspace(s));
      if (key.delete) return setS(ed.del(s));
      if (key.leftArrow) return setS(key.ctrl || key.meta ? ed.wordLeft(s) : ed.left(s));
      if (key.rightArrow) {
        if (s.cursor === s.text.length && empty && props.suggestion) return setS(ed.replace(s, props.suggestion));
        return setS(key.ctrl || key.meta ? ed.wordRight(s) : ed.right(s));
      }
      if (key.home || (key.ctrl && input === 'a')) return setS(ed.home(s));
      if (key.end || (key.ctrl && input === 'e')) return setS(ed.end(s));
      if (key.ctrl && input === 'u') return setS(ed.killToStart(s));
      if (key.ctrl && input === 'k') return setS(ed.killToEnd(s));
      if (key.ctrl && input === 'w') return setS(ed.killWordBack(s));
      if (key.ctrl && input === 'y') return setS(ed.yank(s));
      if (key.meta && input === 'b') return setS(ed.wordLeft(s));
      if (key.meta && input === 'f') return setS(ed.wordRight(s));
      if (key.ctrl || key.meta) return;
      if (input) {
        setMenuIndex(0);
        setS(ed.insert(s, input));
      }
    },
    { isActive: active },
  );

  const shell = s.text.startsWith('!');
  const rule = paint.fg(shell ? 'warn' : 'faint', '─'.repeat(Math.max(10, columns)));
  const prompt = shell ? paint.fg('warn', '! ') : paint.fg('accent', '❯ ');
  const placeholder = props.suggestion ? paint.fg('faint', `${props.suggestion}  (tab)`) : paint.fg('faint', props.placeholder);
  const body = s.text ? withCursor(s.text, s.cursor, paint, active) : `${withCursor('', 0, paint, active)}${placeholder}`;
  const lines = body.split('\n');
  return (
    <Box flexDirection="column">
      {props.attachments.length > 0 && <Text>{paint.fg('muted', `  ${props.attachments.map((a) => `[${a}]`).join(' ')}  ctrl+u clears`)}</Text>}
      <Text>{rule}</Text>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{prompt}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text>{lines.join('\n')}</Text>
        </Box>
      </Box>
      <Text>{rule}</Text>
      {menu.length > 0 && (
        <Box flexDirection="column">
          {menu.map((m, i) => {
            const on = i === Math.min(menuIndex, menu.length - 1);
            return <Text key={m.label}>{`${on ? paint.fg('accent', '› ') : '  '}${on ? paint.bold(m.label) : paint.fg('secondary', m.label)}${m.hint ? paint.fg('muted', `  ${m.hint}`) : ''}`}</Text>;
          })}
        </Box>
      )}
    </Box>
  );
}
