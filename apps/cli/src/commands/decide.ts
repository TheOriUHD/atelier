/**
 * `atelier decide`: asks the backend's decision model (ARCHITECTURE §28) typed questions about a text, and prints each
 * answer with how sure the model is. The text is the argument, `--file` or stdin; the questions are `--yes-no`,
 * `--choice` or `--score` (each `--choice` and `--score` with its `--question`), or a JSON file (`--questions`).
 * `--lines` decides each line on its own (for pipes), `--json` prints the backend's result as it is, and `--list` says
 * which decision model answers. Exit codes: 0 done, 1 failed (a usage mistake, or the backend refused), 3 sign-in needed.
 */
import { DecideInput, DECISION_MAX_LEVELS, RpcError, RpcErrorCode, type AppContract, type DecideResult, type DecisionAnswer, type DecisionOption, type DecisionQuestion, type DecisionStatus, type RpcClient } from '@atelier/protocol';
import { FLAGS, type ArgToken } from '../args.ts';
import { describe } from '../connection/connect.ts';
import type { Paint } from '../style.ts';

/** The longest text one decision may read (`DecisionState`). */
const MAX_TEXT = 400_000;
/** Lines decided at once with `--lines`. */
const CONCURRENCY = 4;
/** A label wider than this is cut, so the answers still line up. */
const LABEL_WIDTH = 40;
const BAR = 10;

/** A mistake in the command line: said as it is, without a connection. */
export class UsageError extends Error {}

export interface Asked {
  questions: DecisionQuestion[];
  /** What each answer is called in the output: the question for one from the flags, else its name. */
  labels: Map<string, string>;
}

export interface DecidePlan {
  list: boolean;
  json: boolean;
  lines: boolean;
  source?: string | undefined;
  /** Null with `--list`. */
  asked: Asked | null;
  /** The texts to decide: one, or each non-empty line with `--lines`. */
  texts: string[];
  /** Where each text was in the input (1 = the first line), for saying which line failed. */
  lineNumbers: number[];
}

/** The part of a connection `decide` uses (`Connected` has it). */
export interface DecideConnection {
  rpc: Pick<RpcClient<AppContract>, 'call'>;
  mode: 'local' | 'server';
  serverUrl: string | null;
  user: { role: string };
  close(): void;
}

export interface DecideIo {
  /** A connection, or the exit code when there is none (the reason is said already). */
  connect(): Promise<DecideConnection | number>;
  readFile(path: string): Promise<string>;
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean | undefined };
  out(text: string): void;
  err(text: string): void;
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

const SETUP_HELP = 'Pull nimble or tev1 into an Ollama (0.35 or newer) that Atelier uses (ollama pull nimble), or add a service in Settings › Admin › Decision models.';

// ---------------------------------------------------------------- reading the command line

/** `a,b=what b means,c`: options split by commas, each `name` or `name=what it means`. */
export function parseOptions(raw: string): DecisionOption[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return { value: part };
      const value = part.slice(0, eq).trim();
      const description = part.slice(eq + 1).trim();
      return description ? { value, description } : { value };
    });
}

const flagValue = (flag: string, value: string | undefined, example: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new UsageError(`--${flag} needs a value: --${flag} ${example}`);
  return value.trim();
};

