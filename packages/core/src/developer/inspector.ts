/**
 * The request inspector (Settings › Admin › Developer): what this backend asked model providers, while an admin has it
 * switched on. Only what a request was — method, address, status, timing, headers with credentials masked, and a
 * failed response's body — never prompts or replies, so it shows no one's conversations.
 */
import { EventEmitter } from 'node:events';
import type { InspectedRequest } from '@atelier/protocol';
import type { ProviderFetch } from '../providers/types.ts';
import { newId } from '../util/ids.ts';

const KEEP = 100;
const MAX_ERROR_BODY = 4096;
/** Header and query parameter names that usually carry credentials. */
const CREDENTIAL = /auth|token|key|secret|cookie|passw/i;

export class RequestInspector extends EventEmitter<{ request: [InspectedRequest] }> {
  private entries: InspectedRequest[] = [];

  constructor(private readonly enabled: () => boolean) {
    super();
  }

  list(): InspectedRequest[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  /** `fetch`, recording each request while the inspector is on. */
  wrap(fetch: ProviderFetch): ProviderFetch {
    return async (url, init) => {
      if (!this.enabled()) return fetch(url, init);
      const started = Date.now();
      const entry: InspectedRequest = {
        id: newId(),
        at: started,
        method: (init.method ?? 'GET').toUpperCase(),
        url: maskUrl(url),
        requestHeaders: maskHeaders(new Headers(init.headers)),
        requestBytes: typeof init.body === 'string' ? Buffer.byteLength(init.body) : null,
        status: null,
        ms: null,
        error: null,
        errorBody: null,
      };
      try {
        const response = await fetch(url, init);
        entry.status = response.status;
        entry.ms = Date.now() - started;
        if (!response.ok) entry.errorBody = (await response.clone().text().catch(() => '')).slice(0, MAX_ERROR_BODY);
        return response;
      } catch (error) {
        entry.ms = Date.now() - started;
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.entries = [entry, ...this.entries].slice(0, KEEP);
        this.emit('request', entry);
      }
    };
  }
}

function maskHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].map(([name, value]) => [name, CREDENTIAL.test(name) ? '••••' : value]));
}

function maskUrl(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return url;
  for (const name of [...parsed.searchParams.keys()]) if (CREDENTIAL.test(name)) parsed.searchParams.set(name, 'redacted');
  parsed.username = parsed.password = '';
  return parsed.toString();
}
