import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DETACHED_TTL_MS, KEPT_OUTPUT_CHARS, TerminalManager } from './terminals.ts';
import type { Workspace } from './workspace.ts';

/** A workspace whose runner has PTYs that print what the test says, and remembers which were closed. */
function fakeWorkspace() {
  const listeners = new Map<string, Set<(n: { ptyId: string; b64?: string; code?: number }) => void>>();
  const closed: string[] = [];
  let next = 1;
  const runner = {
    call: vi.fn(async (method: string, params: { ptyId?: string }) => {
      if (method === 'pty.open') return { ptyId: `pty-${next++}`, shell: 'bash', pid: 1 };
      if (method === 'pty.close') closed.push(params.ptyId!);
      return null;
    }),
    on: (event: string, fn: (n: never) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(fn as never);
      listeners.set(event, set);
      return () => void set.delete(fn as never);
    },
  };
  const emit = (event: string, n: { ptyId: string; b64?: string; code?: number }) => listeners.get(event)?.forEach((fn) => fn(n));
  return {
    ws: { root: '/w', runner } as unknown as Workspace,
    closed,
    print: (ptyId: string, text: string) => emit('pty.data', { ptyId, b64: Buffer.from(text).toString('base64') }),
    exit: (ptyId: string, code: number) => emit('pty.exit', { ptyId, code }),
  };
}

type Conn = { name: string };
const a: Conn = { name: 'a' };
const b: Conn = { name: 'b' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TerminalManager', () => {
  const setup = () => {
    const seen: string[] = [];
    const events = { data: vi.fn((c: Conn, _id: string, d: string) => void seen.push(`${c.name}:${d}`)), exit: vi.fn() };
    return { ...fakeWorkspace(), seen, events, terminals: new TerminalManager<Conn>(events) };
  };

  it('sends output to the connection showing the terminal, and only lets it type', async () => {
    const { ws, terminals, print, seen } = setup();
    const id = await terminals.open(a, 'ada', ws, { cols: 80, rows: 24 });
    print('pty-1', 'hello ');
    expect(seen).toEqual(['a:hello ']);
    await expect(terminals.write(b, id, 'x')).rejects.toThrow('This terminal is closed.');
    await terminals.write(a, id, 'ls\n');
    expect(ws.runner.call).toHaveBeenCalledWith('pty.write', { ptyId: 'pty-1', data: 'ls\n' });
  });

  it('keeps running after its connection goes away and catches the next one up', async () => {
    const { ws, terminals, print, seen, closed } = setup();
    const id = await terminals.open(a, 'ada', ws, { cols: 80, rows: 24 });
    print('pty-1', 'before ');
    terminals.detachAll(a);
    print('pty-1', 'while away');
    expect(seen).toEqual(['a:before ']);
    await vi.advanceTimersByTimeAsync(DETACHED_TTL_MS - 1000);
    // The client saw 7 characters before it dropped.
    expect(terminals.attach(b, 'ada', id, 7)).toEqual({ data: 'while away', truncated: false });
    print('pty-1', '!');
    expect(seen).toEqual(['a:before ', 'b:!']);
    await vi.advanceTimersByTimeAsync(DETACHED_TTL_MS);
    expect(closed).toEqual([]);
    expect(terminals.attach(b, 'ada', id, 18)).toEqual({ data: '', truncated: false });
  });

  it('only lets the person who opened it attach it', async () => {
    const { ws, terminals } = setup();
    const id = await terminals.open(a, 'ada', ws, { cols: 80, rows: 24 });
    terminals.detachAll(a);
    expect(() => terminals.attach(b, 'bob', id, 0)).toThrow('This terminal is closed.');
  });

  it('says when more went by than it kept', async () => {
    const { ws, terminals, print } = setup();
    const id = await terminals.open(a, 'ada', ws, { cols: 80, rows: 24 });
    terminals.detachAll(a);
    print('pty-1', 'x'.repeat(KEPT_OUTPUT_CHARS + 10));
    const caught = terminals.attach(b, 'ada', id, 0);
    expect(caught.data).toHaveLength(KEPT_OUTPUT_CHARS);
    expect(caught.truncated).toBe(true);
  });

  it('closes a terminal nobody attaches in time', async () => {
    const { ws, terminals, closed } = setup();
    const id = await terminals.open(a, 'ada', ws, { cols: 80, rows: 24 });
    terminals.detachAll(a);
    await vi.advanceTimersByTimeAsync(DETACHED_TTL_MS);
    expect(closed).toEqual(['pty-1']);
    expect(() => terminals.attach(b, 'ada', id, 0)).toThrow('This terminal is closed.');
  });

  it('tells the connection showing it when the shell exits, and forgets it', async () => {
    const { ws, terminals, exit, events } = setup();
    const id = await terminals.open(a, 'ada', ws, { cols: 80, rows: 24 });
    exit('pty-1', 0);
    expect(events.exit).toHaveBeenCalledWith(a, id, 0);
    await expect(terminals.write(a, id, 'x')).rejects.toThrow('This terminal is closed.');
  });

  it('starts in the workspace root, or in a folder of it', async () => {
    const { ws, terminals } = setup();
    await terminals.open(a, 'ada', ws, { cols: 80, rows: 24 });
    await terminals.open(a, 'ada', ws, { cols: 100, rows: 30 }, 'src/lib');
    expect(ws.runner.call).toHaveBeenCalledWith('pty.open', { cwd: '/w', cols: 80, rows: 24 });
    expect(ws.runner.call).toHaveBeenCalledWith('pty.open', { cwd: 'src/lib', cols: 100, rows: 30 });
  });
});
