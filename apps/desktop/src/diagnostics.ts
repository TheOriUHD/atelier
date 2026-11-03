/**
 * What the window asks main for when someone presses "Copy diagnostics": the versions only main knows, the end of the
 * main log, and the words that identify this computer, so the window can hide them wherever they appear. Main sends
 * the raw lines; the window redacts them (packages/ui/src/lib/diagnostics.ts) before anything is copied, and nothing
 * here goes anywhere else.
 */
import { z } from 'zod';

/** The request is validated like every other IPC message: a window can only ask for a bounded number of lines. */
export const DiagnosticsRequest = z.object({ lines: z.number().int().min(1).max(500).default(100) }).default({ lines: 100 });

export interface DesktopDiagnostics {
  arch: string;
  electron: string;
  chrome: string;
  packaged: boolean;
  log: string[];
  /** Account name, computer name and home folder. */
  privateStrings: string[];
  /** The app's own folders, the only places a path may be named. */
  appFolders: string[];
}

export interface DiagnosticsSources {
  versions: { electron?: string; chrome?: string };
  arch: string;
  packaged: boolean;
  readLog(lines: number): string[];
  username(): string;
  hostname(): string;
  home(): string;
  folders(): string[];
}

export function collectDesktopDiagnostics(input: unknown, sources: DiagnosticsSources): DesktopDiagnostics {
  const { lines } = DiagnosticsRequest.parse(input);
  const safe = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  return {
    arch: sources.arch,
    electron: sources.versions.electron ?? '',
    chrome: sources.versions.chrome ?? '',
    packaged: sources.packaged,
    log: safe(() => sources.readLog(lines), []),
    privateStrings: [safe(sources.home, ''), safe(sources.username, ''), safe(sources.hostname, '')].filter((s) => s.length >= 3),
    appFolders: safe(sources.folders, []).filter((f) => f.length > 3),
  };
}
