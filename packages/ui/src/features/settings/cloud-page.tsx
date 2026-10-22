import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Cloud, ExternalLink, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import type { CodespaceSummary } from '@atelier/protocol';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  Select,
  Spinner,
  TextField,
  toast,
  type BadgeTone,
} from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';
import { openExternal } from '../../lib/platform.ts';
import { keys, useAccount, useSettings, useWorkspaces } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from '../auth/form.ts';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { settingEntry } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { useDraftText, useSetting } from './use-setting.ts';
import { codespaceWhere, requestTrust } from '../workspaces/trust.tsx';

type GitHubStatus = { connected: boolean; login?: string };

/** The connection rows look like `SettingRow`s. */
const ROW_CLASS = 'flex min-h-14 items-center gap-7 border-b border-line-subtle py-3 last:border-b-0';

/** The person's GitHub connection and their codespaces, which become folders for Code sessions. */
export function CloudPage() {
  const { account } = useAccount();
  const { data: status } = useQuery({ queryKey: keys.github, queryFn: () => rpc().call('github.status', {}), staleTime: 0 });
  return (
    <>
      <GitHubSection status={status} admin={account?.role === 'admin'} />
      {status?.connected && <CodespacesSection />}
    </>
  );
}

function GitHubSection({ status, admin }: { status: GitHubStatus | undefined; admin: boolean }) {
  const entry = settingEntry('cloud.github');
  return (
    <SettingsSection id="cloud.github" title={entry.label} description={entry.description}>
      {status?.connected ? <ConnectedRow login={status.login} /> : status && <GitHubConnect className={ROW_CLASS} />}
      {admin && <ClientIdRow />}
    </SettingsSection>
  );
}

function ConnectedRow({ login }: { login: string | undefined }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const disconnect = async () => {
    try {
      await rpc().call('github.disconnect', {});
      qc.setQueryData<GitHubStatus>(keys.github, { connected: false });
      qc.removeQueries({ queryKey: keys.codespaces });
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };
  return (
    <div className={ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="text-body text-fg">Connected as @{login}</p>
        <p className="mt-1 text-body text-fg-muted">Your codespaces and their folders use this account.</p>
      </div>
      <Button onClick={() => setConfirm(true)}>Disconnect</Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect GitHub?"
        description="Atelier forgets the token. Your codespaces keep running on GitHub until their idle timeout, and their folders can’t be used until you connect again."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
      />
    </div>
  );
}

type DeviceFlow = { flowId: string; userCode: string; verificationUri: string; interval: number };

/**
 * GitHub's device flow: the person enters a code on github.com while this polls (no faster than GitHub
 * asks) until they approve, deny or the code expires.
 */
function useDeviceFlow() {
  const qc = useQueryClient();
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!flow) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = (seconds: number) => {
      timer = setTimeout(async () => {
        try {
          const result = await rpc().call('github.devicePoll', { flowId: flow.flowId });
          if (stopped) return;
          if (result.status === 'pending') return poll(result.interval ?? seconds);
          setFlow(null);
          if (result.status === 'connected') {
            connected(qc, { connected: true, login: result.login });
          } else setError(result.status === 'denied' ? 'GitHub sign-in was denied.' : 'The code expired. Start again for a new one.');
        } catch (e) {
          if (stopped) return;
          setFlow(null);
          setError(describeError(e).message);
        }
      }, seconds * 1000);
    };
    poll(flow.interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [flow, qc]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setFlow(await rpc().call('github.deviceStart', {}));
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setStarting(false);
    }
  };

  return { flow, starting, error, start, cancel: () => setFlow(null) };
}

/** A new connection: lists that failed for want of one (repositories, codespaces) load again. */
function connected(qc: QueryClient, status: GitHubStatus) {
  qc.setQueryData<GitHubStatus>(keys.github, status);
  void qc.invalidateQueries({ queryKey: keys.githubRepos });
  void qc.invalidateQueries({ queryKey: keys.codespaces });
  toast.success(`Connected to GitHub as @${status.login}.`);
}

/**
 * Connecting GitHub: device-flow sign-in where an admin set up the OAuth app, else a token. Used in Settings › Cloud
 * and wherever a codespace is wanted without a connection.
 */
