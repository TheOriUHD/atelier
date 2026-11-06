/**
 * How a stored file is served to a page (ARCHITECTURE §23): the one policy behind the web server's `/api/blobs/<hash>` and the
 * desktop app's `atelier-blob://` protocol, so the two can't drift apart. Only common picture, video and sound types render
 * inline; everything else is a download. Every answer is sandboxed and `nosniff`, so a file can never run as a page.
 * Videos need byte ranges to play and to seek, so `Range` is answered with `206`, in pieces of at most `RANGE_CHUNK_BYTES`
 * (a player asks for more as it needs it; nothing has to read a whole 500 MB file into memory to start playing).
 */

/** Types a page may show inline. A video must be MP4 or WebM, the containers `checkVideo` lets in; a sound one of the formats `checkAudio` does. */
export const INLINE_BLOB_TYPES = /^(?:image\/(?:png|jpeg|gif|webp|avif)|video\/(?:mp4|webm)|audio\/(?:mpeg|wav|ogg|flac|mp4|aac|webm))$/;

/** The most one `206` carries. */
export const RANGE_CHUNK_BYTES = 16 * 1024 * 1024;

/** What a `Range` header asks for, resolved against the file's size. `unsatisfiable` is a `416`; null means "send it all". */
export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * One `bytes=a-b`, `bytes=a-` or `bytes=-n` range. Several ranges, another unit or a malformed header are ignored, which
 * HTTP allows: the whole file goes out instead. `end` is inclusive and never past the chunk limit.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    // The last n bytes.
    const last = Number(match[2]);
    if (last === 0) return 'unsatisfiable';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end: Math.min(end, start + RANGE_CHUNK_BYTES - 1) };
}

/** What a `Response` takes as its body. */
type Body = NonNullable<ConstructorParameters<typeof Response>[0]>;

export interface BlobSource {
  mime: string;
  size: number;
  /** The whole file. */
  whole(): Body | Promise<Body>;
  /** Bytes `start` to `end`, inclusive. */
  slice(start: number, end: number): Body | Promise<Body>;
}

/** The headers every stored file goes out with. */
export function blobHeaders(mime: string): Record<string, string> {
  const inline = INLINE_BLOB_TYPES.test(mime);
  return {
    'Content-Type': inline ? mime : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
}

/** The answer to a request for a stored file, whole or a range of it. `extra` adds headers (caching, CORS). */
export async function blobResponse(source: BlobSource, rangeHeader: string | null | undefined, extra: Record<string, string> = {}): Promise<Response> {
  const headers = { ...blobHeaders(source.mime), ...extra };
  const range = parseByteRange(rangeHeader, source.size);
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${source.size}` } });
  if (range === null) return new Response(await source.whole(), { status: 200, headers: { ...headers, 'Content-Length': String(source.size) } });
  return new Response(await source.slice(range.start, range.end), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${source.size}`, 'Content-Length': String(range.end - range.start + 1) },
  });
}
