/** The files a Work task produced, and how each one opens: previewed here, shown in its folder, or downloaded. */
import type { Message, WorkspaceSummary } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { desktop } from '../../lib/platform.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { downloadBlob } from '../artifacts/artifact-files.ts';
import { toolResults } from '../chat/turns.ts';
import { asRecord, str } from '../code/tool-cards.tsx';

export interface OutputFile {
  /** Relative to the folder, `/`-separated. */
  path: string;
  name: string;
}

/** `path` relative to `root`, or null when it lies outside it. Tools usually get absolute paths. */
export function inFolder(path: string, root: string): string | null {
  if (!path) return null;
  const absolute = /^([\\/]|[A-Za-z]:[\\/])/.test(path);
  if (absolute && !(path.startsWith(root) && /[\\/]/.test(path[root.length] ?? ''))) return null;
  const parts = (absolute ? path.slice(root.length + 1) : path).split(/[\\/]+/).filter((p) => p && p !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}

/** Files Write and Edit changed in the folder, each once where it last changed (newest last). Failed or unanswered calls don't count. */
export function outputFiles(messages: readonly Message[], root: string): OutputFile[] {
  const results = toolResults(messages);
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type !== 'tool_call' || (part.name !== 'Write' && part.name !== 'Edit')) continue;
      const result = results.get(part.id);
      const path = result && !result.isError && inFolder(str(asRecord(part.input).file_path), root);
      if (!path) continue;
      paths.delete(path);
      paths.add(path);
    }
  }
  return [...paths].map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) }));
}

/** What the latest request started: everything after the person's last message (a hook's hidden feedback continues the run). */
export function latestRun(messages: readonly Message[]): readonly Message[] {
  const last = messages.findLastIndex((m) => m.role === 'user' && !m.parts.every((p) => p.type === 'context'));
  return messages.slice(last + 1);
}

export type FileKind = 'image' | 'markdown' | 'text' | 'other';

const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
/** Files with no text to show: office documents, PDFs, archives, media. Anything else is tried as text. */
const BINARY = new Set([
  ...['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'pdf', 'rtf', 'epub'],
  ...['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm', 'ico', 'heic', 'tiff', 'psd', 'sqlite', 'db', 'woff2', 'ttf'],
]);

export const extension = (name: string) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

export function fileKind(name: string): FileKind {
  const ext = extension(name);
  if (IMAGES.has(ext)) return 'image';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return BINARY.has(ext) ? 'other' : 'text';
}

/** The desktop app can show a file in Finder / Explorer when its folder is on this computer. */
export function canReveal(workspace: WorkspaceSummary): boolean {
  return !!desktop && workspace.kind === 'local' && (workspace.deviceId === null || workspace.deviceId === desktop.device.id);
}

/** Opening a file: a preview here, or for documents without one, its folder (desktop) or a download. */
export function openAction(file: OutputFile, workspace: WorkspaceSummary): 'preview' | 'reveal' | 'download' {
  return fileKind(file.name) !== 'other' ? 'preview' : canReveal(workspace) ? 'reveal' : 'download';
}

export function absolutePath(workspace: WorkspaceSummary, path: string): string {
  const sep = workspace.root.includes('\\') ? '\\' : '/';
  return `${workspace.root}${sep}${path.replaceAll('/', sep)}`;
}

/** Shows the file in its folder (desktop, this computer) or downloads it. */
export async function saveFile(workspace: WorkspaceSummary, file: OutputFile): Promise<void> {
  try {
    if (canReveal(workspace)) {
      if (!(await desktop!.files.reveal(absolutePath(workspace, file.path)))) toast.error(`${file.name} isn’t in a folder you opened on this computer.`);
      return;
    }
    const { dataBase64, mime } = await rpc().call('workspaces.fileBytes', { workspaceId: workspace.id, path: file.path });
    downloadBlob(file.name, new Blob([Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0))], { type: mime }));
  } catch (e) {
    toast.error(describeError(e).message);
  }
}
