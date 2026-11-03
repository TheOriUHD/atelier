/**
 * A zip written as it is read: entries come in one at a time and the archive's bytes go out in chunks, so exporting a
 * person's data never holds the archive, or more than a chunk of any file, in memory.
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export interface ZipEntry {
  /** Path inside the archive. */
  name: string;
  data: Uint8Array | AsyncIterable<Uint8Array>;
  /** False for what is compressed already (pictures, PDFs): stored as it is. */
  compress: boolean;
}

export async function* zipStream(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  let failure: unknown;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else out.push(chunk);
  });
  const drain = function* (): Generator<Uint8Array> {
    if (failure) throw failure;
    while (out.length) yield out.shift()!;
  };
  for await (const entry of entries) {
    const file = entry.compress ? new ZipDeflate(entry.name, { level: 6 }) : new ZipPassThrough(entry.name);
    zip.add(file);
    if (entry.data instanceof Uint8Array) {
      file.push(entry.data, true);
      yield* drain();
      continue;
    }
    for await (const chunk of entry.data) {
      file.push(chunk, false);
      yield* drain();
    }
    file.push(new Uint8Array(), true);
    yield* drain();
  }
  zip.end();
  yield* drain();
}
