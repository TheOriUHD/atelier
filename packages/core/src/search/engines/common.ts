import type { Attempt, Fetcher } from '../types.ts';

export const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const BROWSER_HEADERS = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' };

/** How long one attempt may take before the next engine gets a turn. */
const ATTEMPT_MS = 9_000;

const OFFLINE = /ENOTFOUND|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/;

export function describeFailure(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  return `${(error as Error)?.message ?? ''} ${cause?.code ?? ''} ${cause?.message ?? ''}`.trim();
}

/** One page: its status and text, or the attempt that explains why there is none. */
export async function page(
  fetch: Fetcher,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ status: number; body: string; headers: Headers } | { failed: Attempt }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_MS)]) });
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch (error) {
    if (signal.aborted) throw error;
    const text = describeFailure(error);
    if (OFFLINE.test(text)) return { failed: { outcome: 'offline' } };
    return { failed: { outcome: 'error', reason: /timeout|abort/i.test(text) ? 'timed out' : text || 'the request failed' } };
  }
}

/** HTTP statuses that mean "go away" rather than "something broke". */
export function limited(status: number): boolean {
  return status === 202 || status === 403 || status === 418 || status === 429 || status === 503;
}
