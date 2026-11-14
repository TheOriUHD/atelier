/**
 * The backend's half of a report's diagnostics (ARCHITECTURE §26): this computer, the settings and the person's
 * preferences (redacted), the providers with their state, the local model servers, the connectors. The app adds its
 * own half (the computer it runs on, the window, the main log) before showing all of it to the person.
 */
import type { McpServerStatus, ProviderStatus, ReportDiagnostics, ReportProvider } from '@atelier/protocol';
import { probeInference } from './inference.ts';
import { hostLabel, redactPrefs, redactValue, scrubSecrets, type PrivateWords } from './redact.ts';
import { backendSystem } from './system.ts';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface ProviderLike {
  id: string;
  type: string;
  baseUrl: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  enabled: boolean;
}

export interface CollectDeps {
  kind: 'desktop' | 'server';
  dataDir: string;
  settings: { providers?: ProviderLike[]; imageProviders?: ProviderLike[] } & Record<string, unknown>;
  prefs: unknown;
  providerStatus: readonly ProviderStatus[];
  /** The model ids a provider offers, as the model list has them. */
  models(providerId: string): string[];
  connectors: readonly McpServerStatus[];
  counts(): Record<string, number>;
  dataBytes(): number | undefined;
  fetch: Fetch;
  words: PrivateWords;
}

/** An error message that may name addresses and paths: credentials out, addresses reduced to what they are. */
export function scrubError(text: string, words: PrivateWords): string {
  return scrubSecrets(text, words)
    .replace(/\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>)\]}]+/gi, (url) => {
      try {
        return `${new URL(url).protocol}//${hostLabel(url)}`;
      } catch {
        return '<address>';
      }
    })
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, (ip) => (/^127\./.test(ip) ? ip : '<address>'))
    .slice(0, 400);
}

function provider(p: ProviderLike, deps: CollectDeps): ReportProvider {
  const status = deps.providerStatus.find((s) => s.providerId === p.id);
  const models = deps.models(p.id);
  return {
    type: p.type,
    host: hostLabel(p.baseUrl),
    enabled: p.enabled,
    keySet: Boolean(p.apiKey) || Object.keys(p.headers ?? {}).some((h) => /^(authorization|x-api-key|api-key)$/i.test(h)),
    ...(models.length ? { models: models.slice(0, 60).map((m) => m.slice(0, 160)) } : {}),
    ...(status
      ? {
          status: {
            ok: status.ok,
            ...(status.version ? { version: status.version.slice(0, 80) } : {}),
            ...(status.latencyMs !== null ? { latencyMs: status.latencyMs } : {}),
            modelCount: status.modelCount,
            ...(status.error ? { error: scrubError(status.error, deps.words) } : {}),
          },
        }
      : {}),
  };
}

export async function collectBackendDiagnostics(deps: CollectDeps): Promise<ReportDiagnostics> {
  const providers = deps.settings.providers ?? [];
  const imageProviders = deps.settings.imageProviders ?? [];
  const [system, inference] = await Promise.all([
    backendSystem(deps.dataDir),
    probeInference(
      deps.fetch,
      [...providers, ...imageProviders].filter((p) => p.enabled),
    ).catch(() => []),
  ]);
  const counts = (() => {
    try {
      return deps.counts();
    } catch {
      return undefined;
    }
  })();
  const dataBytes = (() => {
    try {
      return deps.dataBytes();
    } catch {
      return undefined;
    }
  })();
  return {
    collectedAt: Date.now(),
    backend: { ...system, kind: deps.kind, ...(dataBytes !== undefined ? { dataBytes } : {}), ...(counts ? { counts } : {}) },
    settings: redactValue(deps.settings, deps.words),
    ...(deps.prefs ? { prefs: redactPrefs(deps.prefs, deps.words) } : {}),
    providers: providers.slice(0, 40).map((p) => provider(p, deps)),
    imageProviders: imageProviders.slice(0, 40).map((p) => provider(p, deps)),
    ...(inference.length ? { inference } : {}),
    connectors: deps.connectors.slice(0, 80).map((c) => ({
      type: c.type,
      status: c.state,
      tools: c.tools.filter((t) => t.enabled).length,
      ...(c.error ? { error: scrubError(c.error, deps.words) } : {}),
    })),
  };
}
