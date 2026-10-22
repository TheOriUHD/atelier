/**
 * Every reader of settings, extensions and instruction files goes through WorkspaceFs, so project
 * layers work the same whether the project lives locally, on an SSH host or in a codespace.
 * The Node implementation serves the backend host; the runner implementation arrives with workspaces.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

export interface WorkspaceFs {
  /** File contents, or null when the file does not exist. */
  read(path: string): Promise<string | null>;
  /** Atomic write (temp file + rename), creating parent directories. */
  write(path: string, content: string): Promise<void>;
  list(dir: string): Promise<DirEntry[]>;
  /** Calls `onChange` (debounced per path) when any of the paths change, appear or disappear. */
  watch(paths: string[], onChange: (path: string) => void): () => void;
}

export class NodeWorkspaceFs implements WorkspaceFs {
  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, content, { mode: 0o644 });
    await rename(tmp, path);
  }

  async list(dir: string): Promise<DirEntry[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() || e.isDirectory() || e.isSymbolicLink())
        .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  watch(paths: string[], onChange: (path: string) => void): () => void {
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = chokidarWatch(paths, { ignoreInitial: true, followSymlinks: true, awaitWriteFinish: { stabilityThreshold: 80 } });
    const fire = (path: string) => {
      clearTimeout(timers.get(path));
      timers.set(path, setTimeout(() => onChange(path), 50));
    };
    watcher.on('add', fire).on('change', fire).on('unlink', fire);
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      void watcher.close();
    };
  }
}