/** The questions given as flags, in the order they were typed, named q1, q2, … */
export function flagQuestions(tokens: readonly ArgToken[]): Asked {
  type Pending = { type: 'choice' | 'score'; options: DecisionOption[] };
  const found: ({ type: 'yesno'; instructions: string } | Pending)[] = [];
  const pending: Pending[] = [];
  const texts: string[] = [];
  for (const t of tokens) {
    if (t.kind !== 'option') continue;
    if (t.name === 'yes-no') found.push({ type: 'yesno', instructions: flagValue('yes-no', t.value, '"Is this spam?"') });
    else if (t.name === 'choice' || t.name === 'score') {
      const raw = flagValue(t.name, t.value, t.name === 'choice' ? '"billing,tech,other"' : '"low,medium,high"');
      const options = parseOptions(raw);
      if (options.some((o) => !o.value)) throw new UsageError(`--${t.name} "${raw}": every option needs a name before its "=".`);
      if (t.name === 'choice' && options.length < 2) throw new UsageError(`--choice needs at least two options, split by commas: --choice "billing,tech,other"`);
      if (t.name === 'score' && (options.length < 2 || options.length > DECISION_MAX_LEVELS))
        throw new UsageError(`--score needs 2 to ${DECISION_MAX_LEVELS} levels, lowest first, split by commas: --score "low,medium,high"`);
      const q: Pending = { type: t.name, options };
      found.push(q);
      pending.push(q);
    } else if (t.name === 'question') texts.push(flagValue('question', t.value, '"Which team should take this?"'));
  }
  if (texts.length !== pending.length) {
    if (!pending.length) throw new UsageError('--question goes with --choice or --score. A yes-or-no question is --yes-no "…".');
    throw new UsageError(`Each --choice and --score needs its own --question, in the same order (${pending.length} ${pending.length === 1 ? 'needs' : 'need'} one, ${texts.length} given).`);
  }
  const labels = new Map<string, string>();
  const questions = found.map((f, i): DecisionQuestion => {
    const name = `q${i + 1}`;
    const instructions = f.type === 'yesno' ? f.instructions : texts[pending.indexOf(f)]!;
    labels.set(name, instructions);
    return f.type === 'yesno' ? { name, type: 'yesno', instructions } : { name, type: f.type, instructions, options: f.options };
  });
  return { questions, labels };
}

/** `--questions file.json`: an array of questions (or an object with one under `questions`). */
export function fileQuestions(text: string, file: string): Asked {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${file} isn’t JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { questions?: unknown }).questions) ? (data as { questions: unknown[] }).questions : null;
  if (!list) throw new UsageError(`${file} should hold a list of questions, e.g. [{"name": "spam", "type": "yesno", "instructions": "Is this spam?"}]`);
  const questions = list as DecisionQuestion[];
  const labels = new Map<string, string>();
  for (const q of questions) if (q && typeof q === 'object' && typeof q.name === 'string') labels.set(q.name, q.name);
  return { questions, labels };
}

/** Checks the questions as the backend will (`DecideInput`), in words that say which question is wrong. */
export function checkQuestions(asked: Asked, source: string | undefined, fromFlags: boolean): void {
  if (!asked.questions.length) throw new UsageError('No question: --yes-no "…", --choice "a,b" --question "…", --score "low,high" --question "…", or --questions file.json');
  const parsed = DecideInput.safeParse({ state: '', questions: asked.questions, ...(source ? { source } : {}) });
  if (parsed.success) {
    asked.questions = parsed.data.questions;
    return;
  }
  const said = parsed.error.issues.map((issue) => {
    const [top, index, ...field] = issue.path;
    if (top !== 'questions' || typeof index !== 'number') return top === 'source' ? `--model: ${issue.message}` : issue.message;
    const q = asked.questions[index] as Partial<DecisionQuestion> | undefined;
    const which = fromFlags ? `“${asked.labels.get(q?.name ?? '') ?? q?.name}”` : `Question ${index + 1}${typeof q?.name === 'string' ? ` (${q.name})` : ''}`;
    return `${which}${field.length && issue.code !== 'custom' ? `, ${field.join('.')}` : ''}: ${issue.message}`;
  });
  throw new UsageError([...new Set(said)].join('\n'));
}

async function readAll(stdin: DecideIo['stdin']): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const readNamed = (io: Pick<DecideIo, 'readFile'>, path: string) =>
  io.readFile(path).catch((e: NodeJS.ErrnoException) => {
    throw new UsageError(`Couldn’t read ${path}: ${e.code === 'ENOENT' ? 'there is no such file' : e.message}`);
  });

