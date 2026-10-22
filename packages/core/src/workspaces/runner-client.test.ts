import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunnerClient, type RunnerChannel, type RunnerExit } from './runner-client.ts';

const INFO = { protocolVersion: 1, runnerVersion: 'test', os: 'linux', arch: 'amd64', roots: ['/w'], home: '/h', shell: 'bash', pathSep: '/', capabilities: { methods: [], execShell: 'bash' } };

/** A runner over a channel that answers `initialize` and `sys.ping` while `answering`, and nothing else. */
function fakeRunner() {
  let receive: (line: string) => void = () => {};
  let close!: (exit: RunnerExit) => void;
  const runner = { answering: true, killed: false };
  const channel: RunnerChannel = {
    send(line) {
      const { id, method } = JSON.parse(line) as { id?: number; method: string };
      const result = method === 'initialize' ? INFO : method === 'sys.ping' ? { time: Date.now() } : undefined;
      if (runner.answering && id !== undefined && result) queueMicrotask(() => receive(JSON.stringify({ jsonrpc: '2.0', id, result })));
    },
    onLine: (handler) => void (receive = handler),
    closed: new Promise((resolve) => (close = resolve)),
    kill() {
      runner.killed = true;
      close({ code: null, signal: 'SIGKILL' });
    },
  };
  return { runner, channel };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RunnerClient heartbeat', () => {
  it('keeps a runner that answers its pings', async () => {
    const { runner, channel } = fakeRunner();
    const client = await RunnerClient.connect(channel);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.alive).toBe(true);
    expect(runner.killed).toBe(false);
  });

  it('closes the channel after two missed pings, failing the calls waiting on it', async () => {
    const { runner, channel } = fakeRunner();
    const client = await RunnerClient.connect(channel);
    runner.answering = false;
    const stat = client.call('fs.stat', { path: '.' });
    const failed = expect(stat).rejects.toThrow(/stopped answering/);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runner.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.killed).toBe(true);
    await failed;
    expect(client.alive).toBe(false);
  });
});
