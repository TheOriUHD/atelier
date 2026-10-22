/**
 * What a Code or Work session's frozen system prompt knows about its workspace (ARCHITECTURE §8, §13): the facts
 * for its `<env>` block and the instruction files. Project files are read through the workspace's runner, so they
 * load wherever the project lives.
 */
import type { InstructionFileName } from '@atelier/protocol';
import { loadInstructions, readAncestors, type InstructionFile, type InstructionReader, type LoadOptions } from '../instructions/instructions.ts';
import type { WorkspaceFacts } from '../prompts/env.ts';
import { isTrusted, type Workspace } from './workspace.ts';

export interface CodeContextOptions {
  /** Reads the global files on the backend host. */
  host: InstructionReader;
  /** The backend host's home, for `@~/…` imports in global files. */
  home: string;
  globals: LoadOptions['globals'];
  claudeCode: boolean;
  /** Where the folder lives, in words, for `<env>`. */
  kind: string;
  /** A scratch folder made for this session, which started with no folder. */
  scratch: boolean;
  additionalDirectories: string[];
}

export interface CodeContext {
  workspace: WorkspaceFacts;
  instructions: InstructionFile[];
}

export async function codeContext(ws: Workspace, opts: CodeContextOptions): Promise<CodeContext> {
  const [git, instructions] = await Promise.all([
    ws.runner.call('fs.stat', { path: `${ws.root}${ws.pathSep}.git` }).then(() => true, () => false),
    // The folder's own instruction files are read only once the person trusted it; the global ones always are.
    loadInstructions({ ...opts, ...(isTrusted(ws) ? { workspace: { root: ws.root, home: ws.home, reader: workspaceReader(ws) } } : {}) }),
  ]);
  return {
    workspace: { kind: opts.kind, scratch: opts.scratch, root: ws.root, additionalDirectories: opts.additionalDirectories, git, platform: ws.os, shell: ws.shell },
    instructions,
  };
}

function workspaceReader(ws: Workspace): InstructionReader {
  return {
    read: (path) => ws.runner.call('fs.read', { path }).then((r) => (r.binary ? null : r.content), () => null),
    readAncestors: (from, names) => readAncestors((list) => ws.runner.call('fs.readAncestors', { from, names: list }).then((r) => r.files), names as InstructionFileName[]),
    listMarkdown: (dir) => ws.runner.call('fs.glob', { pattern: '**/*.md', cwd: dir, limit: 200 }).then((r) => r.files, () => []),
  };
}
