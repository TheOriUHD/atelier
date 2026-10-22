/**
 * How the desktop app reaches a backend (ARCHITECTURE §21): the one it runs itself, or an Atelier server.
 * Choices from the renderer and from connection.json both pass through parseConnection.
 */
import { isIP } from 'node:net';
import { z } from 'zod';

export type Connection = { mode: 'local' } | { mode: 'server'; serverUrl: string };

const Choice = z.discriminatedUnion('mode', [z.object({ mode: z.literal('local') }), z.object({ mode: z.literal('server'), serverUrl: z.string().max(2048) })]);

/** Validates a connection choice and normalizes the server URL. Throws an error worded for the user. */
export function parseConnection(input: unknown): Connection {
  const choice = Choice.safeParse(input);
  if (!choice.success) throw new Error('Choose this computer or enter a server URL.');
  if (choice.data.mode === 'local') return { mode: 'local' };
  let url: URL;
  try {
    url = new URL(choice.data.serverUrl.trim());
  } catch {
    throw new Error('Enter the full server URL, for example https://atelier.example.com.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The server URL must start with https:// or http://.');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error(`Use https:// for ${url.hostname}. Plain http:// is only allowed for this computer, your local network and Tailscale (*.ts.net).`);
  }
  return { mode: 'server', serverUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** Hosts that plain http can reach without crossing the internet: loopback, private LAN, link-local, Tailscale. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (isIP(host) === 4) {
    const [a, b = 0] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  // Single-label names (localhost, nas) only resolve on the local network.
  return !host.includes('.') || /\.(localhost|local|ts\.net)$/.test(host);
}