export function GitHubConnect({ className, title = 'Not connected' }: { className: string; title?: string }) {
  const { account } = useAccount();
  const { settings } = useSettings();
  const deviceFlow = !!settings?.cloud.github.clientId;
  const admin = account?.role === 'admin';
  const device = useDeviceFlow();
  const token = useDialog();
  const { flow } = device;
  const open = () => {
    void navigator.clipboard?.writeText(flow!.userCode).catch(() => {});
    openExternal(flow!.verificationUri);
  };

  return (
    <div className={className}>
      {flow ? (
        <div className="flex flex-1 flex-col items-start gap-3 rounded-2xl bg-fill-ghost-hover p-4">
          <p className="text-body text-fg-secondary">Enter this code on GitHub to connect your account:</p>
          <p aria-label="Your code" className="font-mono text-[24px] leading-8 tracking-[0.15em] text-fg">
            {flow.userCode}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" trailingIcon={ExternalLink} onClick={open}>
              Copy code and open GitHub
            </Button>
            <Button variant="ghost" onClick={device.cancel}>
              Cancel
            </Button>
          </div>
          <p className="flex items-center gap-2 text-footnote text-fg-muted">
            <Spinner />
            Waiting for you to approve on GitHub…
          </p>
        </div>
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <p className="text-body text-fg">{title}</p>
            <p className="mt-1 text-body text-fg-muted">
              {deviceFlow
                ? 'Sign in with GitHub, or connect with a personal access token.'
                : `Connect with a personal access token. Signing in with GitHub needs an OAuth app${admin ? ': add its client id below.' : ', which an admin adds in Settings.'}`}
            </p>
            {device.error && (
              <p role="alert" className="mt-1 text-body text-danger-text">
                {device.error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={token.show}>Use a token…</Button>
            {deviceFlow && (
              <Button variant="primary" loading={device.starting} onClick={() => void device.start()}>
                Sign in with GitHub
              </Button>
            )}
          </div>
        </>
      )}
      <TokenDialog key={token.key} open={token.open} onOpenChange={token.onOpenChange} />
    </div>
  );
}

const Token = z.object({ token: z.string().trim().min(10, 'Paste the whole token.') });

function TokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const form = useFormSubmit(Token, { github_failed: 'token' }, async (v) => {
    connected(qc, await rpc().call('github.connectToken', v));
    onOpenChange(false);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Connect with a token"
        description={
          <>
            A classic personal access token with the <span className="font-mono">codespace</span> and <span className="font-mono">repo</span> scopes.
            Fine-grained tokens may not work for terminal access.{' '}
            <a
              href="https://github.com/settings/tokens/new?scopes=codespace,repo&description=Atelier"
              target="_blank"
              rel="noreferrer"
              className="text-interactive-text underline-offset-2 hover:underline"
            >
              Create one on GitHub
            </a>
          </>
        }
      >
        <form noValidate onSubmit={form.onSubmit({ token })} className="flex flex-col gap-4">
          <Field label="Personal access token" error={form.errors.token ?? form.errors.form}>
            <TextField
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="ghp_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono"
            />
          </Field>
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Admins: the OAuth app people sign in through. Cleared, only tokens work. */
function ClientIdRow() {
  const clientId = useSetting<string | undefined>(['cloud', 'github', 'clientId']);
  const draft = useDraftText({ value: clientId.value ?? '', set: (v) => (v.trim() ? clientId.set(v.trim()) : clientId.clear()) });
  return (
    <SettingRow id="cloud.github.clientId" setting={clientId}>
      {(label) => <TextField {...label} {...draft} autoComplete="off" spellCheck={false} placeholder="Client id" className="w-[253px] font-mono" />}
    </SettingRow>
  );
}

/** GitHub's codespace states as Atelier names them, with a badge tone. */
export const CODESPACE_STATES: Record<string, [string, BadgeTone]> = {
  Available: ['Running', 'success'],
  Shutdown: ['Stopped', 'neutral'],
  Starting: ['Starting', 'warning'],
  ShuttingDown: ['Stopping', 'warning'],
  Provisioning: ['Creating', 'warning'],
  Rebuilding: ['Rebuilding', 'warning'],
  Failed: ['Failed', 'danger'],
  Unavailable: ['Unavailable', 'danger'],
};
/** States that don't change by themselves; any other one is polled until it settles. */
const SETTLED = new Set(['Available', 'Shutdown', 'Failed', 'Unavailable', 'Archived']);

function CodespacesSection() {
  const entry = settingEntry('cloud.codespaces');
  const create = useDialog();
  const { data: codespaces, error } = useQuery({
    queryKey: keys.codespaces,
    queryFn: () => rpc().call('codespaces.list', {}),
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.some((c) => !SETTLED.has(c.state)) ? 5000 : false),
  });
  return (
    <SettingsSection
      id="cloud.codespaces"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" leadingIcon={Plus} onClick={create.show}>
          New codespace
        </Button>
      }
    >
      {error && (
        <p role="alert" className="pb-3 text-body text-danger-text">
          {describeError(error).message}
        </p>
      )}
      {codespaces?.length === 0 && <p className="pb-3 text-body text-fg-muted">No codespaces yet. Create one for a repository to run Code sessions in the cloud.</p>}
      {!!codespaces?.length && (
        <ul aria-label={entry.label}>
          {codespaces.map((c) => (
            <CodespaceRow key={c.name} codespace={c} />
          ))}
        </ul>
      )}
      <NewCodespaceDialog key={create.key} open={create.open} onOpenChange={create.onOpenChange} />
    </SettingsSection>
  );
}

function CodespaceRow({ codespace: c }: { codespace: CodespaceSummary }) {
  const qc = useQueryClient();
  const { data: workspaces } = useWorkspaces();
  const [busy, setBusy] = useState<'folder' | 'start' | 'stop' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const isFolder = workspaces?.some((w) => w.kind === 'codespace' && w.host === c.name);
  const [state, tone] = CODESPACE_STATES[c.state] ?? [c.state, 'neutral'];
  const details = [
    c.repo,
    c.machine,
    c.idleTimeoutMinutes && `stops after ${c.idleTimeoutMinutes} min idle`,
    c.lastUsedAt && `used ${relativeTime(c.lastUsedAt)}`,
  ].filter(Boolean);

  const run = async (what: NonNullable<typeof busy>, call: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await call();
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setBusy(null);
    }
    await qc.invalidateQueries({ queryKey: keys.codespaces });
  };
  const addFolder = () =>
    run('folder', async () => {
      if (!(await requestTrust(c.repo, codespaceWhere(c.name)))) return;
      await rpc().call('workspaces.addCodespace', { name: c.name, trust: true });
      await qc.invalidateQueries({ queryKey: keys.workspaces });
      toast.success(`${c.displayName} is one of your folders now. Pick it for a Code session.`);
    });
  const remove = async () => {
    try {
      await rpc().call('codespaces.delete', { name: c.name });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await qc.invalidateQueries({ queryKey: keys.codespaces });
  };

  return (
    <li className={ITEM_ROW_CLASS}>
      <ItemTile icon={Cloud} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body-strong text-fg">{c.displayName}</span>
          <Badge tone={tone}>{state}</Badge>
          {isFolder && <Badge>Folder</Badge>}
        </div>
        <p title={details.join(' · ')} className="truncate text-footnote text-fg-muted">
          {details.join(' · ')}
        </p>
      </div>
      {!isFolder && (
        <Button size="sm" loading={busy === 'folder'} onClick={() => void addFolder()}>
          Use as folder
        </Button>
      )}
      {c.state === 'Available' && (
        <Button size="sm" variant="ghost" loading={busy === 'stop'} onClick={() => void run('stop', () => rpc().call('codespaces.stop', { name: c.name }))}>
          Stop
        </Button>
      )}
      {c.state === 'Shutdown' && (
        <Button size="sm" variant="ghost" loading={busy === 'start'} onClick={() => void run('start', () => rpc().call('codespaces.start', { name: c.name }))}>
          Start
        </Button>
      )}
      <IconButton icon={Trash2} label={`Delete ${c.displayName}`} size="sm" onClick={() => setConfirm(true)} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${c.displayName}?`}
        description="GitHub deletes the codespace and everything in it. Changes that aren’t committed and pushed are lost."
        onConfirm={remove}
      />
    </li>
  );
}

const IDLE_TIMEOUTS = [
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '240', label: '4 hours' },
];

/** owner/repo, also from a pasted github.com URL. */
const repoOf = (text: string) =>
  text
    .trim()
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$|\/$/g, '');
const REPO = /^[\w.-]+\/[\w.-]+$/;

const NewCodespace = z.object({
  repo: z.string().transform(repoOf).pipe(z.string().regex(REPO, 'Enter a repository as owner/repo.')),
  ref: z.string().trim().max(250),
  machine: z.string().min(1, 'Choose a machine.'),
  idle: z.string(),
});

/** Creates a codespace; `onCreated` hears of it (the Code home makes it the folder to work in). */
export function NewCodespaceDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange(open: boolean): void; onCreated?(codespace: CodespaceSummary): void }) {
  const qc = useQueryClient();
  const [values, setValues] = useState({ repo: '', ref: '', machine: '', idle: '30' });
  // The repository (and branch) whose machines are listed; looked up when the field is left.
  const [lookup, setLookup] = useState<{ repo: string; ref: string } | null>(null);
  const machines = useQuery({
    queryKey: [...keys.codespaces, 'machines', lookup?.repo, lookup?.ref],
    queryFn: () => rpc().call('codespaces.machines', { repo: lookup!.repo, ...(lookup!.ref && { ref: lookup!.ref }) }),
    enabled: !!lookup,
    staleTime: 0,
  });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const machine = values.machine || machines.data?.[0]?.name || '';
  const form = useFormSubmit(NewCodespace, {}, async (v) => {
    setStartedAt(Date.now());
    try {
      const created = await rpc().call('codespaces.create', { repo: v.repo, ...(v.ref && { ref: v.ref }), machine: v.machine, idleTimeoutMinutes: Number(v.idle) });
      await qc.invalidateQueries({ queryKey: keys.codespaces });
      toast.success(`${created.displayName} is ready.`);
      onOpenChange(false);
      onCreated?.(created);
    } catch (e) {
      // The dialog may be closed by now ("it keeps going"): say it where it is seen either way.
      toast.error(`Creating the codespace failed: ${describeError(e).message}`);
      throw e;
    } finally {
      setStartedAt(null);
    }
  });
  const look = (repo: string, ref: string) => {
    const name = repoOf(repo);
    if (REPO.test(name)) setLookup({ repo: name, ref: ref.trim() });
  };
  const set = (key: keyof typeof values) => (value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New codespace"
        description="A cloud machine on GitHub with the repository checked out. It stops after the idle timeout and runs at most 12 hours at a time."
      >
        <form noValidate onSubmit={form.onSubmit({ ...values, machine })} className="flex flex-col gap-4">
          <Field label="Repository" error={form.errors.repo}>
            <TextField
              autoFocus
              value={values.repo}
              onChange={(e) => set('repo')(e.target.value)}
              onBlur={() => look(values.repo, values.ref)}
              placeholder="owner/repo"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field label="Branch" description="Empty uses the default branch." error={form.errors.ref}>
            <TextField
              value={values.ref}
              onChange={(e) => set('ref')(e.target.value)}
              onBlur={() => look(values.repo, values.ref)}
              placeholder="main"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Machine" error={form.errors.machine ?? (machines.error && describeError(machines.error).message)}>
              <Select
                variant="field"
                options={(machines.data ?? []).map((m) => ({ value: m.name, label: m.displayName }))}
                value={machine}
                placeholder={machines.isFetching ? 'Loading machines…' : 'Enter a repository first'}
                disabled={!machines.data?.length}
                onValueChange={set('machine')}
              />
            </Field>
            <Field label="Idle timeout">
              <Select variant="field" options={IDLE_TIMEOUTS} value={values.idle} onValueChange={set('idle')} />
            </Field>
          </div>
          {startedAt && <Progress since={startedAt} />}
          {form.errors.form && (
            <p role="alert" className="text-footnote text-danger-text">
              {form.errors.form}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>{startedAt ? 'Close' : 'Cancel'}</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              Create codespace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** GitHub reports no progress while it creates a codespace, so this counts the time instead. */
function Progress({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return (
    <p role="status" className="flex items-center gap-2 text-footnote text-fg-muted">
      <Spinner />
      Creating the codespace, usually one to three minutes ({Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}). You can close this; it keeps going.
    </p>
  );
}