/** Everything the command line asks for, read and checked before connecting. */
export async function planDecide(values: Values, rest: readonly string[], tokens: readonly ArgToken[], io: Pick<DecideIo, 'readFile' | 'stdin'>): Promise<DecidePlan> {
  const model = values.model;
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new UsageError('--model needs a decision model’s id: atelier decide --list shows them.');
  const source = typeof model === 'string' ? model.trim() : undefined;
  const json = !!values.json || values['output-format'] === 'json';
  const lines = !!values.lines;
  if (values.list) return { list: true, json, lines: false, source, asked: null, texts: [], lineNumbers: [] };

  const fromFlags = tokens.some((t) => t.kind === 'option' && ['yes-no', 'choice', 'score', 'question'].includes(t.name));
  let asked: Asked;
  if (values.questions !== undefined) {
    if (fromFlags) throw new UsageError('Give the questions with --questions or with flags, not both.');
    const file = flagValue('questions', typeof values.questions === 'string' ? values.questions : undefined, 'questions.json');
    asked = fileQuestions(await readNamed(io, file), file);
  } else asked = flagQuestions(tokens);
  checkQuestions(asked, source, fromFlags);

  const argument = rest.join(' ');
  const file = values.file;
  if (file !== undefined && argument.trim()) throw new UsageError('Give the text or --file, not both.');
  let text: string;
  if (file !== undefined) text = await readNamed(io, flagValue('file', typeof file === 'string' ? file : undefined, 'mail.txt'));
  else if (argument.trim()) text = argument;
  else if (!io.stdin.isTTY) text = await readAll(io.stdin);
  else text = '';

  const items = (lines ? text.split(/\r?\n/) : [text]).map((t, i) => ({ text: t.trim(), line: i + 1 })).filter((t) => t.text);
  if (!items.length) throw new UsageError('Nothing to decide: atelier decide "the text" --yes-no "…" (or --file, or pipe it in).');
  const long = items.find((t) => t.text.length > MAX_TEXT);
  if (long) throw new UsageError(`${lines ? `Line ${long.line}` : 'The text'} is longer than ${MAX_TEXT.toLocaleString('en-US')} characters.`);
  return { list: false, json, lines, source, asked, texts: items.map((t) => t.text), lineNumbers: items.map((t) => t.line) };
}

// ---------------------------------------------------------------- showing answers

/** 0.92 → `92%`; a little above nothing is `<1%`. */
export const percent = (p: number): string => (p > 0 && p < 0.005 ? '<1%' : `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`);

const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

function bar(p: number, paint: Paint): string {
  const filled = Math.round(Math.min(1, Math.max(0, p)) * BAR);
  return `${paint.fg('accent', '█'.repeat(filled))}${paint.fg('faint', '░'.repeat(BAR - filled))}`;
}

function labelOf(a: DecisionAnswer, asked: Asked, q: DecisionQuestion | undefined): string {
  const label = asked.labels.get(a.name) ?? a.name;
  return q?.type === 'yesno' && !/[?？]$/.test(label) ? `${label}?` : label;
}

/** The likeliest answer in a word, and how likely it is. */
function topOf(a: DecisionAnswer, q: DecisionQuestion | undefined): { word: string; p: number | null } {
  switch (a.type) {
    case 'yesno':
      return a.probability >= 0.5 ? { word: 'yes', p: a.probability } : { word: 'no', p: 1 - a.probability };
    case 'choice':
      return { word: a.choice, p: a.probabilities.find((o) => o.value === a.choice)?.probability ?? a.confidence };
    case 'score':
      return { word: q?.options?.[a.level]?.value ?? a.probabilities[a.level]?.value ?? String(a.level), p: a.probabilities[a.level]?.probability ?? null };
    case 'refusal':
      return { word: 'no answer', p: null };
  }
}

