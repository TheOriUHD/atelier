import { describe, expect, it } from 'vitest';
import { RequestInspector } from './inspector.ts';

describe('request inspector', () => {
  it('records requests only while switched on, with credentials masked', async () => {
    let on = false;
    const inspector = new RequestInspector(() => on);
    const fetch = inspector.wrap(async () => new Response('{}', { status: 200 }));
    await fetch('https://api.example.com/v1/models', {});
    expect(inspector.list()).toEqual([]);

    on = true;
    const seen: unknown[] = [];
    inspector.on('request', (r) => seen.push(r));
    await fetch('https://user:pass@api.example.com/v1/messages?key=sk-123&beta=true', {
      method: 'post',
      headers: { 'x-api-key': 'sk-123', authorization: 'Bearer sk-123', 'content-type': 'application/json' },
      body: '{"messages":[]}',
    });
    const [entry] = inspector.list();
    expect(entry).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/v1/messages?key=redacted&beta=true',
      requestHeaders: { 'x-api-key': '••••', authorization: '••••', 'content-type': 'application/json' },
      requestBytes: 15,
      status: 200,
      error: null,
      errorBody: null,
    });
    expect(JSON.stringify(inspector.list())).not.toContain('sk-123');
    expect(seen).toEqual([entry]);
  });

  it('keeps a failed response’s body and a network error, newest first, and clears', async () => {
    const inspector = new RequestInspector(() => true);
    await inspector.wrap(async () => new Response('{"error":"overloaded"}', { status: 529 }))('https://api.example.com/a', {});
    const response = inspector.wrap(async () => new Response('fine'))('https://api.example.com/b', {});
    expect(await (await response).text()).toBe('fine');
    await expect(inspector.wrap(async () => Promise.reject(new Error('ECONNREFUSED')))('https://api.example.com/c', {})).rejects.toThrow('ECONNREFUSED');
    expect(inspector.list().map((r) => [r.url.slice(-1), r.status, r.error, r.errorBody])).toEqual([
      ['c', null, 'ECONNREFUSED', null],
      ['b', 200, null, null],
      ['a', 529, null, '{"error":"overloaded"}'],
    ]);
    inspector.clear();
    expect(inspector.list()).toEqual([]);
  });
});
