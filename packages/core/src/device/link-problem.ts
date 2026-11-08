/**
 * Why the relay can't reach the server, in words for the person looking at "Connecting to …". The WebSocket the relay
 * opens reports nothing but "failed", so after a couple of failures one plain HTTP request to the same address finds
 * out what is wrong: unreachable, refused, no such name, a certificate, or a server that answers but won't upgrade.
 */
export interface LinkProblem {
  code: string;
  message: string;
  /** macOS's Local Network switch for Atelier would fix it: the app can open that settings pane. */
  localNetwork?: boolean;
}

const CERTIFICATE = /^(?:CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(?:VERIFY|GET)|ERR_TLS_CERT|ERR_SSL)/;

/** The problem behind a failed request (`fetch` hides the system's error in `cause`). */
export function describeFailure(error: unknown, serverUrl: string, platform: string = process.platform): LinkProblem {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: string } | null)?.code ?? 'UNKNOWN';
  const host = URL.parse(serverUrl)?.host ?? serverUrl;
  if (platform === 'darwin' && (code === 'EHOSTUNREACH' || code === 'EPERM' || code === 'EACCES')) {
    return {
      code,
      localNetwork: true,
      message: `macOS isn't letting Atelier reach ${host}. If it is on your local network, switch Atelier on under System Settings › Privacy & Security › Local Network.`,
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code, message: `There is no server named ${host} on this network. Check the address, and that you are online.` };
  if (code === 'ECONNREFUSED') return { code, message: `${host} refused the connection. Is the server running, and is the port right?` };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || (error as Error | null)?.name === 'TimeoutError') return { code, message: `${host} didn't answer in time.` };
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return { code, message: `${host} can't be reached from this computer's network.` };
  if (CERTIFICATE.test(code)) return { code, message: `${host}'s security certificate isn't trusted (${code}).` };
  return { code, message: `Couldn't connect to ${host}${cause?.message ? `: ${cause.message}` : ''}.` };
}

/** One plain request to the server's health check: either what is wrong with the way there, or with the live connection. */
export async function diagnose(serverUrl: string, fetchFn: typeof fetch = fetch, platform: string = process.platform): Promise<LinkProblem> {
  try {
    const res = await fetchFn(`${serverUrl.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(6000), redirect: 'manual' });
    if (res.ok) {
      return { code: 'WEBSOCKET', message: 'The server answers, but refuses the live connection. If it sits behind a proxy, the proxy has to pass WebSockets, and the address in the proxy and in Atelier must match.' };
    }
    return { code: `HTTP_${res.status}`, message: `The address answered HTTP ${res.status}, which is not an Atelier server's health check. Check the address.` };
  } catch (error) {
    return describeFailure(error, serverUrl, platform);
  }
}
