/**
 * Just enough shell lexing for permission checks: split a command line into the simple commands that a
 * rule has to approve one by one, and spot constructs whose effect can't be judged from the text.
 */

export interface SplitCommand {
  /**
   * Every command the line runs, for deny and ask rules and the dangerous-command check: the simple commands joined
   * by `&&`, `||`, `;`, `|`, `&` or newlines, trimmed, in order, each followed by the commands it runs itself
   * (`find -exec`, `xargs`, `sh -c`, `env -S`, wrappers such as `time`, `timeout` or `sudo`, a command behind
   * `if`/`then`/`do` or in `( … )`/`{ …; }`, and the command without leading `VAR=value`).
   */
  parts: string[];
  /**
   * What allow rules must cover, one entry per command, any form of which may be allowed: a simple command, or behind
   * a wrapper that only changes how it runs (`time`, `nice`, `nohup`, `timeout`, `command`, `exec`, a reserved word or
   * a group) also the command itself. Commands another program runs as its data (`find -exec`, `xargs`, `sh -c`,
   * `env -S`, `sudo`) are entries of their own, so allowing `find` doesn't allow what its `-exec` runs.
   */
  allow: string[][];
  /** Why the command can't be approved by rules alone (substitution, eval, unbalanced quotes), or null. */
  opaque: string | null;
}

const OPAQUE_WORDS = new Set(['eval', 'source', '.']);

/** The index of the `)` closing a substitution whose body starts at `from`, past nested parentheses and quotes; -1 if none. */
function closingParen(command: string, from: number): number {
  let depth = 1;
  for (let j = from; j < command.length; j++) {
    const c = command[j]!;
    if (c === '\\') j++;
    else if (c === "'") {
      j = command.indexOf("'", j + 1);
      if (j < 0) return -1;
    } else if (c === '"') {
      for (j++; j < command.length && command[j] !== '"'; j++) if (command[j] === '\\') j++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

/** The index of the backquote closing a substitution whose body starts at `from`; -1 if none. */
function closingBackquote(command: string, from: number): number {
  for (let j = from; j < command.length; j++) {
    if (command[j] === '\\') j++;
    else if (command[j] === '`') return j;
  }
  return -1;
}

/**
 * Simple commands of one line, before looking inside them: `piped[i]` when part i reads the output of the one before
 * (`|`), `bodies` the commands in `$(…)`, backquotes and `<(…)`/`>(…)`, which run too; `opaque` for substitutions.
 */
function simpleCommands(command: string): {
  parts: string[];
  piped: boolean[];
  bodies: string[];
  opaque: string | null;
} {
  const parts: string[] = [];
  const piped: boolean[] = [];
  const bodies: string[] = [];
  let current = '';
  let quote: "'" | '"' | '$' | null = null;
  let opaque: string | null = null;
  let fromPipe = false;
  const flush = (pipeNext = false) => {
    const part = current.trim();
    if (part) {
      parts.push(part);
      piped.push(fromPipe);
    }
    current = '';
    fromPipe = pipeNext;
  };
  /** A substitution starting at `i` (its opener `open` characters long): kept in the part, its body noted. Returns the last index used. */
  const substitution = (i: number, open: number, kind: string): number => {
    opaque ??= kind;
    const close = command[i] === '`' ? closingBackquote(command, i + 1) : closingParen(command, i + open);
    if (close < 0) {
      current += command.slice(i);
      return command.length;
    }
    bodies.push(command.slice(i + open, close));
    current += command.slice(i, close + 1);
    return close;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      current += c;
      if (c === "'") quote = null;
      continue;
    }
    // `$'…'` (ANSI-C quoting) ends at a quote its backslash doesn't escape.
    if (quote === '$') {
      if (c === '\\') {
        current += c + (next ?? '');
        i++;
      } else {
        current += c;
        if (c === "'") quote = null;
      }
      continue;
    }
    if (c === '\\') {
      current += c + (next ?? '');
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '$' && next === '(') i = substitution(i, 2, 'command substitution');
      else if (c === '`') i = substitution(i, 1, 'command substitution');
      else {
        if (c === '"') quote = null;
        current += c;
      }
      continue;
    }
    if (c === '$' && next === "'") {
      quote = '$';
      current += "$'";
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === '$' && next === '(') {
      i = substitution(i, 2, 'command substitution');
      continue;
    }
    if (c === '`') {
      i = substitution(i, 1, 'command substitution');
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') {
      i = substitution(i, 2, 'process substitution');
      continue;
    }
    if (c === '#' && (current === '' || /\s$/.test(current))) {
      // Comment to end of line.
      while (i < command.length && command[i] !== '\n') i++;
      flush();
      continue;
    }
    if (c === ';' || c === '\n') {
      flush();
      continue;
    }
    if (c === '&' || c === '|') {
      // `&&`, `||`, `|`, `&` all separate commands; `>&`/`2>&1` redirections do not.
      if (c === '&' && /[<>]$/.test(current)) {
        current += c;
        continue;
      }
      const pipe = c === '|' && next !== '|';
      if (next === c || (c === '|' && next === '&')) i++;
      flush(pipe);
      continue;
    }
    current += c;
  }
  flush();
  return { parts, piped, bodies, opaque };
}

export function splitCommand(command: string): SplitCommand {
  const top = simpleCommands(command);
  let opaque = top.opaque;
  const parts: string[] = [];
  const allow: string[][] = [];
  // Variables set by earlier commands of the line (`x=rm; $x -rf build`), for deny to see what such a command runs.
  const vars = new Map<string, string>();
  top.parts.forEach((part, k) => {
    const word = commandWord(part);
    if (word && OPAQUE_WORDS.has(word)) opaque ??= `\`${word}\` runs code that can't be checked in advance`;
    const inner = insideCommand(part);
    opaque ??= inner.opaque;
    if (inner.closer) return;
    parts.push(part, ...inner.parts);
    allow.push([part, ...inner.same], ...inner.separate);
    const lexed = words(part);
    if (lexed.length > 0 && lexed.every((w) => ASSIGNMENT.test(w))) {
      for (const w of lexed) vars.set(w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1));
    } else if (vars.size > 0) {
      const known = part.replace(
        /\$\{(\w+)\}|\$(\w+)/g,
        (all, braced: string | undefined, plain: string | undefined) => vars.get(braced ?? plain ?? '') ?? all,
      );
      if (known !== part) parts.push(...splitCommand(known).parts);
    }
    // `echo 'rm -rf build' | sh`: a shell reading its input runs what echo or printf print (deny sees it).
    const prev = k > 0 && top.piped[k] ? words(top.parts[k - 1]!) : [];
    if (readsScriptFromInput(part) && (prev[0] === 'echo' || prev[0] === 'printf')) {
      parts.push(
        ...splitCommand(
          prev
            .slice(1)
            .filter((w) => !/^-[neE]+$/.test(w))
            .join(' '),
        ).parts,
      );
    }
  });
  // What runs inside `$(…)`, backquotes and process substitutions (the line stays opaque).
  for (const body of top.bodies) parts.push(...splitCommand(body).parts);
  for (const part of parts) {
    const word = commandWord(part);
    if (word && OPAQUE_WORDS.has(word)) opaque ??= `\`${word}\` runs code that can't be checked in advance`;
  }
  return { parts, allow, opaque };
}