/** The answers as people read them: the answer in words, a bar, and the other options' chances under it. */
export function renderResult(result: DecideResult, asked: Asked, paint: Paint, options: { bars?: boolean } = {}): string[] {
  const bars = options.bars ?? true;
  const byName = new Map(asked.questions.map((q) => [q.name, q]));
  const rows = result.answers.map((a) => ({ a, q: byName.get(a.name) }));
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(0, ...rows.map(({ a, q }) => labelOf(a, asked, q).length)));
  const words = rows.filter(({ a }) => a.type === 'choice' || a.type === 'yesno' || a.type === 'score').map(({ a, q }) => topOf(a, q).word.length);
  const wordWidth = Math.min(24, Math.max(0, ...words));
  const indent = ' '.repeat(labelWidth + 2);
  const out: string[] = [];
  for (const { a, q } of rows) {
    const label = paint.bold(cut(labelOf(a, asked, q), labelWidth).padEnd(labelWidth));
    const top = topOf(a, q);
    const word = paint.fg('accent', cut(top.word, 24).padEnd(wordWidth));
    if (a.type === 'refusal') {
      out.push(`${label}  ${paint.fg('muted', 'no answer')}`);
    } else if (a.type === 'score') {
      const max = Math.max((q?.options?.length ?? a.probabilities.length) - 1, a.level);
      out.push(`${label}  ${word}  ${a.level} of 0-${max} ${paint.fg('muted', `(expected ${a.score.toFixed(1)})`)}`);
      if (a.probabilities.length) out.push(`${indent}${paint.fg('muted', a.probabilities.map((o) => `${o.value} ${percent(o.probability)}`).join(' · '))}`);
    } else {
      const p = top.p ?? 0;
      out.push(`${label}  ${word}  ${bars ? `${bar(p, paint)} ` : ''}${top.p === null ? '' : percent(p)}`.trimEnd());
      if (a.type === 'choice') {
        const others = a.probabilities.filter((o) => o.value !== a.choice).sort((x, y) => y.probability - x.probability);
        const shown = others.slice(0, 6).map((o) => `${o.value} ${percent(o.probability)}`);
        if (others.length > 6) shown.push(`${others.length - 6} more`);
        if (shown.length) out.push(`${indent}${paint.fg('muted', shown.join(' · '))}`);
      }
    }
  }
  out.push(paint.fg('muted', footer(result)));
  return out;
}

/** `jev-1.14.0 · TypeSafe Jev · 0.12 s · 422 tokens` */
export function footer(result: DecideResult): string {
  const tokens = result.usage.inputTokens + result.usage.outputTokens;
  return [result.model || result.source.label, result.source.provider, `${(result.ms / 1000).toFixed(2)} s`, `${tokens.toLocaleString('en-US')} ${tokens === 1 ? 'token' : 'tokens'}`].join(' · ');
}

/** One line for `--lines`: each answer in a column (`yes 92%`, `billing 82%`, `high (1.7)`), then the text, split by tabs. */
export function renderLine(result: DecideResult, asked: Asked, text: string): string {
  const byName = new Map(asked.questions.map((q) => [q.name, q]));
  const cells = result.answers.map((a) => {
    const top = topOf(a, byName.get(a.name));
    if (a.type === 'refusal') return top.word;
    if (a.type === 'score') return `${top.word} (${a.score.toFixed(1)})`;
    return top.p === null ? top.word : `${top.word} ${percent(top.p)}`;
  });
  return [...cells, text.replace(/[\r\n]+/g, ' ')].join('\t');
}

