/**
 * Code-mode tools (ARCHITECTURE §8): Claude Code's Read, Write, Edit, Glob, Grep, Bash, BashOutput and
 * KillShell, with its tool and parameter names, running against a workspace's runner. Runner errors
 * (outside the workspace, missing file, …) are thrown with the runner's message; the loop reports them.
 */
import type { BlobStore } from '../../store/blobs.ts';
import type { Workspace } from '../../workspaces/workspace.ts';
import type { Tool } from '../types.ts';
import { createBashTools, type BackgroundCommands } from './bash.ts';
import { createFileTools, type Checkpoint } from './files.ts';
import { createSearchTools } from './search.ts';

export interface CodeToolDeps {
  /** Where Read stores images it returns (tool results reference images by blob). Without it Read describes the image in text. */
  blobs?: Pick<BlobStore, 'put'>;
  /** Keeps a file's content before Write or Edit changes it, for Rewind. */
  checkpoint?: Checkpoint;
  /** Told about background commands, for the Background tasks pane. */
  background?: BackgroundCommands;
}

export function createCodeTools(workspace: Workspace, deps: CodeToolDeps = {}): Tool[] {
  return [...createFileTools(workspace, deps.blobs, deps.checkpoint), ...createSearchTools(workspace), ...createBashTools(workspace, deps.background)];
}