/** Wrappers that run a command after their options; `valued` options take a value, `positional` words precede the command. */
interface Wrapper {
  valued: string[];
  positional?: number;
  /** It only changes how the command runs, so an allow rule for the command covers it as well. */
  transparent: boolean;
}

const WRAPPERS: Record<string, Wrapper> = {
  env: { valued: ['-u', '-C', '--unset', '--chdir'], transparent: false },
  nohup: { valued: [], transparent: true },
  nice: { valued: ['-n', '--adjustment'], transparent: true },
  timeout: { valued: ['-k', '-s', '--kill-after', '--signal'], positional: 1, transparent: true },
  time: { valued: ['-f', '-o', '--format', '--output'], transparent: true },
  command: { valued: [], transparent: true },
  exec: { valued: ['-a'], transparent: true },
  stdbuf: { valued: ['-i', '-o', '-e'], transparent: true },
  ionice: { valued: ['-c', '-n', '-p', '--class', '--classdata'], transparent: true },
  setsid: { valued: [], transparent: true },
  sudo: { valued: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'], transparent: false },
  doas: { valued: ['-u', '-C'], transparent: false },
  xargs: { valued: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a'], transparent: false },
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** Words that start a compound command's part (`then rm …`); the command follows them. */
const LEADING_RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(']);
/** Words that only close a compound command. */
const CLOSERS = new Set(['fi', 'done', 'esac', '}', ')', 'then', 'else', 'do']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECTION = /^(?:\d*[<>]|&>)/;

interface Inside {
  /** Every command it runs, at any depth, for deny and ask rules. */
  parts: string[];
  /** Forms an allow rule may match instead of the part itself. */
  same: string[];
  /** Commands run as data, each needing its own allow (with their own alternatives). */
  separate: string[][];
  opaque: string | null;
  /** The part only closes a compound command (`fi`, `done`, `}`): nothing to judge. */
  closer?: boolean;
}

/**
 * The commands a simple command runs on its own, found in its words: a command behind reserved words, grouping or
 * `VAR=value`, what follows a wrapper's options, a shell's `-c` script and `env -S`'s string (split again), and each
 * `find -exec … ;`. Without them `find . -exec rm -rf {} +`, `env rm -rf x` or `if …; then rm …; fi` would slip past
 * a `Bash(rm *)` deny rule.
 */
function insideCommand(part: string): Inside {
  const { words: all, expands, broken } = lex(part);
  const out: Inside = {
    parts: [],
    same: [],
    separate: [],
    opaque: broken ? 'quotes, escapes or braces that can’t be read reliably' : null,
  };
  if (all.length > 0 && all.every((w) => CLOSERS.has(w))) return { ...out, closer: true };
  // The command as bash reads it (`r''m`, `"rm"`, `\rm`, `$'\x72m'`, `{rm,-rf,build}` are all `rm …`): deny and the
  // dangerous-command check see it, and an allow rule may match it.
  const resolved = shellJoin(all);
  if (all.length > 0 && resolved !== part.trim()) {
    out.parts.push(resolved);
    out.same.push(resolved);
  }
  if (all[0] === 'case') {
    out.opaque ??= 'a case statement';
    return out;
  }

  // Another form of the same command: deny always sees it; with `enough` (behind a reserved word, a group or a pure
  // wrapper) an allow rule for it covers the part too, while what it runs as data still needs its own.
  const same = (command: string, enough: boolean) => {
    const text = command.trim();
    if (!text || text === part.trim()) return;
    const split = splitCommand(text);
    out.parts.push(...split.parts);
    out.opaque ??= split.opaque;
    if (!enough) return;
    const [first, ...rest] = split.allow;
    if (first) out.same.push(...first);
    out.separate.push(...rest);
  };
  // A command another program runs as data: deny sees it, and allow needs it on its own.
  const separate = (command: string) => {
    const text = command.trim();
    if (!text) return;
    const split = splitCommand(text);
    out.parts.push(...split.parts);
    out.separate.push(...split.allow);
    out.opaque ??= split.opaque;
  };

  // `f() { rm …; }`, `function f { rm …; }`: can't be judged (it runs when called), but deny sees the body.
  if (all[0] === 'function' || /^[^\s()]+\(\)/.test(all[0] ?? '') || all[1]?.startsWith('()')) {
    out.opaque ??= 'a function definition';
    const open = all.findIndex((w) => /[{(]$/.test(w) && !/^[^\s()]+\(\)$/.test(w) && w !== '()');
    if (open >= 0) same(shellJoin(all.slice(open + 1)), false);
    return out;
  }

  // `( rm … )`, `{ rm …; }`, `then rm …`, `! rm …`: the command after the reserved words and brackets.
  let words = all;
  let k = 0;
  let grouped = false;
  while (k < words.length && (LEADING_RESERVED.has(words[k]!) || words[k]!.startsWith('('))) {
    grouped ||= words[k]!.startsWith('(');
    if (/^\(+./.test(words[k]!)) words = [...words.slice(0, k), words[k]!.replace(/^\(+/, ''), ...words.slice(k + 1)];
    else k++;
  }
  if (grouped && /\)$/.test(words.at(-1) ?? ''))
    words = [...words.slice(0, -1), words.at(-1)!.replace(/\)+$/, '')].filter(Boolean);
  if (k > 0 || words !== all) {
    same(shellJoin(words.slice(k)), true);
    return out;
  }

  const start = words.findIndex((w) => !ASSIGNMENT.test(w));
  if (start < 0) return out;
  // `FOO=1 rm …`: deny sees `rm …`; allow needs the whole part, since a variable can change what a command does.
  if (start > 0) same(shellJoin(words.slice(start)), false);
  const cmd = words[start]!;
  const args = words.slice(start + 1);
  // `$x -rf build`, `${x}`, `$p$q`: what runs depends on a variable.
  if (expands[start]) {
    out.opaque ??= 'a command name that comes from a variable';
    return out;
  }
  // `/bin/rm`, `./rm`: deny and the dangerous-command check also see the program by its name (allow needs the path).
  if (cmd.includes('/')) {
    const name = cmd.slice(cmd.lastIndexOf('/') + 1);
    if (name) same(shellJoin([name, ...args]), false);
    return out;
  }
  // `git -c core.sshCommand=… push`: deny also sees it without git's own options (never allow, which needs them).
  if (cmd === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if (sub !== undefined && sub !== args[0]) same(shellJoin(['git', sub, ...rest]), false);
    return out;
  }
  if (cmd === 'parallel') {
    out.opaque ??= 'GNU parallel, which builds the commands it runs';
    return out;
  }
  // `busybox rm …` runs its applet; `watch rm …` hands its words to `sh -c`.
  if (cmd === 'busybox') {
    if (args[0] && !args[0].startsWith('-')) separate(shellJoin(args));
    return out;
  }
  if (cmd === 'watch') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-'))
      i += ['-n', '--interval', '-q', '--equexit'].includes(args[i]!) ? 2 : 1;
    separate(args.slice(i).join(' '));
    return out;
  }
  const wrapper = WRAPPERS[cmd];
  if (wrapper) {
    // `command -v node` and `exec >log` run nothing.
    if (cmd === 'command' && args.some((a) => /^-[a-zA-Z]*[vV]/.test(a))) return out;
    let i = 0;
    while (i < args.length && (args[i]!.startsWith('-') || (cmd === 'env' && ASSIGNMENT.test(args[i]!)))) {
      const arg = args[i]!;
      // `env -S "rm -rf build"` runs its string as a command line.
      if (cmd === 'env' && (arg === '-S' || arg === '--split-string')) {
        separate(`${args[i + 1] ?? ''} ${shellJoin(args.slice(i + 2))}`);
        return out;
      }
      if (cmd === 'env' && (/^-S./.test(arg) || arg.startsWith('--split-string='))) {
        separate(`${arg.replace(/^-S|^--split-string=/, '')} ${shellJoin(args.slice(i + 1))}`);
        return out;
      }
      i += wrapper.valued.includes(arg) ? 2 : 1;
    }
    i += wrapper.positional ?? 0;
    if (cmd === 'exec' && REDIRECTION.test(args[i] ?? '')) return out;
    if (i < args.length) {
      const rest = shellJoin(args.slice(i));
      if (wrapper.transparent) same(rest, true);
      else if (cmd === 'env') same(rest, false);
      else separate(rest);
    }
  } else if (SHELLS.has(cmd)) {
    const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (flag >= 0 && args[flag + 1] !== undefined) separate(args[flag + 1]!);
    else if (readsScriptFromInput(part)) {
      // `sh <<<'rm -rf build'`: the here-string is the script; deny sees it, and a shell reading its input is opaque.
      out.opaque ??= 'a shell reading commands from its input';
      const here = args.findIndex((a) => a.startsWith('<<<'));
      if (here >= 0) same(args[here]!.length > 3 ? args[here]!.slice(3) : (args[here + 1] ?? ''), false);
    }
  } else if (cmd === 'eval') {
    // eval joins its words and runs them (it stays opaque).
    same(args.join(' '), false);
  } else if (cmd === 'find') {
    for (let i = 0; i < args.length; i++) {
      if (!FIND_EXEC.has(args[i]!)) continue;
      const end = args.findIndex((a, j) => j > i && (a === ';' || a === '+'));
      separate(shellJoin(args.slice(i + 1, end < 0 ? undefined : end)));
      if (end > i) i = end;
    }
  }
  return out;
}

/** A shell given no `-c` script and no script file, so it runs what it reads from its input. */
function readsScriptFromInput(part: string): boolean {
  const [cmd, ...args] = words(part);
  if (!cmd || !SHELLS.has(cmd.slice(cmd.lastIndexOf('/') + 1))) return false;
  if (args.some((a) => a.startsWith('<<<'))) return true;
  if (args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) return false;
  return args.every((a) => a.startsWith('-') || a.startsWith('+') || /^\d*[<>]/.test(a));
}

/** Words joined back into a command line, quoted where the shell would read them differently. */
function shellJoin(list: string[]): string {
  return list.map((w) => (/^[\w@%+=:,./{}*?~^-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`)).join(' ');
}

/** The program a simple command runs, skipping leading `VAR=value` assignments. */
export function commandWord(part: string): string | undefined {
  return words(part).find((w) => !ASSIGNMENT.test(w));
}

/** Whitespace-separated words as the shell reads them: quotes and escapes resolved, braces expanded (no other expansion). */
export function words(part: string): string[] {
  return lex(part).words;
}

/**
 * Where git's own options end and its subcommand starts: `git -c k=v -C dir --no-pager push …` runs `push`. Options
 * that take a value take the next word unless written `--name=value`.
 */
export function gitSubcommand(args: string[]): { sub: string | undefined; rest: string[] } {
  const valued = new Set([
    '-c',
    '-C',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--config-env',
    '--exec-path',
    '--super-prefix',
    '--list-cmds',
    '--attr-source',
  ]);
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const arg = args[i]!;
    if (arg === '--') {
      i++;
      break;
    }
    i += valued.has(arg) ? 2 : 1;
  }
  return { sub: args[i], rest: args.slice(i + 1) };
}

// Unquoted brace characters, kept apart from quoted ones until brace expansion has run.
const OPEN = '';
const COMMA = '';
const CLOSE = '';
const BRACES: Record<string, string> = { '{': OPEN, ',': COMMA, '}': CLOSE };
const PLAIN = (s: string) => s.replaceAll(OPEN, '{').replaceAll(COMMA, ',').replaceAll(CLOSE, '}');
/** More words than this from one word's braces: the command can't be judged word by word. */
const MAX_BRACE_WORDS = 256;

/** A word's brace expansions as bash makes them (`{a,b}c` → `ac bc`, nested lists, `{1..3}`, `{a..c}`), or null past the limit. */
function expandBraces(word: string): string[] | null {
  const results: string[] = [];
  const pending = [word];
  while (pending.length > 0) {
    const w = pending.pop()!;
    const found = firstBrace(w);
    if (found === 'too many') return null;
    if (!found) {
      results.push(w);
      if (results.length > MAX_BRACE_WORDS) return null;
      continue;
    }
    const { start, end, items } = found;
    for (const item of [...items].reverse()) pending.push(w.slice(0, start) + item + w.slice(end + 1));
    if (pending.length > MAX_BRACE_WORDS) return null;
  }
  return results;
}

/** The first expandable `{…}` in a word: its bounds and the words it stands for. */
function firstBrace(w: string): { start: number; end: number; items: string[] } | 'too many' | null {
  for (let start = w.indexOf(OPEN); start >= 0; start = w.indexOf(OPEN, start + 1)) {
    let depth = 0;
    const commas: number[] = [];
    for (let i = start; i < w.length; i++) {
      if (w[i] === OPEN) depth++;
      else if (w[i] === CLOSE && --depth === 0) {
        const inner = w.slice(start + 1, i);
        if (commas.length > 0) {
          const bounds = [start, ...commas, i];
          return { start, end: i, items: bounds.slice(0, -1).map((b, k) => w.slice(b + 1, bounds[k + 1])) };
        }
        const sequence = expandSequence(PLAIN(inner));
        if (sequence === 'too many') return sequence;
        if (sequence) return { start, end: i, items: sequence };
        break;
      } else if (w[i] === COMMA && depth === 1) commas.push(i);
    }
  }
  return null;
}

/** `1..5`, `5..1`, `1..9..2`, `a..e`: the words bash makes of a sequence expression. */
function expandSequence(inner: string): string[] | 'too many' | null {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  const letters = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
  const m = numeric ?? letters;
  if (!m) return null;
  const [from, to] = numeric ? [Number(m[1]), Number(m[2])] : [m[1]!.charCodeAt(0), m[2]!.charCodeAt(0)];
  const step = Math.abs(Number(m[3] ?? 1)) || 1;
  const count = Math.floor(Math.abs(to - from) / step) + 1;
  if (count > MAX_BRACE_WORDS) return 'too many';
  const out: string[] = [];
  for (let k = 0, v = from; k < count; k++, v += from <= to ? step : -step)
    out.push(numeric ? String(v) : String.fromCharCode(v));
  return out;
}

const ANSI_SIMPLE: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** The escape at `part[i]` (after the backslash) inside `$'…'`: its text and how many characters it used. */
function ansiEscape(part: string, i: number): { text: string; used: number } {
  const c = part[i]!;
  const hex = (max: number) => /^[0-9A-Fa-f]+/.exec(part.slice(i + 1, i + 1 + max))?.[0] ?? '';
  if (c in ANSI_SIMPLE) return { text: ANSI_SIMPLE[c]!, used: 1 };
  if (c === 'x') {
    const h = hex(2);
    return h ? { text: String.fromCharCode(parseInt(h, 16)), used: 1 + h.length } : { text: '\\x', used: 1 };
  }
  if (c === 'u' || c === 'U') {
    const h = hex(c === 'u' ? 4 : 8);
    const code = h ? parseInt(h, 16) : NaN;
    return h && code <= 0x10ffff
      ? { text: String.fromCodePoint(code), used: 1 + h.length }
      : { text: `\\${c}`, used: 1 };
  }
  if (/[0-7]/.test(c)) {
    const o = /^[0-7]{1,3}/.exec(part.slice(i, i + 3))![0];
    return { text: String.fromCharCode(parseInt(o, 8) & 0xff), used: o.length };
  }
  if (c === 'c' && i + 1 < part.length) return { text: String.fromCharCode(part.charCodeAt(i + 1) & 0x1f), used: 2 };
  // bash keeps an escape it doesn't know, backslash and all.
  return { text: `\\${c}`, used: 1 };
}

/** `$name`, `${…}`, `$1`, `$@` and the like: a parameter expansion starting at `part[i]` (a `$`). */
const EXPANSION = /^\$(?:[A-Za-z_]|\{|[0-9@*#?$!-])/;

/**
 * Words as the shell reads them: `'…'`, `"…"` (where a backslash escapes `"`, `\`, `$`, a backquote or a newline),
 * `$'…'` with every escape bash knows, `$"…"`, backslash escapes and line continuations, then brace expansion of the
 * unquoted braces. `expands[i]` says the word holds a parameter expansion (its text isn't what runs). `broken` when
 * quotes don't close, a backslash ends the text or braces make too many words.
 */
function lex(part: string): { words: string[]; expands: boolean[]; broken: boolean } {
  const raw: { text: string; expands: boolean }[] = [];
  let current = '';
  let expands = false;
  let inWord = false;
  let broken = false;
  const end = () => {
    if (inWord) raw.push({ text: current, expands });
    current = '';
    expands = false;
    inWord = false;
  };
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (c === '\\' && part[i + 1] === '\n') {
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      end();
      continue;
    }
    inWord = true;
    if (c === "'") {
      const close = part.indexOf("'", i + 1);
      if (close < 0) {
        broken = true;
        current += part.slice(i + 1);
        i = part.length;
      } else {
        current += part.slice(i + 1, close);
        i = close;
      }
    } else if (c === '$' && part[i + 1] === "'") {
      let j = i + 2;
      for (; j < part.length && part[j] !== "'"; j++) {
        if (part[j] !== '\\') {
          current += part[j];
          continue;
        }
        if (j + 1 >= part.length) break;
        const escape = ansiEscape(part, j + 1);
        current += escape.text;
        j += escape.used;
      }
      if (j >= part.length) broken = true;
      i = j;
    } else if (c === '"' || (c === '$' && part[i + 1] === '"')) {
      let j = c === '$' ? i + 2 : i + 1;
      for (; j < part.length && part[j] !== '"'; j++) {
        if (part[j] === '\\' && part[j + 1] === '\n') j++;
        else if (part[j] === '\\' && j + 1 < part.length && '"\\$`'.includes(part[j + 1]!)) current += part[++j];
        else {
          if (EXPANSION.test(part.slice(j, j + 2))) expands = true;
          current += part[j];
        }
      }
      if (j >= part.length) broken = true;
      i = j;
    } else if (c === '\\') {
      if (i + 1 < part.length) current += part[++i];
      else broken = true;
    } else {
      if (c === '$' && EXPANSION.test(part.slice(i, i + 2))) expands = true;
      current += c === '{' && part[i - 1] === '$' ? c : (BRACES[c] ?? c);
    }
  }
  end();
  const out: string[] = [];
  const flags: boolean[] = [];
  for (const w of raw) {
    const expanded = w.text.includes(OPEN) ? expandBraces(w.text) : [w.text];
    if (!expanded) {
      broken = true;
      out.push(PLAIN(w.text));
      flags.push(w.expands);
      continue;
    }
    // A word that expands to nothing (`''` aside) disappears, as in bash.
    for (const e of expanded) {
      out.push(PLAIN(e));
      flags.push(w.expands);
    }
  }
  return { words: out, expands: flags, broken };
}
