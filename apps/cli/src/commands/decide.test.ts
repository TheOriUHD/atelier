import { RpcError, RpcErrorCode, type DecideInput, type DecideResult, type DecisionAnswer, type DecisionStatus } from '@atelier/protocol';
import { describe, expect, it } from 'vitest';
import { parse } from '../args.ts';
import { Paint, palette, strip } from '../style.ts';
import { decideCommand, flagQuestions, inOrder, parseOptions, planDecide, renderLine, renderResult, renderStatus, runDecide, UsageError, type Asked, type DecideConnection, type DecideIo } from './decide.ts';

const plain = new Paint(palette('dark', 0));
const SOURCE = { id: 'service:typesafe:jev-latest', label: 'Jev', provider: 'TypeSafe Jev', local: false };

/** The command line as main reads it: `atelier decide …`. */
const cli = (...argv: string[]) => {
  const { values, positionals, tokens } = parse(['decide', ...argv]);
  return { values, rest: positionals.slice(1), tokens };
};

const stdin = (text: string | null): DecideIo['stdin'] =>
  Object.assign(
    (async function* () {
      if (text !== null) yield Buffer.from(text);
    })(),
    { isTTY: text === null },
  );

const files: Record<string, string> = {
  'mail.txt': 'Win a free phone!\n',
  'questions.json': JSON.stringify([
    { name: 'spam', type: 'yesno', instructions: 'Is this spam?' },
    { name: 'team', type: 'choice', instructions: 'Which team?', options: [{ value: 'billing' }, { value: 'tech' }, { value: 'other' }] },
  ]),
  'bad.json': JSON.stringify([
    { name: 'spam', type: 'yesno', instructions: 'Is this spam?' },
    { name: 'urgency', type: 'score', instructions: 'How urgent?', options: [{ value: 'only' }] },
  ]),
};
const readFile = async (path: string) => {
  if (path in files) return files[path]!;
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
};

const plan = (args: string[], input: string | null = null) => {
  const { values, rest, tokens } = cli(...args);
  return planDecide(values, rest, tokens, { readFile, stdin: stdin(input) });
};

/** A decision model that answers from the text: "free" is spam, "invoice" is billing, "!" is urgent. */
function answer(state: string, q: DecideInput['questions'][number]): DecisionAnswer {
  if (q.instructions.includes('refuse')) return { type: 'refusal', name: q.name };
  if (q.type === 'yesno') return { type: 'yesno', name: q.name, probability: state.includes('free') ? 0.92 : 0.3 };
  const values = q.options!.map((o) => o.value);
  if (q.type === 'choice') {
    const choice = state.includes('invoice') ? values[0]! : values[1]!;
    return { type: 'choice', name: q.name, choice, confidence: 0.8, probabilities: values.map((value) => ({ value, probability: value === choice ? 0.82 : 0.18 / (values.length - 1) })) };
  }
  const urgent = state.includes('!');
  const probabilities = values.map((value, i) => ({ value, probability: urgent ? [0.05, 0.2, 0.75][i] ?? 0 : [0.7, 0.2, 0.1][i] ?? 0 }));
  return { type: 'score', name: q.name, score: urgent ? 1.7 : 0.4, level: urgent ? values.length - 1 : 0, confidence: null, probabilities };
}

const result = (input: DecideInput): DecideResult => ({ answers: input.questions.map((q) => answer(input.state as string, q)), source: SOURCE, model: 'jev-1.14.0', ms: 120, usage: { inputTokens: 422, outputTokens: 0 } });

const status = (over: Partial<DecisionStatus> = {}): DecisionStatus => ({ enabled: true, source: SOURCE, sources: [], chosen: null, ...over });

function fake(o: { decide?: (input: DecideInput) => Promise<DecideResult> | DecideResult; status?: DecisionStatus; role?: string; mode?: 'local' | 'server' } = {}) {
  const calls: { method: string; input: unknown }[] = [];
  let closed = false;
  const conn: DecideConnection = {
    mode: o.mode ?? 'local',
    serverUrl: o.mode === 'server' ? 'https://atelier.example.com' : null,
    user: { role: o.role ?? 'admin' },
    close: () => void (closed = true),
    rpc: {
      call: (async (method: string, input: unknown) => {
        calls.push({ method, input });
        if (method === 'decisions.status') return o.status ?? status();
        if (method === 'decisions.decide') return (o.decide ?? result)(input as DecideInput);
        throw new RpcError(RpcErrorCode.MethodNotFound, `Unknown method ${method}`);
      }) as DecideConnection['rpc']['call'],
    },
  };
  return { conn, calls, closed: () => closed };
}

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) }, text: () => strip(out.join('')), errors: () => err.join('') };
};

