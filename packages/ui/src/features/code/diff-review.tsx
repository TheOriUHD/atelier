/**
 * The Diff pane (design/components.md › DiffReview): a list toggle and the compare selector ("main → working tree") in
 * its header; the git bar, the changed files (when listed) and each changed file as a collapsible card (36px header:
 * stage checkbox, path, status, +/− counts) over its part of the diff, with Reject on each hunk of a working-tree diff.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, List, RefreshCw } from 'lucide-react';
import type { DiffCompare, GitFileStatus, WorkspaceSummary } from '@atelier/protocol';
import { Button, Checkbox, DiffStat, IconButton, Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger, Spinner, cn } from '../../components/ui/index.ts';
import { keys, useGitStatus, useWorkspaceDiff } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Chevron } from '../chat/parts.tsx';
import { PaneMessage } from './file-tree.tsx';
import { GitBar, useGitAction, type GitAction } from './git-bar.tsx';
import { InlineDiff, hunkPatch, parseUnifiedDiff, type FileDiff } from './inline-diff.tsx';
import { PaneFrame, type PaneFrameState } from './pane-dock.tsx';
import { languageOf } from './paths.ts';

const STATUS_LETTER: Record<GitFileStatus['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!',
};

export interface CompareOption {
  value: DiffCompare;
  label: string;
  description: string;
}

/**
 * What the Diff pane can compare the working tree with, labelled the way the selector reads ("main → working tree").
 * Outside a git repository only the session's own changes can be shown.
 */
export function compareOptions({ repo, branch, defaultBranch }: { repo: boolean; branch: string | null; defaultBranch: string | null }): CompareOption[] {
  const session: CompareOption = { value: 'session', label: 'Session start → working tree', description: 'What this session’s edits changed' };
  if (!repo) return [session];
  const head = branch ?? 'HEAD';
  return [
    { value: 'head', label: `${head} → working tree`, description: 'Changes not committed yet' },
    { value: 'staged', label: `${head} → staged`, description: 'What the next commit takes' },
    ...(defaultBranch && defaultBranch !== branch ? [{ value: 'base' as const, label: `${defaultBranch} → working tree`, description: `Everything since this branch left ${defaultBranch}` }] : []),
    session,
  ];
}

