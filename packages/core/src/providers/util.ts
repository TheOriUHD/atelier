/**
 * Small, dependency-free helpers shared by the adapters: narrowing of untyped JSON, URL joining, base64 and ids.
 * Kept platform-neutral (no Buffer) so adapters run in Node and the browser alike.
 */
import { jsonrepair } from 'jsonrepair';
import { escapeTags, type DocumentPart, type Part } from '@atelier/protocol';
import { escapeAttr } from '../prompts/escape.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a record, or an empty record, for optional-chaining-free field access on untyped JSON. */
export function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function strings(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === 'string');
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

export function newCallId(): string {
  return `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** Parse JSON, repairing common model mistakes (trailing commas, single quotes, unclosed braces). */
export function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    try {
      return { ok: true, value: JSON.parse(jsonrepair(text)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Tool input from a JSON string; an empty string means "no arguments". */
export function parseToolInput(json: string): unknown {
  if (json.trim() === '') return {};
  const parsed = parseJsonLoose(json);
  return parsed.ok ? parsed.value : {};
}

function trimSlashes(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Join an OpenAI-style `/v1/...` path onto a base URL that may already carry a version segment
 * (`…/v1`, `…/api/v1`, `…/v1beta/openai`), so the version is never doubled.
 */
export function apiUrl(baseUrl: string, path: string): string {
  const base = trimSlashes(baseUrl);
  let pathname = base;
  try {
    pathname = new URL(base).pathname;
  } catch {
    // not an absolute URL; inspect the raw string
  }
  const versioned = /\/v\d+[a-z0-9]*(\/|$)/i.test(pathname);
  return versioned ? base + path.replace(/^\/v\d+(?=\/)/, '') : base + path;
}

/** Join a server-root path (`/props`, `/api/chat`) onto a base URL, dropping a trailing `/v1` users often paste. */
export function rootUrl(baseUrl: string, path: string): string {
  return trimSlashes(baseUrl).replace(/\/v1$/, '') + path;
}

/** Visible text and hidden context of a message, in order. */
export function textOf(parts: readonly Part[]): string {
  return parts
    .flatMap((p) => (p.type === 'text' || p.type === 'context' ? [p.text] : []))
    .filter((t) => t !== '')
    .join('\n\n');
}

const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript|x-sh|toml|csv|sql|markdown))/;

/** Inline text documents for providers without a document input type; other formats get a short placeholder. */
export function documentAsText(part: DocumentPart, bytes: Uint8Array): string {
  if (TEXT_MIME.test(part.mime)) {
    return `<document name="${escapeAttr(part.name)}">\n${escapeTags(new TextDecoder().decode(bytes))}\n</document>`;
  }
  return `[Attached file "${part.name}" (${part.mime}) is not supported by this model.]`;
}

export function isTextDocument(mime: string): boolean {
  return TEXT_MIME.test(mime);
}

/** `Promise.all` with bounded concurrency. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
