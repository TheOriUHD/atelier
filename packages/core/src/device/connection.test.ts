import { describe, expect, it } from 'vitest';
import { parseConnection } from './connection.ts';

const server = (serverUrl: string) => parseConnection({ mode: 'server', serverUrl });

describe('parseConnection', () => {
  it('accepts this computer', () => {
    expect(parseConnection({ mode: 'local' })).toEqual({ mode: 'local' });
  });

  it('normalizes https server URLs to origin plus path without a trailing slash', () => {
    expect(server(' https://atelier.example.com/ ')).toEqual({ mode: 'server', serverUrl: 'https://atelier.example.com' });
    expect(server('https://example.com/atelier/?x=1#y')).toEqual({ mode: 'server', serverUrl: 'https://example.com/atelier' });
    expect(server('https://user:pw@example.com:8443')).toEqual({ mode: 'server', serverUrl: 'https://example.com:8443' });
  });

  it.each([
    'http://localhost:7340',
    'http://127.0.0.1:7340',
    'http://[::1]:7340',
    'http://10.0.0.5',
    'http://172.16.4.2',
    'http://172.31.255.1',
    'http://192.168.1.20:7340',
    'http://169.254.10.1',
    'http://100.101.102.103',
    'http://[fd12:3456::1]',
    'http://[fe80::1]',
    'http://nas:7340',
    'http://homelab.local',
    'http://atelier.tail1234.ts.net',
    'http://app.localhost',
  ])('allows plain http on the local network: %s', (url) => {
    expect(server(url).mode).toBe('server');
  });

  it.each(['http://example.com', 'http://172.32.0.1', 'http://8.8.8.8', 'http://[2001:db8::1]', 'http://ts.net.evil.com', 'http://192.169.0.1'])(
    'requires https beyond the local network: %s',
    (url) => {
      expect(() => server(url)).toThrow(/Use https:\/\//);
    },
  );

  it('rejects other schemes and malformed input', () => {
    expect(() => server('ftp://example.com')).toThrow('must start with https:// or http://');
    expect(() => server('ws://localhost:7340')).toThrow('must start with https:// or http://');
    expect(() => server('atelier.example.com')).toThrow('Enter the full server URL');
    expect(() => parseConnection({ mode: 'server' })).toThrow('Choose this computer or enter a server URL.');
    expect(() => parseConnection({ mode: 'cloud' })).toThrow('Choose this computer or enter a server URL.');
    expect(() => parseConnection(null)).toThrow('Choose this computer or enter a server URL.');
  });
});
