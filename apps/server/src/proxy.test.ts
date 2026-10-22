import { describe, expect, it } from 'vitest';
import { clientIp, originRefusal, proxyConfig, publicOrigin } from './proxy.ts';

const request = (remote: string, headers: Record<string, string> = {}) => ({ url: 'http://10.0.0.2:7340/api/auth/login', remote, header: (n: string) => headers[n] });

describe('reverse proxy handling', () => {
  const config = proxyConfig('127.0.0.1, 10.0.0.0/24, fd00::/8');

  it('believes X-Forwarded-For only from trusted proxies', () => {
    expect(clientIp(config, '10.0.0.5', '203.0.113.7, 10.0.0.9')).toBe('203.0.113.7');
    expect(clientIp(config, '::ffff:127.0.0.1', '198.51.100.4')).toBe('198.51.100.4');
    expect(clientIp(config, '203.0.113.9', '1.2.3.4')).toBe('203.0.113.9');
    expect(clientIp(config, '10.0.0.5', undefined)).toBe('10.0.0.5');
  });

  it('takes the public origin from the base URL, a trusted proxy, or the request', () => {
    expect(publicOrigin(proxyConfig('', 'https://atelier.example.ts.net/'), request('203.0.113.9'))).toBe('https://atelier.example.ts.net');
    expect(publicOrigin(config, request('10.0.0.5', { host: '10.0.0.2:7340', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'chat.lan' }))).toBe('https://chat.lan');
    expect(publicOrigin(config, request('203.0.113.9', { host: 'evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'chat.lan' }))).toBe('http://evil.example');
  });

  it('refuses entries that aren’t addresses', () => {
    expect(() => proxyConfig('caddy')).toThrow(/not an IP address/);
  });
});

describe('originRefusal', () => {
  const refused = (over: Partial<Parameters<typeof originRefusal>[2]> = {}) => ({
    what: 'a WebSocket',
    origin: 'https://atelier.example.com',
    expected: 'http://192.168.77.25:7340',
    remote: '192.168.77.16',
    now: 1_000_000,
    ...over,
  });

  it('says what the server saw and what to change when a proxy it does not trust forwards the page', () => {
    const message = originRefusal(proxyConfig('192.168.77.67'), new Map(), refused())!;
    expect(message).toContain("the browser's address is https://atelier.example.com, but this server sees itself at http://192.168.77.25:7340");
    expect(message).toContain('the request came from 192.168.77.16, not a trusted proxy');
    expect(message).toContain('put 192.168.77.16 in ATELIER_TRUSTED_PROXIES, or set ATELIER_BASE_URL to https://atelier.example.com');
  });

  it('names the base URL when one is set, and says it once per sender every ten minutes', () => {
    const said = new Map<string, number>();
    const config = proxyConfig('192.168.77.16', 'https://old.example.com');
    expect(originRefusal(config, said, refused())).toContain('ATELIER_BASE_URL is https://old.example.com: set it to https://atelier.example.com');
    expect(originRefusal(config, said, refused({ now: 1_000_000 + 599_000 }))).toBeNull();
    expect(originRefusal(config, said, refused({ remote: '192.168.77.99', now: 1_000_000 + 1000 }))).not.toBeNull();
    expect(originRefusal(config, said, refused({ now: 1_000_000 + 601_000 }))).not.toBeNull();
  });
});
