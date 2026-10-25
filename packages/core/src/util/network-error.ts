/**
 * Network failures as the person reads them: fetch's "fetch failed" hides the reason in its causes (`ECONNREFUSED`
 * and the like), which these find and put in words.
 */

/** What a connection's network error code means for the person. */
export const NETWORK_FAILURES: Record<string, string> = {
  ECONNREFUSED: 'nothing answers there (connection refused)',
  ENOTFOUND: "that name doesn't resolve",
  EAI_AGAIN: "that name doesn't resolve right now",
  EHOSTUNREACH: 'that host is unreachable',
  ENETUNREACH: 'that network is unreachable',
  EHOSTDOWN: 'that host is down',
  ETIMEDOUT: 'it took too long to answer',
  UND_ERR_CONNECT_TIMEOUT: 'it took too long to answer',
  ECONNRESET: 'the connection was reset',
  DEPTH_ZERO_SELF_SIGNED_CERT: "its certificate isn't trusted (self-signed)",
  SELF_SIGNED_CERT_IN_CHAIN: "its certificate isn't trusted (self-signed)",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its certificate isn't trusted",
  CERT_HAS_EXPIRED: 'its certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: "its certificate is for another name",
};

/** The network error code somewhere in `error`'s causes (fetch's "fetch failed" carries it there), or null. */
export function networkCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object' || depth > 6) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && Object.hasOwn(NETWORK_FAILURES, code)) return code;
  // Several addresses tried at once (IPv4 and IPv6) fail as one AggregateError.
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = networkCode(inner, depth + 1);
      if (found) return found;
    }
  }
  return networkCode((error as { cause?: unknown }).cause, depth + 1);
}

/** What went wrong reaching an address, in words, or null when it wasn't the network. */
export function networkFailure(error: unknown): string | null {
  const code = networkCode(error);
  return code ? NETWORK_FAILURES[code]! : null;
}