export function DiffPane({ frame, workspace, sessionId }: { frame: PaneFrameState; workspace: WorkspaceSummary | undefined; sessionId: string }) {
  const qc = useQueryClient();
  const usable = workspace?.available ? workspace : null;
  const git = useGitStatus(usable?.id);
  const [picked, setCompare] = useState<DiffCompare | null>(null);
  const [showFiles, setShowFiles] = useState(true);
  const repo = !!git.data;
  // Outside a repository there is only the session's own changes to show.
  const compare = git.data === null ? 'session' : (picked ?? 'head');
  const branches = useQuery({
    queryKey: [...keys.workspace(usable?.id ?? ''), 'branches'],
    queryFn: () => rpc().call('git.branches', { workspaceId: usable!.id }),
    enabled: repo,
  });
  const options = compareOptions({ repo, branch: git.data?.branch ?? null, defaultBranch: branches.data?.defaultBranch ?? null });
  const current = options.find((o) => o.value === compare) ?? options[0]!;

  return (
    <PaneFrame
      frame={frame}
      title="Diff"
      start={
        usable && (
          <>
            <IconButton icon={List} label="Changed files" size="xs" aria-pressed={showFiles} className="text-fg-secondary aria-pressed:text-fg" onClick={() => setShowFiles((s) => !s)} />
            <Menu>
              <MenuTrigger
                aria-label={`Compare: ${current.label}`}
                render={<Button size="xs" variant="ghost" trailingIcon={ChevronDown} className="min-w-0 text-fg-secondary" />}
              >
                <span className="truncate font-mono text-code">{current.label}</span>
              </MenuTrigger>
              <MenuContent className="w-72">
                <MenuRadioGroup value={compare} onValueChange={(v: DiffCompare) => setCompare(v)}>
                  {options.map((o) => (
                    <MenuRadioItem key={o.value} value={o.value} description={o.description} closeOnClick>
                      <span className="font-mono text-code">{o.label}</span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          </>
        )
      }
      menu={
        usable && (
          <MenuItem icon={RefreshCw} onClick={() => void qc.invalidateQueries({ queryKey: keys.workspace(usable.id) })}>
            Refresh
          </MenuItem>
        )
      }
    >
      {usable ? (
        <DiffView workspaceId={usable.id} sessionId={sessionId} compare={compare} showFiles={showFiles} />
      ) : (
        <PaneMessage>{workspace ? 'This folder’s computer is offline.' : 'This session has no folder.'}</PaneMessage>
      )}
    </PaneFrame>
  );
}

/** A changed file as the cards and the list show it. */
interface Changed {
  path: string;
  status: GitFileStatus['status'];
  /** null where staging doesn't apply (the session's or the branch's changes). */
  staged: boolean | null;
  diff: FileDiff | undefined;
}

function statusOf(diff: FileDiff): GitFileStatus['status'] {
  if (/^new file mode/m.test(diff.header)) return 'added';
  if (/^deleted file mode/m.test(diff.header)) return 'deleted';
  if (/^rename from/m.test(diff.header)) return 'renamed';
  return 'modified';
}

/** The git bar and the diff for one compare: the pane's body. */
export function DiffView({ workspaceId, sessionId, compare = 'head', showFiles = false }: { workspaceId: string; sessionId?: string; compare?: DiffCompare; showFiles?: boolean }) {
  const git = useGitStatus(workspaceId);
  const diff = useWorkspaceDiff(workspaceId, compare, sessionId);
  const action = useGitAction(workspaceId);
  const parsed = useMemo(() => parseUnifiedDiff(diff.data?.diff ?? ''), [diff.data]);

  const error = git.error ?? diff.error;
  if (error) return <PaneMessage error>{describeError(error).message}</PaneMessage>;
  if (git.data === undefined || !diff.data) return <Spinner label="Loading changes" className="m-4 text-fg-muted" />;
  const status = git.data;
  const byPath = new Map(parsed.map((f) => [f.path, f]));
  // Against HEAD, git status says what changed (untracked and conflicted files too); otherwise the diff does.
  const changed: Changed[] =
    compare === 'head' && status
      ? status.files.map((f) => ({ path: f.path, status: f.status, staged: f.staged, diff: byPath.get(f.path) }))
      : parsed.map((d) => ({ path: d.path, status: statusOf(d), staged: compare === 'staged' ? true : null, diff: d }));
  const stageable = changed.filter((f) => f.staged !== null);
  const staged = stageable.filter((f) => f.staged);
  const stage = (paths: string[], next: boolean) => void action.run('stage', () => rpc().call('git.stage', { workspaceId, paths, staged: next }));
  // Rejecting reverses a hunk in the working tree: only for diffs that end there.
  const rejectable = compare === 'head' || compare === 'session';

  return (
    <>
      {status && <GitBar workspaceId={workspaceId} status={status} git={action} />}
      {changed.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <PaneMessage>No changes to show</PaneMessage>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
          <div className="flex h-6 shrink-0 items-center gap-2.5 px-3 text-footnote text-fg-muted">
            {stageable.length > 0 && (
              <Checkbox
                aria-label={staged.length === stageable.length ? 'Unstage all' : 'Stage all'}
                checked={staged.length === stageable.length}
                indeterminate={staged.length > 0 && staged.length < stageable.length}
                disabled={action.pending !== null}
                onCheckedChange={(next) => stage((next ? stageable.filter((f) => !f.staged) : stageable).map((f) => f.path), next)}
              />
            )}
            {changed.length} changed {changed.length === 1 ? 'file' : 'files'}
            {staged.length > 0 && compare === 'head' && ` · ${staged.length} staged`}
          </div>
          {showFiles && <FileList files={changed} />}
          {changed.map((f) => (
            <FileCard key={f.path} workspaceId={workspaceId} file={f} action={action} rejectable={rejectable} onStage={(next) => stage([f.path], next)} />
          ))}
          {diff.data.truncated && <PaneMessage>The diff is too large to show in full.</PaneMessage>}
        </div>
      )}
    </>
  );
}

const cardId = (path: string) => `diff-file-${path.replace(/[^\w-]/g, '_')}`;

/** The changed files at a glance; each jumps to its card. */
function FileList({ files }: { files: Changed[] }) {
  return (
    <nav aria-label="Changed files" className="shrink-0 rounded-xl py-1 inset-ring inset-ring-line">
      <ul>
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => document.getElementById(cardId(f.path))?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
              className="flex h-7 w-full items-center gap-2 px-3 text-left text-control-sm text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg"
            >
              <span title={f.status} className="w-3 shrink-0 text-center font-mono text-caption text-fg-muted">
                {STATUS_LETTER[f.status]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-code">{f.path}</span>
              {f.diff && !f.diff.binary && <DiffStat added={f.diff.added} removed={f.diff.removed} />}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FileCard({ workspaceId, file, action, rejectable, onStage }: { workspaceId: string; file: Changed; action: GitAction; rejectable: boolean; onStage(staged: boolean): void }) {
  const [open, setOpen] = useState(true);
  const { diff } = file;
  return (
    <section id={cardId(file.path)} aria-label={file.path} className="shrink-0 scroll-mt-3 overflow-hidden rounded-xl inset-ring inset-ring-line">
      <div className={cn('flex h-9 items-center gap-2.5 hover:bg-fill-ghost-hover', file.staged === null ? 'pl-1' : 'pl-3')}>
        {file.staged !== null && <Checkbox aria-label={`Stage ${file.path}`} checked={file.staged} disabled={action.pending !== null} onCheckedChange={onStage} />}
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex h-full min-w-0 flex-1 items-center gap-2 pr-3 text-left outline-none focus-ring">
          <Chevron open={open} />
          <span className="min-w-0 flex-1 truncate font-mono text-code text-fg">{file.path}</span>
          <span title={file.status} className="w-3 shrink-0 text-center font-mono text-caption text-fg-muted">
            {STATUS_LETTER[file.status]}
          </span>
          {diff && !diff.binary && <DiffStat added={diff.added} removed={diff.removed} />}
        </button>
      </div>
      {open && (
        <div className="border-t border-line bg-code-background">
          {!diff ? (
            <PaneMessage>No diff to show.</PaneMessage>
          ) : diff.binary ? (
            <PaneMessage>Binary file changed.</PaneMessage>
          ) : !diff.rows.length ? (
            <PaneMessage>Empty file.</PaneMessage>
          ) : (
            <InlineDiff
              rows={diff.rows}
              language={languageOf(diff.path)}
              lineNumbers
              hunkAction={
                rejectable
                  ? (hunk) => (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={action.pending !== null}
                        onClick={() => void action.run('reject', () => rpc().call('git.revertHunk', { workspaceId, patch: hunkPatch(diff, hunk) }))}
                      >
                        Reject
                      </Button>
                    )
                  : undefined
              }
            />
          )}
        </div>
      )}
    </section>
  );
}
