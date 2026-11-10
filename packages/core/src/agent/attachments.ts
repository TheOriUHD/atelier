/**
 * Files attached to a message, put where the agent's tools reach them. In a session with a folder (Code and Cowork) a
 * file the person attached was only ever shown to the model as its text, and a file with none (a ZIP, a model file,
 * a spreadsheet) not at all, though the agent could have unpacked or opened it with its tools. Each attached file now
 * goes into the folder when the message is sent: in a scratch folder (a session started with no folder) in its root,
 * in a project under `.atelier/attachments/`, which a `.gitignore` there keeps out of git. The part records where, and
 * the model is told.
 *
 * A file whose name is taken by another gets ` (2)`, ` (3)`, …; the same file sent again keeps its place.
 */
import { createHash } from 'node:crypto';
import { RpcError, RunnerErrorCode, type DocumentPart, type Part } from '@atelier/protocol';
import { toBase64 } from '../providers/util.ts';
import type { Workspace } from '../workspaces/workspace.ts';

/** Where attachments go in a project folder (relative to its root). */
export const ATTACHMENTS_DIR = '.atelier/attachments';
const MAX_TRIES = 50;

/** A name safe to write in any folder: the last part of what was attached, without what the file systems refuse. */
export function attachmentName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  // Control characters out, spaces around it and dots at its end (Windows drops them); a name of only dots would be a
  // folder, not a file.
  // eslint-disable-next-line no-control-regex -- control characters aren't allowed in names.
  const clean = last.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim().replace(/[.\s]+$/, '').slice(0, 180);
  return /^\.*$/.test(clean) ? 'attachment' : clean;
}

/** `report.pdf`, `report (2).pdf`, `report (3).pdf`, … */
export function numbered(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

const conflict = (e: unknown) => e instanceof RpcError && e.code === RunnerErrorCode.Conflict;

/**
 * `parts` with each attached file put into the workspace and its `path` set (relative to the folder's root). Parts that
 * have a path already are left as they are; a file that can't be written keeps none (the model is then told it has no
 * copy in the folder).
 */
export async function placeAttachments(
  workspace: Pick<Workspace, 'runner'>,
  opts: { scratch: boolean; read(blob: string): Promise<Uint8Array>; signal?: AbortSignal; onError?(name: string, error: unknown): void },
  parts: Part[],
): Promise<Part[]> {
  if (!parts.some((p) => p.type === 'document' && !p.path)) return parts;
  const dir = opts.scratch ? '' : `${ATTACHMENTS_DIR}/`;
  const call = (path: string, content: string, expectSha256: string, encoding: 'utf8' | 'base64') =>
    workspace.runner.call('fs.write', { path, content, encoding, expectSha256, mkdirp: true }, opts.signal ? { signal: opts.signal } : {});
  if (dir) {
    // Once: git leaves the folder alone.
    await call(`${dir}.gitignore`, '*\n', '', 'utf8').catch((e: unknown) => {
      if (!conflict(e)) throw e;
    });
  }
  const out: Part[] = [];
  for (const part of parts) {
    if (part.type !== 'document' || part.path) {
      out.push(part);
      continue;
    }
    out.push(await place(part).catch((e: unknown) => (opts.onError?.(part.name, e), part)));
  }
  return out;

  async function place(part: DocumentPart): Promise<DocumentPart> {
    const bytes = await opts.read(part.blob);
    const content = toBase64(bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const name = attachmentName(part.name);
    for (let n = 1; n <= MAX_TRIES; n++) {
      const path = `${dir}${numbered(name, n)}`;
      try {
        await call(path, content, '', 'base64');
        return { ...part, path };
      } catch (e) {
        if (!conflict(e)) throw e;
      }
      // Taken: by this same file (sent before), which keeps its place, or by another.
      try {
        await call(path, content, sha, 'base64');
        return { ...part, path };
      } catch (e) {
        if (!conflict(e)) throw e;
      }
    }
    throw new Error(`no free name for ${name}`);
  }
}
