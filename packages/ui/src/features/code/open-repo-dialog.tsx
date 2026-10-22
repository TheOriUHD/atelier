/**
 * "Open a repository" for the Cloud environment, as in the desktop app: pick one of your repositories from a
 * searchable list and everything else is done for you. Atelier finds the repository's codespace, wakes it when it
 * went to sleep, or creates one on the largest machine your account allows that stays on as long as GitHub lets it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Lock, RefreshCw } from 'lucide-react';
import type { CodespaceSummary, GitHubRepo, WorkspaceSummary } from '@atelier/protocol';
import { Badge, Button, Dialog, DialogContent, DialogFooter, Icon, Spinner, TextField, toast, cn } from '../../components/ui/index.ts';
import { keys, useWorkspaces } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { CODESPACE_STATES, GitHubConnect } from '../settings/cloud-page.tsx';
import { codespaceWhere, requestTrust } from '../workspaces/trust.tsx';

/** Rows shown at once; the search narrows a longer list. */
const SHOWN = 100;

/** Repositories matching what was typed: every word must appear in `owner/name`. */
export function matchRepos(repos: readonly GitHubRepo[], query: string): GitHubRepo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((r) => words.every((w) => r.fullName.toLowerCase().includes(w)));
}

export function OpenRepoDialog({ open, onOpenChange, onOpened }: { open: boolean; onOpenChange(open: boolean): void; onOpened(workspace: WorkspaceSummary): void }) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<{ repo: string; since: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const github = useQuery({ queryKey: keys.github, queryFn: () => rpc().call('github.status', {}), enabled: open, staleTime: 0 });
  const ready = open && !!github.data?.connected;
  const repos = useQuery({ queryKey: keys.githubRepos, queryFn: () => rpc().call('github.repos', {}), enabled: ready, staleTime: 60_000 });
  // Which repositories already have a codespace, and in what state; the list is only a hint, so its failure is ignored.
  const existing = useQuery({ queryKey: keys.codespaces, queryFn: () => rpc().call('codespaces.list', {}), enabled: ready, staleTime: 0 });
  const byRepo = useMemo(() => {
    const map = new Map<string, CodespaceSummary>();
    for (const c of [...(existing.data ?? [])].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))) map.set(c.repo.toLowerCase(), c);
    return map;
  }, [existing.data]);
  const matches = useMemo(() => matchRepos(repos.data ?? [], query), [repos.data, query]);
  const { data: workspaces } = useWorkspaces();
  const asking = useRef(false);

  const choose = async (repo: string) => {
    if (opening || asking.current) return;
    setError(null);
    // "Trust this workspace?" comes before anything is woken or created (that can cost the person money). A repository whose
    // codespace is already one of the person's trusted folders opens without it; any other, even one the person opened
    // before under another codespace, asks, and the answer holds for the codespace that is opened.
    const codespace = byRepo.get(repo.toLowerCase());
    const known = !!codespace && !!workspaces?.some((w) => w.kind === 'codespace' && w.host === codespace.name && w.trusted !== false);
    if (!known) {
      asking.current = true;
      const agreed = await requestTrust(repo, codespaceWhere(codespace?.name)).finally(() => (asking.current = false));
      if (!agreed) return;
    }
    setOpening({ repo, since: Date.now() });
    rpc()
      .call('codespaces.open', { repo, ...(known ? {} : { trust: true }) })
      .then(async (workspace) => {
        await Promise.all([qc.invalidateQueries({ queryKey: keys.workspaces }), qc.invalidateQueries({ queryKey: keys.codespaces })]);
        onOpenChange(false);
        onOpened(workspace);
      })
      .catch((e: unknown) => {
        const message = describeError(e).message;
        setOpening(null);
        setError(message);
        // The dialog may be closed by now ("it keeps going"): say it where it is seen either way.
        if (!open) toast.error(`Opening ${repo} failed: ${message}`);
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Open a repository"
        description="Pick a repository. Atelier opens its codespace on GitHub, waking it if it went to sleep, or creates one on the largest machine your account allows."
      >
        {github.data && !github.data.connected ? (
          <GitHubConnect title="Connect GitHub to see your repositories" className="flex flex-wrap items-center gap-4 rounded-xl p-4 inset-ring inset-ring-line" />
        ) : github.error ? (
          <p role="alert" className="py-3 text-body text-danger-text">
            {describeError(github.error).message}
          </p>
        ) : !github.data ? (
          <p role="status" className="flex items-center gap-2 py-3 text-body text-fg-muted">
            <Spinner /> Checking your GitHub connection…
          </p>
        ) : opening ? (
          <Opening repo={opening.repo} since={opening.since} codespace={byRepo.get(opening.repo.toLowerCase())} />
        ) : (
          <div className="flex flex-col gap-3">
            <TextField
              autoFocus
              aria-label="Search repositories"
              placeholder="Search repositories…"
              value={query}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches[0]) {
                  e.preventDefault();
                  void choose(matches[0].fullName);
                }
              }}
            />
            {error && (
              <p role="alert" className="text-footnote text-danger-text">
                {error}
              </p>
            )}
            <div className="max-h-80 overflow-y-auto rounded-xl inset-ring inset-ring-line">
              {repos.isPending && (
                <p role="status" className="flex items-center gap-2 px-3 py-3 text-body text-fg-muted">
                  <Spinner /> Loading your repositories…
                </p>
              )}
              {repos.error && (
                <p role="alert" className="px-3 py-3 text-body text-danger-text">
                  {describeError(repos.error).message}
                </p>
              )}
              {repos.data && matches.length === 0 && <p className="px-3 py-3 text-body text-fg-muted">{repos.data.length ? 'No repository matches.' : 'No repositories on this account.'}</p>}
              <ul>
                {matches.slice(0, SHOWN).map((r) => {
                  const codespace = byRepo.get(r.fullName.toLowerCase());
                  const [state, tone] = codespace ? (CODESPACE_STATES[codespace.state] ?? [codespace.state, 'neutral' as const]) : [null, 'neutral' as const];
                  return (
                    <li key={r.fullName} className="border-t border-line first:border-t-0">
                      <button
                        type="button"
                        onClick={() => void choose(r.fullName)}
                        className={cn('flex h-10 w-full items-center gap-2 px-3 text-left text-body text-fg outline-none focus-ring hover:bg-fill-ghost-hover')}
                      >
                        <Icon icon={r.private ? Lock : GitBranch} className="size-4 shrink-0 text-fg-muted" />
                        <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
                        {state && <Badge tone={tone}>{state}</Badge>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {matches.length > SHOWN && <p className="border-t border-line px-3 py-2 text-footnote text-fg-muted">{matches.length - SHOWN} more: type to narrow the list.</p>}
            </div>
          </div>
        )}
        <DialogFooter className="mt-2">
          {!opening && ready && (
            <Button
              leadingIcon={RefreshCw}
              onClick={() => void qc.invalidateQueries({ queryKey: keys.githubRepos })}
              loading={repos.isFetching && !repos.isPending}
              className="mr-auto"
            >
              Refresh list
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{opening ? 'Close' : 'Cancel'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** GitHub reports no progress while it creates or wakes a codespace, so this counts the time instead. */
function Opening({ repo, since, codespace }: { repo: string; since: number; codespace: CodespaceSummary | undefined }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return (
    <div role="status" className="flex flex-col gap-1 rounded-xl px-4 py-4 inset-ring inset-ring-line">
      <p className="flex items-center gap-2 text-body text-fg">
        <Spinner />
        <span className="font-medium">{codespace ? `Waking ${repo}…` : `Setting up ${repo}…`}</span>
        <span className="ml-auto text-footnote text-fg-muted">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
      </p>
      <p className="text-footnote text-fg-muted">
        {codespace
          ? 'It takes up to a minute. Atelier wakes it again whenever it has gone to sleep.'
          : 'A new codespace takes one to three minutes the first time; after that it only needs waking. You can close this: it keeps going.'}
      </p>
    </div>
  );
}
