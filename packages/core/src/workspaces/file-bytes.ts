/**
 * A workspace file's bytes for the browser (Work's image previews and downloads). The runner scopes the path to
 * the workspace; the size cap keeps one answer to a reasonable message.
 */
import type { Workspace } from './workspace.ts';

/** The runner's own cap for one read. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Types the browser may show inline; everything else is served as a download. */
const INLINE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

export class FileBytesError extends Error {}

export async function fileBytes(ws: Workspace, path: string): Promise<{ dataBase64: string; mime: string; size: number }> {
  const stat = await ws.runner.call('fs.stat', { path });
  if (stat.type !== 'file') throw new FileBytesError(`${path} isn’t a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new FileBytesError(`${path} is larger than 16 MB; open it from its folder instead.`);
  const read = await ws.runner.call('fs.read', { path, encoding: 'base64', limit: MAX_FILE_BYTES });
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return { dataBase64: read.content, mime: INLINE_MIME[ext] ?? 'application/octet-stream', size: read.size };
}