/** `--list`: the decision model in use, and for admins every one with its id. */
export function renderStatus(status: DecisionStatus, paint: Paint, who: { admin: boolean; where: string }): string[] {
  if (!status.enabled) return [offLine(who)];
  const out: string[] = [];
  if (status.source) out.push(`${paint.bold('In use')}  ${status.source.label} · ${status.source.provider}${status.source.local ? paint.fg('muted', ' · local') : ''}`);
  else out.push(...noModel(who));
  if (status.sources.length) {
    const width = Math.max(...status.sources.map((s) => s.id.length));
    out.push('', paint.bold('Decision models') + paint.fg('muted', '  (atelier decide --model <id> asks one)'));
    for (const s of status.sources) {
      const inUse = s.id === status.source?.id;
      out.push(`${inUse ? paint.fg('accent', '●') : ' '} ${paint.fg(inUse ? 'accent' : 'text', s.id.padEnd(width))}  ${s.label} · ${s.provider}${s.local ? paint.fg('muted', ' · local') : ''}`);
    }
    out.push(paint.fg('muted', status.chosen ? `Chosen in Settings: ${status.chosen}` : 'None chosen in Settings: Atelier picks one, a local model first.'));
  }
  for (const p of status.problems ?? []) out.push(`${paint.fg('warn', '!')} ${p.provider}: ${p.error}`);
  return out;
}

function noModel(who: { admin: boolean; where: string }): string[] {
  return [`No decision model is set up ${who.where}.`, who.admin ? SETUP_HELP : 'An admin can set one up in Settings › Admin › Decision models.'];
}

const offLine = (who: { admin: boolean; where: string }) => `Decision models are off ${who.where}. ${who.admin ? 'Turn them on' : 'An admin turns them on'} in Settings › Admin › Decision models.`;

// ---------------------------------------------------------------- running it

/** `atelier decide --help`. */
export function decideHelp(paint: { fg(role: 'accent' | 'muted', t: string): string; bold(t: string): string }): string {
  const flags = FLAGS.filter((f) => f.help.startsWith('With decide: ') || f.name === 'model').map((f) => {
    const help = f.name === 'model' ? 'A decision model’s id from --list (admins only)' : f.help.slice('With decide: '.length).replace(/^./, (c) => c.toUpperCase());
    return `  ${paint.fg('accent', `${f.short ? `-${f.short}, ` : '    '}--${f.name}${f.value ? ` <${f.value}>` : ''}`.padEnd(30))}${help}`;
  });
  const example = (c: string) => `  ${paint.fg('accent', c)}`;
  return [
    paint.bold('atelier decide: a decision model answers questions about a text, with how sure it is'),
    '',
    paint.bold('Usage'),
    example('atelier decide "Win a free phone!" --yes-no "Is this spam?"'),
    example('atelier decide --file mail.txt --choice "billing,tech,other" --question "Which team should take it?"'),
    example('atelier decide --file ticket.txt --score "low,medium,high" --question "How urgent is it?"'),
    example('cat subjects.txt | atelier decide --lines --questions questions.json'),
    example('atelier decide --list'),
    '',
    paint.bold('Options'),
    ...flags,
    '',
    paint.fg('muted', 'Options with a meaning: --choice "billing=Invoices and refunds,tech=Bugs and errors". A file of questions takes'),
    paint.fg('muted', '[{"name": "spam", "type": "yesno", "instructions": "Is this spam?"}, {"name": "team", "type": "choice", ...}].'),
  ].join('\n');
}

const whereOf = (conn: DecideConnection) => (conn.mode === 'server' && conn.serverUrl ? `on ${new URL(conn.serverUrl).host}` : 'on this computer');

/**
 * Why a call failed, in a sentence, with what to do when that is known. A decision without `--model` that failed
 * because there is no decision model says how to get one.
 */
async function explain(e: unknown, conn: DecideConnection, askStatus: boolean): Promise<string> {
  if (e instanceof RpcError && e.code === RpcErrorCode.MethodNotFound) {
    return conn.mode === 'server' && conn.serverUrl
      ? `${new URL(conn.serverUrl).host} runs an Atelier without decision models. Update it to use atelier decide.`
      : 'The background service is an older version without decision models: atelier daemon stop, then try again.';
  }
  if (askStatus) {
    const status = await conn.rpc.call('decisions.status', {}).catch(() => null);
    const who = { admin: conn.user.role === 'admin', where: whereOf(conn) };
    if (status && !status.enabled) return offLine(who);
    if (status && !status.source) return noModel(who).join(' ');
  }
  return describe(e);
}