describe('reading the questions from the flags', () => {
  it('takes options split by commas, each with what it means after "="', () => {
    expect(parseOptions('billing=Invoices and refunds, tech ,other=')).toEqual([{ value: 'billing', description: 'Invoices and refunds' }, { value: 'tech' }, { value: 'other' }]);
  });

  it('names them q1, q2, … in the order typed and pairs each --choice and --score with its --question', () => {
    const { tokens } = cli('--yes-no', 'Is this spam?', '--choice', 'billing,tech', '--question', 'Which team?', '--score', 'low,medium,high', '--question', 'How urgent?', '--yes-no', 'Is it polite?');
    const asked = flagQuestions(tokens);
    expect(asked.questions).toEqual([
      { name: 'q1', type: 'yesno', instructions: 'Is this spam?' },
      { name: 'q2', type: 'choice', instructions: 'Which team?', options: [{ value: 'billing' }, { value: 'tech' }] },
      { name: 'q3', type: 'score', instructions: 'How urgent?', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
      { name: 'q4', type: 'yesno', instructions: 'Is it polite?' },
    ]);
    expect(asked.labels.get('q3')).toBe('How urgent?');
    // The question may come first.
    expect(flagQuestions(cli('--question', 'Which team?', '--choice', 'a,b').tokens).questions[0]).toMatchObject({ type: 'choice', instructions: 'Which team?' });
  });

  it('says what is wrong before anything is sent', () => {
    const wrong = (...argv: string[]) => () => flagQuestions(cli(...argv).tokens);
    expect(wrong('--choice', 'billing', '--question', 'Which?')).toThrow('at least two options');
    expect(wrong('--score', 'a,b,c,d,e,f,g,h,i,j,k', '--question', 'How?')).toThrow('2 to 10 levels');
    expect(wrong('--choice', 'a,b')).toThrow('needs its own --question');
    expect(wrong('--question', 'Which?')).toThrow('--question goes with --choice or --score');
    expect(wrong('--yes-no')).toThrow('--yes-no needs a value');
    expect(wrong('--choice', '=x,b', '--question', 'Which?')).toThrow('needs a name');
  });
});

describe('planning a decision', () => {
  it('takes the text from the argument, --file or stdin', async () => {
    expect((await plan(['Win a free phone!', '--yes-no', 'Spam?'])).texts).toEqual(['Win a free phone!']);
    expect((await plan(['--file', 'mail.txt', '--yes-no', 'Spam?'])).texts).toEqual(['Win a free phone!']);
    expect((await plan(['--yes-no', 'Spam?'], 'piped text\n')).texts).toEqual(['piped text']);
    await expect(plan(['--yes-no', 'Spam?'])).rejects.toThrow('Nothing to decide');
    await expect(plan(['text', '--file', 'mail.txt', '--yes-no', 'Spam?'])).rejects.toThrow('not both');
    await expect(plan(['--file', 'gone.txt', '--yes-no', 'Spam?'])).rejects.toThrow('Couldn’t read gone.txt: there is no such file');
  });

  it('decides each non-empty line on its own with --lines', async () => {
    const p = await plan(['--lines', '--yes-no', 'Spam?'], 'one\n\n  two  \r\nthree\n');
    expect(p).toMatchObject({ lines: true, texts: ['one', 'two', 'three'] });
  });

  it('reads questions from a JSON file and checks them as the backend does', async () => {
    const p = await plan(['hello', '--questions', 'questions.json', '--model', 'text:ollama:nimble', '--json']);
    expect(p.asked!.questions.map((q) => q.name)).toEqual(['spam', 'team']);
    expect(p).toMatchObject({ source: 'text:ollama:nimble', json: true });
    await expect(plan(['hello', '--questions', 'bad.json'])).rejects.toThrow('Question 2 (urgency): A score needs 2 to 10 levels.');
    await expect(plan(['hello', '--questions', 'questions.json', '--yes-no', 'Spam?'])).rejects.toThrow('not both');
    await expect(plan(['hello'])).rejects.toThrow(UsageError);
  });

  it('needs no text or question for --list', async () => {
    expect(await plan(['--list'])).toMatchObject({ list: true, asked: null });
  });
});

describe('showing the answers', () => {
  const asked = (args: string[]): Asked => flagQuestions(cli(...args).tokens);

  it('shows a choice with a bar and the other options’ chances', () => {
    const a = asked(['--choice', 'billing,tech,other', '--question', 'category']);
    const lines = renderResult(result({ state: 'an invoice', questions: a.questions }), a, plain);
    expect(lines[0]).toBe('category  billing  ████████░░ 82%');
    expect(lines[1]).toBe('          tech 9% · other 9%');
    expect(lines.at(-1)).toBe('jev-1.14.0 · TypeSafe Jev · 0.12 s · 422 tokens');
    expect(renderResult(result({ state: 'an invoice', questions: a.questions }), a, plain, { bars: false })[0]).toBe('category  billing  82%');
  });

  it('shows yes or no with the likelier answer', () => {
    const a = asked(['--yes-no', 'spam']);
    expect(renderResult(result({ state: 'free', questions: a.questions }), a, plain)[0]).toBe('spam?  yes  █████████░ 92%');
    expect(renderResult(result({ state: 'hello', questions: a.questions }), a, plain)[0]).toBe('spam?  no  ███████░░░ 70%');
  });

  it('shows a score as its level, the expected level and each level’s chance', () => {
    const a = asked(['--score', 'low,medium,high', '--question', 'urgency']);
    const lines = renderResult(result({ state: 'now!', questions: a.questions }), a, plain);
    expect(lines.slice(0, 2)).toEqual(['urgency  high  2 of 0-2 (expected 1.7)', '         low 5% · medium 20% · high 75%']);
  });

  it('says when the model gave no answer', () => {
    const a = asked(['--yes-no', 'please refuse']);
    expect(renderResult(result({ state: 'x', questions: a.questions }), a, plain)[0]).toBe('please refuse?  no answer');
  });

  it('puts every answer in a column for --lines, then the text', () => {
    const a = asked(['--yes-no', 'spam', '--choice', 'billing,tech', '--question', 'team', '--score', 'low,mid,high', '--question', 'urgency', '--yes-no', 'refuse']);
    expect(renderLine(result({ state: 'free invoice!', questions: a.questions }), a, 'free invoice!')).toBe('yes 92%\tbilling 82%\thigh (1.7)\tno answer\tfree invoice!');
  });

  it('lists the decision model in use, and for admins every one with its id', () => {
    const sources = [{ id: 'text:ollama:nimble', label: 'nimble', provider: 'Ollama', local: true }, SOURCE];
    const admin = renderStatus(status({ source: sources[0]!, sources }), plain, { admin: true, where: 'on this computer' });
    expect(admin[0]).toBe('In use  nimble · Ollama · local');
    expect(admin).toContain('● text:ollama:nimble           nimble · Ollama · local');
    expect(admin).toContain('  service:typesafe:jev-latest  Jev · TypeSafe Jev');
    expect(renderStatus(status({ source: null }), plain, { admin: false, where: 'on atelier.example.com' })).toEqual(['No decision model is set up on atelier.example.com.', 'An admin can set one up in Settings › Admin › Decision models.']);
    expect(renderStatus(status({ enabled: false }), plain, { admin: true, where: 'on this computer' })[0]).toContain('Decision models are off');
  });
});

describe('running a decision', () => {
  it('asks once and prints the answers, or the whole result with --json', async () => {
    const f = fake();
    const c = capture();
    expect(await runDecide(await plan(['Win a free phone!', '--yes-no', 'Is this spam?']), f.conn, c.io, plain)).toBe(0);
    expect(f.calls).toEqual([{ method: 'decisions.decide', input: { state: 'Win a free phone!', questions: [{ name: 'q1', type: 'yesno', instructions: 'Is this spam?' }] } }]);
    expect(c.text()).toBe('Is this spam?  yes  █████████░ 92%\njev-1.14.0 · TypeSafe Jev · 0.12 s · 422 tokens\n');

    const j = capture();
    const p = await plan(['free', '--yes-no', 'Spam?', '--json', '-m', 'text:ollama:nimble']);
    expect(await runDecide(p, f.conn, j.io, plain)).toBe(0);
    expect(f.calls.at(-1)!.input).toMatchObject({ source: 'text:ollama:nimble' });
    expect(JSON.parse(j.text())).toEqual(result({ state: 'free', questions: p.asked!.questions }));
  });

  it('decides lines a few at a time and prints them in order', async () => {
    let running = 0;
    let most = 0;
    const f = fake({
      decide: async (input) => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, input.state === 'b' ? 30 : 5));
        running--;
        return result(input);
      },
    });
    const c = capture();
    const texts = ['a free one', 'b', 'c', 'd', 'e', 'f', 'g free', 'h'];
    expect(await runDecide(await plan(['--lines', '--yes-no', 'Spam?'], texts.join('\n')), f.conn, c.io, plain)).toBe(0);
    expect(c.text().trimEnd().split('\n')).toEqual(texts.map((t) => `${t.includes('free') ? 'yes 92%' : 'no 70%'}\t${t}`));
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);

    const j = capture();
    expect(await runDecide(await plan(['--lines', '--json', '--yes-no', 'Spam?'], 'one\ntwo free\n'), f.conn, j.io, plain)).toBe(0);
    const list = JSON.parse(j.text()) as DecideResult[];
    expect(list.map((r) => (r.answers[0] as { probability: number }).probability)).toEqual([0.3, 0.92]);
  });

  it('marks a line that failed and goes on', async () => {
    const f = fake({ decide: (input) => (input.state === 'bad' ? Promise.reject(new Error('The service is busy.')) : result(input)) });
    const c = capture();
    expect(await runDecide(await plan(['--lines', '--yes-no', 'Spam?'], 'ok\n\nbad\nfree\n'), f.conn, c.io, plain)).toBe(1);
    expect(c.text()).toBe('no 70%\tok\nerror\tbad\nyes 92%\tfree\n');
    // Its line in the input, blank lines counted.
    expect(c.errors()).toBe('Line 3: The service is busy.\n');
  });

  it('says how to get a decision model when there is none', async () => {
    const none = fake({ decide: () => Promise.reject(new RpcError(RpcErrorCode.Application, 'No decision model.', { code: 'not_found' })), status: status({ source: null }) });
    const c = capture();
    expect(await runDecide(await plan(['x', '--yes-no', 'Spam?']), none.conn, c.io, plain)).toBe(1);
    expect(c.errors()).toContain('No decision model is set up on this computer. Pull nimble or tev1 into an Ollama (0.35 or newer)');
    expect(c.errors()).toContain('Settings › Admin › Decision models');
    expect(c.out).toEqual([]);

    // With --lines it is said once, not for every line.
    const l = capture();
    expect(await runDecide(await plan(['--lines', '--yes-no', 'Spam?'], 'a\nb\nc\n'), none.conn, l.io, plain)).toBe(1);
    expect(l.errors().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('says what the backend said when --model is refused, and when the server is too old', async () => {
    const refused = fake({ decide: () => Promise.reject(new RpcError(RpcErrorCode.Application, 'Only an admin picks the decision model.', { code: 'forbidden' })), role: 'user', mode: 'server' });
    const c = capture();
    expect(await runDecide(await plan(['x', '--yes-no', 'Spam?', '--model', 'text:ollama:nimble']), refused.conn, c.io, plain)).toBe(1);
    expect(c.errors()).toBe('Only an admin picks the decision model.\n');

    const old = fake({ decide: () => Promise.reject(new RpcError(RpcErrorCode.MethodNotFound, 'Unknown method decisions.decide')), mode: 'server' });
    const o = capture();
    expect(await runDecide(await plan(['x', '--yes-no', 'Spam?']), old.conn, o.io, plain)).toBe(1);
    expect(o.errors()).toBe('atelier.example.com runs an Atelier without decision models. Update it to use atelier decide.\n');
  });

  it('prints the status for --list, as JSON with --json', async () => {
    const f = fake({ status: status({ sources: [SOURCE], chosen: SOURCE.id }) });
    const c = capture();
    expect(await runDecide(await plan(['--list']), f.conn, c.io, plain)).toBe(0);
    expect(c.text()).toContain('In use  Jev · TypeSafe Jev');
    expect(c.text()).toContain('Chosen in Settings: service:typesafe:jev-latest');
    const j = capture();
    expect(await runDecide(await plan(['--list', '--json']), f.conn, j.io, plain)).toBe(0);
    expect(JSON.parse(j.text())).toEqual(status({ sources: [SOURCE], chosen: SOURCE.id }));
  });

  it('checks the command line before connecting, and closes the connection after', async () => {
    let connected = 0;
    const f = fake();
    const c = capture();
    const io = (input: string | null): DecideIo => ({ ...c.io, readFile, stdin: stdin(input), connect: async () => (connected++, f.conn) });
    expect(await decideCommand({ ...cli('--choice', 'a'), paint: plain, bars: true }, io(null))).toBe(1);
    expect(connected).toBe(0);
    expect(c.errors()).toContain('--choice needs at least two options');
    expect(await decideCommand({ ...cli('--yes-no', 'Spam?'), paint: plain, bars: true }, io('free stuff'))).toBe(0);
    expect(connected).toBe(1);
    expect(f.closed()).toBe(true);
    // No connection: the reason is said already, its exit code is handed back.
    expect(await decideCommand({ ...cli('--yes-no', 'Spam?'), paint: plain, bars: true }, { ...io('x'), connect: async () => 3 })).toBe(3);
  });
});

it('keeps results in order whatever finishes first', async () => {
  const seen: number[] = [];
  await inOrder([30, 1, 20, 1, 1], 3, (ms) => new Promise<number>((r) => setTimeout(() => r(ms), ms)), (_r, i) => seen.push(i));
  expect(seen).toEqual([0, 1, 2, 3, 4]);
});
