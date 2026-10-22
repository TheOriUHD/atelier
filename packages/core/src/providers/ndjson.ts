/** Newline-delimited JSON parser over a fetch body. Blank and malformed lines are skipped. */
import { readLines } from './lines.ts';

export async function* parseNDJSON(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  for await (const line of readLines(body, signal)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      yield JSON.parse(trimmed) as unknown;
    } catch {
      // Partial or non-JSON noise (proxies, keep-alives) carries nothing we can use.
    }
  }
}
