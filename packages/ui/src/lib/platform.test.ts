import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcMessage } from '@atelier/protocol';
import { desktopTransport } from './platform.ts';

/** Delivers a backend port the way the preload does. */
function deliver(port: MessagePort) {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'atelier:backend-port' }, source: window, ports: [port as unknown as globalThis.MessagePort] }));
}

/** Closes the backend's end and waits until the renderer's end has seen it. */
function drop(channel: MessageChannel) {
  const closed = new Promise((resolve) => channel.port1.once('close', resolve));
  channel.port2.close();
  return closed;
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('desktopTransport', () => {
  it('asks for a new port with backoff when its port closes, and reports the reconnect', async () => {
    const connect = vi.fn();
    const transport = desktopTransport({ connect });
    const events: string[] = [];
    transport.onStatus((up) => events.push(up ? 'up' : 'down'));
    transport.onClose!(() => events.push('close'));
    transport.onReconnect(() => events.push('reconnect'));
    expect(connect).toHaveBeenCalledTimes(1);

    const first = new MessageChannel();
    deliver(first.port1);
    await drop(first);
    expect(events).toEqual(['up', 'close', 'down']);
    expect(connect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(connect).toHaveBeenCalledTimes(2);

    // Messages sent while disconnected wait for the next port.
    const call: RpcMessage = { jsonrpc: '2.0', id: 1, method: 'app.info' };
    transport.send(call);
    const second = new MessageChannel();
    const received = new Promise((resolve) => second.port2.once('message', resolve));
    deliver(second.port1);
    expect(events).toEqual(['up', 'close', 'down', 'up', 'reconnect']);
    expect(await received).toEqual(call);

    // A port that dies before the backend answered on it doubles the wait.
    await drop(second);
    vi.advanceTimersByTime(250);
    expect(connect).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