/** Runs `items` through `work`, `limit` at a time, handing each result on in the items' order as soon as it can. */
export async function inOrder<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>, done: (result: R, index: number) => void): Promise<void> {
  const results = new Map<number, R>();
  let next = 0;
  let flushed = 0;
  const flush = () => {
    while (results.has(flushed)) {
      done(results.get(flushed)!, flushed);
      results.delete(flushed);
      flushed++;
    }
  };
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results.set(i, await work(items[i]!, i));
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function runDecide(plan: DecidePlan, conn: DecideConnection, io: Pick<DecideIo, 'out' | 'err'>, paint: Paint, options: { bars?: boolean } = {}): Promise<number> {
  if (plan.list) {
    let status: DecisionStatus;
    try {
      status = await conn.rpc.call('decisions.status', {});
    } catch (e) {
      io.err(`${await explain(e, conn, false)}\n`);
      return 1;
    }
    io.out(plan.json ? `${JSON.stringify(status, null, 2)}\n` : `${renderStatus(status, paint, { admin: conn.user.role === 'admin', where: whereOf(conn) }).join('\n')}\n`);
    return 0;
  }

  const asked = plan.asked!;
  const ask = (state: string) => conn.rpc.call('decisions.decide', { state, questions: asked.questions, ...(plan.source ? { source: plan.source } : {}) });

  if (!plan.lines) {
    try {
      const result = await ask(plan.texts[0]!);
      io.out(plan.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderResult(result, asked, paint, options).join('\n')}\n`);
      return 0;
    } catch (e) {
      io.err(`${await explain(e, conn, !plan.source)}\n`);
      return 1;
    }
  }

  // The first line alone: a reason every line would fail for (no decision model, not an admin) is said once.
  type Outcome = { result: DecideResult } | { error: string };
  const outcomes: Outcome[] = [];
  let failed = 0;
  let first: DecideResult;
  try {
    first = await ask(plan.texts[0]!);
  } catch (e) {
    io.err(`${await explain(e, conn, !plan.source)}\n`);
    return 1;
  }
  const show = (o: Outcome, i: number) => {
    outcomes[i] = o;
    if (plan.json) return;
    if ('result' in o) io.out(`${renderLine(o.result, asked, plan.texts[i]!)}\n`);
    else {
      failed++;
      io.out(`error\t${plan.texts[i]!.replace(/[\r\n]+/g, ' ')}\n`);
      io.err(`Line ${plan.lineNumbers[i] ?? i + 1}: ${o.error}\n`);
    }
  };
  show({ result: first }, 0);
  await inOrder(
    plan.texts.slice(1),
    CONCURRENCY,
    (text) => ask(text).then((result): Outcome => ({ result }), (e: unknown): Outcome => ({ error: describe(e) })),
    (o, i) => show(o, i + 1),
  );
  if (plan.json) {
    failed = outcomes.filter((o) => 'error' in o).length;
    io.out(`${JSON.stringify(outcomes.map((o) => ('result' in o ? o.result : { error: o.error })), null, 2)}\n`);
  }
  return failed ? 1 : 0;
}

/** `atelier decide …` from main: the command line read and checked, then one connection for the questions. */
export async function decideCommand(args: { values: Values; rest: string[]; tokens: ArgToken[]; paint: Paint; bars: boolean }, io: DecideIo): Promise<number> {
  let plan: DecidePlan;
  try {
    plan = await planDecide(args.values, args.rest, args.tokens, io);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`${e.message}\n`);
    return 1;
  }
  const conn = await io.connect();
  if (typeof conn === 'number') return conn;
  try {
    return await runDecide(plan, conn, io, args.paint, { bars: args.bars });
  } finally {
    conn.close();
  }
}
