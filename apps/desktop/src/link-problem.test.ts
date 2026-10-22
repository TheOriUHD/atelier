import { describe, expect, it } from 'vitest';
import { describeFailure, diagnose } from './link-problem.ts';

const failure = (code: string, message = '') => Object.assign(new TypeError('fetch failed'), { cause: { code, message } });

describe('describeFailure', () => {
  it('says what macOS is doing when it refuses the local network, and offers its switch', () => {
    const problem = describeFailure(failure('EHOSTUNREACH'), 'https://atelier.example.lan', 'darwin');
    expect(problem).toMatchObject({ code: 'EHOSTUNREACH', localNetwork: true });
    expect(problem.message).toContain('Local Network');
    // The same error elsewhere is just an unreachable host.
    expect(describeFailure(failure('EHOSTUNREACH'), 'https://atelier.example.lan', 'win32')).toEqual({ code: 'EHOSTUNREACH', message: "atelier.example.lan can't be reached from this computer's network." });
  });

  it.each([
    ['ENOTFOUND', /no server named nas\.lan/],
    ['ECONNREFUSED', /refused the connection/],
    ['UND_ERR_CONNECT_TIMEOUT', /didn't answer in time/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', /certificate/],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /certificate/],
  ])('%s', (code, words) => {
    expect(describeFailure(failure(code), 'https://nas.lan', 'linux').message).toMatch(words);
  });

  it('falls back to the system message for anything else', () => {
    expect(describeFailure(failure('EWHATEVER', 'strange'), 'https://nas.lan', 'linux')).toEqual({ code: 'EWHATEVER', message: "Couldn't connect to nas.lan: strange." });
    expect(describeFailure('nonsense', 'https://nas.lan').code).toBe('UNKNOWN');
  });
});

describe('diagnose', () => {
  it('blames the live connection when the server answers over plain HTTP', async () => {
    const problem = await diagnose('https://nas.lan/', async () => new Response('{"ok":true}'));
    expect(problem.code).toBe('WEBSOCKET');
    expect(problem.message).toContain('WebSockets');
  });

  it('names the status of an address that is not an Atelier server', async () => {
    expect(await diagnose('https://nas.lan', async () => new Response('no', { status: 404 }))).toMatchObject({ code: 'HTTP_404' });
  });

  it('reports why the request itself failed', async () => {
    const problem = await diagnose('https://nas.lan', async () => Promise.reject(failure('EHOSTUNREACH')), 'darwin');
    expect(problem).toMatchObject({ code: 'EHOSTUNREACH', localNetwork: true });
  });
});
