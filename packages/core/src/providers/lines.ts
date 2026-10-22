/**
 * Decodes a byte stream into lines, accepting LF, CRLF and lone CR terminators split anywhere across chunks
 * (including inside a multi-byte UTF-8 sequence or between the CR and LF of a CRLF).
 */

/** Split complete lines off `buffer`; a trailing CR is held back unless `final`, since an LF may follow. */
export function splitLines(buffer: string, final: boolean): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < buffer.length) {
    const c = buffer.charCodeAt(i);
    if (c === 10) {
      lines.push(buffer.slice(start, i));
      start = ++i;
    } else if (c === 13) {
      if (i + 1 === buffer.length && !final) break;
      lines.push(buffer.slice(start, i));
      i += buffer.charCodeAt(i + 1) === 10 ? 2 : 1;
      start = i;
    } else {
      i++;
    }
  }
  const rest = buffer.slice(start);
  if (final && rest !== '') return { lines: [...lines, rest], rest: '' };
  return { lines, rest };
}

/**
 * Yield lines from a response body. Leaving the loop early (break/return) cancels the body so the
 * connection is released; an aborted `signal` stops reading with an AbortError.
 */
export async function* readLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let exhausted = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const { lines, rest } = splitLines(buffer, false);
      buffer = rest;
      yield* lines;
    }
    exhausted = true;
    buffer += decoder.decode();
    yield* splitLines(buffer, true).lines;
  } finally {
    if (!exhausted) reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
