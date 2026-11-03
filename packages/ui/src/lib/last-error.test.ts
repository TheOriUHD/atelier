import { afterEach, describe, expect, it } from 'vitest';
import { clearLastError, lastError, recordError, trackErrors } from './last-error.ts';

afterEach(clearLastError);

describe('the last error', () => {
  it('is none until something fails', () => {
    expect(lastError()).toBeNull();
  });

  it('keeps the message and the time of the newest error, without its stack', () => {
    const e = new TypeError('Cannot read properties of undefined');
    e.stack = 'TypeError: x\n    at /Users/ada/secret-project/src/a.ts:1:1';
    recordError(e, 5);
    recordError(new Error('second'), 9);
    expect(lastError()).toEqual({ message: 'Error: second', at: 9 });
    recordError(e, 10);
    expect(lastError()?.message).toBe('TypeError: Cannot read properties of undefined');
    expect(JSON.stringify(lastError())).not.toContain('secret-project');
  });

  it('takes strings, objects, and things that cannot be written down, and bounds them', () => {
    recordError('plain text');
    expect(lastError()?.message).toBe('plain text');
    recordError({ code: 7 });
    expect(lastError()?.message).toBe('{"code":7}');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => recordError(loop)).not.toThrow();
    recordError(undefined);
    expect(lastError()?.message).toBe('undefined');
    recordError('x'.repeat(10_000));
    expect(lastError()?.message.length).toBe(2000);
  });

  it('notices uncaught errors and unhandled rejections in the window, and listens only once', () => {
    trackErrors();
    trackErrors();
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('boom'), message: 'boom' }));
    expect(lastError()?.message).toBe('RangeError: boom');
    const rejection = new Event('unhandledrejection');
    Object.assign(rejection, { reason: new Error('nobody caught this') });
    window.dispatchEvent(rejection);
    expect(lastError()?.message).toBe('Error: nobody caught this');
  });
});
