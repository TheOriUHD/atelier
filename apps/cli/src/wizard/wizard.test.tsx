import { Text, useAnimation } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { AppContract, RpcClient } from '@atelier/protocol';
import { SignInWait } from './wizard.tsx';

/** A backend whose ChatGPT sign-in finishes on the third look. */
function fakeRpc() {
  const calls: { method: string; input: unknown }[] = [];
  let looks = 0;
  const rpc = {
    call: async (method: string, input: unknown) => {
      calls.push({ method, input });
      if (method === 'chatgpt.status') return { available: true, signedIn: ++looks >= 3, signingIn: looks < 3 };
      if (method === 'providers.save') return input;
      return { ok: true };
    },
  } as unknown as RpcClient<AppContract>;
  return { rpc, calls };
}

describe('waiting for a provider sign-in', () => {
  it('notices it finished while the screen keeps redrawing, and adds the provider', async () => {
    const { rpc, calls } = fakeRpc();
    const notes: string[] = [];
    // The wizard redraws many times a second (Pip, the spinner); the wait has to keep its own clock through that.
    function Busy() {
      const { frame } = useAnimation({ interval: 30 });
      return (
        <>
          <Text>{String(frame)}</Text>
          <SignInWait rpc={rpc} kind="chatgpt" onDone={(n) => notes.push(n)} />
        </>
      );
    }
    const ui = render(<Busy />);
    for (let i = 0; i < 60 && !notes.length; i++) await new Promise((r) => setTimeout(r, 100));
    ui.unmount();
    expect(notes).toEqual(['Added ChatGPT Plan.']);
    expect(calls.filter((c) => c.method === 'chatgpt.status').length).toBe(3);
    expect(calls.find((c) => c.method === 'providers.save')?.input).toMatchObject({ id: 'chatgpt', type: 'chatgpt', enabled: true });
  }, 10_000);

  it('ends the sign-in on Esc', async () => {
    const { rpc, calls } = fakeRpc();
    const notes: string[] = [];
    const ui = render(<SignInWait rpc={rpc} kind="chatgpt" onDone={(n) => notes.push(n)} />);
    ui.stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 100));
    ui.unmount();
    expect(notes).toEqual(['']);
    expect(calls.map((c) => c.method)).toContain('chatgpt.cancel');
  });
});
