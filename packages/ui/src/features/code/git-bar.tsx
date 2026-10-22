/**
 * The git bar at the top of the Diff tab (design/components.md › GitBar): the branch with a switcher, Push and
 * "Open pull request", then the commit box for what is staged. When git refuses, its message shows inline.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, GitBranch, GitPullRequest, Plus } from 'lucide-react';
import type { GitStatus } from '@atelier/protocol';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  Field,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  TextArea,
  TextField,
} from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

/** Runs git actions one at a time, keeps the last failure's message, and refreshes what the pane shows after each. */
export function useGitAction(workspaceId: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Resolves to whether `action` worked. */
  const run = async (name: string, action: () => Promise<unknown>): Promise<boolean> => {
    setPending(name);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(describeError(e).message);
      return false;
    } finally {
      setPending(null);
      void qc.invalidateQueries({ queryKey: keys.workspace(workspaceId) });
    }
  };
  return { pending, error, run };
}

export type GitAction = ReturnType<typeof useGitAction>;

export function GitBar({ workspaceId, status, git }: { workspaceId: string; status: NonNullable<GitStatus>; git: GitAction }) {
  const [message, setMessage] = useState('');
  const [pullRequest, setPullRequest] = useState<{ open: boolean; url: string | null }>({ open: false, url: null });
  const staged = status.files.some((f) => f.staged);
  // Without an upstream yet, Push sets one up; with one, it's only useful when there are commits to send.
  const ahead = status.upstream?.ahead ?? 0;
  const behind = status.upstream?.behind ?? 0;
  const nothingToPush = !!status.upstream && ahead === 0;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2">
      <div className="flex items-center gap-1">
        <BranchMenu workspaceId={workspaceId} branch={status.branch} git={git} />
        {behind > 0 && <span className="shrink-0 text-footnote text-fg-muted">{behind} behind</span>}
        <Button
          size="xs"
          variant="ghost"
          leadingIcon={ArrowUp}
          className="ml-auto"
          // The reason it is off is part of its name: a disabled button can't be focused to read a tooltip.
          aria-label={nothingToPush ? 'Push: nothing to push' : ahead ? `Push ${ahead} ${ahead === 1 ? 'commit' : 'commits'}` : 'Push'}
          title={nothingToPush ? 'Nothing to push' : undefined}
          disabled={nothingToPush}
          loading={git.pending === 'push'}
          onClick={() => void git.run('push', () => rpc().call('git.push', { workspaceId }))}
        >
          Push{ahead > 0 && <span className="text-fg-muted">{ahead}</span>}
        </Button>
        <Button size="xs" variant="ghost" leadingIcon={GitPullRequest} onClick={() => setPullRequest((p) => ({ ...p, open: true }))}>
          Open pull request
        </Button>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void git.run('commit', () => rpc().call('git.commit', { workspaceId, message: message.trim() })).then((ok) => ok && setMessage(''));
        }}
      >
        <TextField
          aria-label="Commit message"
          placeholder={staged ? 'Commit message' : 'Stage changes to commit them'}
          value={message}
          maxLength={20_000}
          onChange={(e) => setMessage(e.target.value)}
          className="h-7 flex-1"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!staged || !message.trim()} loading={git.pending === 'commit'}>
          Commit
        </Button>
      </form>
      {git.error && (
        <p role="alert" className="text-footnote break-words whitespace-pre-wrap text-danger-text">
          {git.error}
        </p>
      )}
      {pullRequest.url && (
        <p className="truncate text-footnote text-fg-secondary">
          Pull request opened:{' '}
          <a href={pullRequest.url} target="_blank" rel="noreferrer" className="text-interactive-text underline">
            {pullRequest.url}
          </a>
        </p>
      )}
      <Dialog open={pullRequest.open} onOpenChange={(open) => setPullRequest((p) => ({ ...p, open }))}>
        <DialogContent title="Open a pull request" description="For the current branch, with the GitHub CLI (gh) on this folder’s computer.">
          <PullRequestForm workspaceId={workspaceId} onOpened={(url) => setPullRequest({ open: false, url })} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BranchMenu({ workspaceId, branch, git }: { workspaceId: string; branch: string | null; git: GitAction }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const branches = useQuery({
    queryKey: [...keys.workspace(workspaceId), 'branches'],
    queryFn: () => rpc().call('git.branches', { workspaceId }),
    enabled: open,
  });

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          aria-label={`Branch: ${branch ?? 'detached HEAD'}`}
          render={<Button size="xs" variant="ghost" leadingIcon={GitBranch} trailingIcon={ChevronDown} loading={git.pending === 'checkout'} className="min-w-0" />}
        >
          <span className="truncate font-mono text-code">{branch ?? 'Detached HEAD'}</span>
        </MenuTrigger>
        <MenuContent className="w-64">
          {branches.data ? (
            <MenuRadioGroup
              value={branches.data.current ?? ''}
              onValueChange={(name: string) => void git.run('checkout', () => rpc().call('git.checkout', { workspaceId, branch: name, create: false }))}
            >
              {branches.data.branches.map((b) => (
                <MenuRadioItem key={b} value={b} closeOnClick>
                  <span className="font-mono text-code">{b}</span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          ) : (
            <MenuItem disabled>{branches.error ? describeError(branches.error).message : 'Loading branches…'}</MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={Plus} onClick={() => setCreating(true)}>
            New branch…
          </MenuItem>
        </MenuContent>
      </Menu>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent title="New branch" description="Starts from what is checked out now, and keeps your changes." width={440}>
          <NewBranchForm workspaceId={workspaceId} onCreated={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Inside the dialog, so each opening starts empty. */
function NewBranchForm({ workspaceId, onCreated }: { workspaceId: string; onCreated(): void }) {
  const git = useGitAction(workspaceId);
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void git.run('create', () => rpc().call('git.checkout', { workspaceId, branch: name.trim(), create: true })).then((ok) => ok && onCreated());
      }}
    >
      <Field label="Name" error={git.error}>
        <TextField autoFocus placeholder="feature/my-change" value={name} maxLength={250} onChange={(e) => setName(e.target.value)} className="font-mono" />
      </Field>
      <DialogFooter>
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" disabled={!name.trim()} loading={git.pending === 'create'}>
          Create branch
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The base select's "let gh pick" entry; `:` can't appear in branch names. */
const DEFAULT_BASE = ':default';

function PullRequestForm({ workspaceId, onOpened }: { workspaceId: string; onOpened(url: string): void }) {
  const git = useGitAction(workspaceId);
  const branches = useQuery({ queryKey: [...keys.workspace(workspaceId), 'branches'], queryFn: () => rpc().call('git.branches', { workspaceId }) });
  // Until the person types, the title follows the newest commit's subject.
  const [typed, setTyped] = useState<string | null>(null);
  const title = typed ?? branches.data?.lastCommit ?? '';
  const [body, setBody] = useState('');
  const [base, setBase] = useState(DEFAULT_BASE);
  const bases = [
    { value: DEFAULT_BASE, label: 'Repository default' },
    ...(branches.data?.branches ?? []).filter((b) => b !== branches.data?.current).map((b) => ({ value: b, label: b })),
  ];
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const target = base === DEFAULT_BASE ? {} : { base };
        void git.run('open', async () => onOpened((await rpc().call('git.pullRequest', { workspaceId, title: title.trim(), body, ...target })).url));
      }}
    >
      <Field label="Title">
        <TextField autoFocus value={title} maxLength={256} onChange={(e) => setTyped(e.target.value)} />
      </Field>
      <Field label="Base branch">
        <Select variant="field" aria-label="Base branch" options={bases} value={base} onValueChange={setBase} />
      </Field>
      <Field label="Description">
        <TextArea value={body} maxLength={60_000} rows={6} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {git.error && (
        <p role="alert" className="text-body break-words whitespace-pre-wrap text-danger-text">
          {git.error}
        </p>
      )}
      <DialogFooter className="mt-2">
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" disabled={!title.trim()} loading={git.pending === 'open'}>
          Open pull request
        </Button>
      </DialogFooter>
    </form>
  );
}
