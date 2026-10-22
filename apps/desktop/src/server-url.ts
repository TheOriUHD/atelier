/** The Server URL as typed: without a scheme https:// is tried first, then http:// where parseConnection allows it. */
import { parseConnection, type Connection } from './connection.ts';

type ServerConnection = Extract<Connection, { mode: 'server' }>;

/** Whether an Atelier server answers `/api/health` at `serverUrl` within `timeoutMs`. */
export type HealthCheck = (serverUrl: string, timeoutMs: number) => Promise<boolean>;

/** Long enough for a slow TLS handshake, short enough that the http:// try still comes soon. */
export const GUESS_TIMEOUT_MS = 4000;
const TYPED_TIMEOUT_MS = 5000;

export function healthCheck(fetchFn: typeof fetch = fetch): HealthCheck {
  return async (serverUrl, timeoutMs) => {
    try {
      const response = await fetchFn(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok && ((await response.json()) as { ok?: unknown }).ok === true;
    } catch {
      return false;
    }
  };
}

const hasScheme = (text: string) => /^[a-z][a-z\d+.-]*:\/\//i.test(text);

/** Resolves a typed server address to the URL of a server that answers. Throws an error worded for the user. */
export async function resolveServer(typed: string, answers: HealthCheck): Promise<ServerConnection> {
  const text = typed.trim();
  if (!text) throw new Error('Enter the server’s address, for example atelier.example.com or 192.168.1.20:7340.');
  if (hasScheme(text)) {
    const exact = parseConnection({ mode: 'server', serverUrl: text }) as ServerConnection;
    if (!(await answers(exact.serverUrl, TYPED_TIMEOUT_MS))) throw new Error(`No Atelier server answered at ${exact.serverUrl}.`);
    return exact;
  }
  let secure: ServerConnection;
  try {
    secure = parseConnection({ mode: 'server', serverUrl: `https://${text}` }) as ServerConnection;
  } catch {
    throw new Error('Enter the server’s address, for example atelier.example.com or 192.168.1.20:7340.');
  }
  if (await answers(secure.serverUrl, GUESS_TIMEOUT_MS)) return secure;
  let plain: ServerConnection | null;
  try {
    plain = parseConnection({ mode: 'server', serverUrl: `http://${text}` }) as ServerConnection;
  } catch {
    // Plain http beyond the local network isn't allowed, so https was the only try.
    plain = null;
  }
  if (plain && (await answers(plain.serverUrl, GUESS_TIMEOUT_MS))) return plain;
  const where = secure.serverUrl.slice('https://'.length);
  throw new Error(plain ? `No Atelier server answered at ${where}, over https:// or http://.` : `No Atelier server answered at ${secure.serverUrl}.`);
}

/** A connection choice from the renderer: a server's address is resolved over the network, this computer is just parsed. */
export async function resolveConnection(input: unknown, answers: HealthCheck): Promise<Connection> {
  const choice = input as { mode?: unknown; serverUrl?: unknown } | null;
  if (choice?.mode === 'server' && typeof choice.serverUrl === 'string' && choice.serverUrl.length <= 2048) return resolveServer(choice.serverUrl, answers);
  return parseConnection(input);
}
