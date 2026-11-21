import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { compareVersions, type ServerUpdateStatus, type SignupPolicy } from '@atelier/protocol';
import { Button, ProgressBar, Select, Switch, type SelectOption } from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';
import { rpc } from '../../lib/rpc.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { SingleSignOnSection } from './single-sign-on-section.tsx';
import { useSetting, useWrite } from './use-setting.ts';

const POLICIES: SelectOption<SignupPolicy>[] = [
  { value: 'invite', label: 'Invite only' },
  { value: 'open', label: 'Open, with approval' },
];

export const SERVER_UPDATES = ['server', 'updates'] as const;
export const MANUAL_UPDATE = 'docker compose pull && docker compose up -d';

export function ServerPage() {
  const signup = useSetting<SignupPolicy>(['server', 'signup']);
  return (
    <>
      <VersionSection />
      <SettingsSection title="Accounts">
        <SettingRow id="server.signup" setting={signup}>
          {(label) => <Select {...label} options={POLICIES} value={signup.value} onValueChange={(v) => void signup.set(v)} />}
        </SettingRow>
      </SettingsSection>
      <SingleSignOnSection />
    </>
  );
}

const running = (status: ServerUpdateStatus | null | undefined) => status?.job?.state === 'pulling' || status?.job?.state === 'restarting';
/** An automatic update that is on its way: the page keeps reading its state. */
const autoBusy = (status: ServerUpdateStatus | null | undefined) => status?.auto?.enabled === true && status.auto.state !== 'idle';

/** Absent on the desktop app's own backend (null), which updates with the app. */
function VersionSection() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: SERVER_UPDATES,
    queryFn: () => rpc().call('server.updates', {}),
    refetchInterval: (query) => (running(query.state.data) || autoBusy(query.state.data) ? 2000 : false),
  });
  const { error, run } = useWrite();
  if (!status) return null;

  const newer = status.latest && compareVersions(status.latest.version, status.version) > 0 ? status.latest.version : null;
  const check = () => run(async () => qc.setQueryData(SERVER_UPDATES, await rpc().call('server.updates', { refresh: true })));
  // No question first: a refusal shows on the row.
  const update = async () => void (await run(async () => qc.setQueryData(SERVER_UPDATES, await rpc().call('server.update', {}))));
  const updating = running(status) || status.auto?.state === 'installing';

  let versionDetail: ReactNode;
  if (newer) versionDetail = `Atelier ${newer} is available.`;
  else if (status.latest) versionDetail = `Up to date. Checked ${relativeTime(status.latest.checkedAt)}.`;
  else versionDetail = status.latestError ?? 'Checking for a newer version…';

  return (
    <SettingsSection title="Version">
      <SettingRow id="server.version" detail={versionDetail}>
        <span className="text-body text-fg-secondary tabular-nums">{status.version}</span>
      </SettingRow>
      {status.auto && status.install === 'updater' && <AutoUpdateRow onChange={() => void qc.invalidateQueries({ queryKey: SERVER_UPDATES })} />}
      <SettingRow id="server.update" detail={<UpdateDetail status={status} newer={newer} />} error={error ?? failure(status)}>
        {status.install === 'updater' &&
          (updating ? (
            <Button loading disabled>
              Updating…
            </Button>
          ) : newer ? (
            <Button variant="primary" onClick={() => void update()}>
              Update now
            </Button>
          ) : (
            <Button onClick={() => void check()}>Check now</Button>
          ))}
        {status.install !== 'updater' && <Button onClick={() => void check()}>Check now</Button>}
      </SettingRow>
    </SettingsSection>
  );
}

/** The switch that lets the server download a new version at once and install it when nothing is running. */
function AutoUpdateRow({ onChange }: { onChange(): void }) {
  const setting = useSetting<boolean>(['server', 'autoUpdate']);
  return (
    <SettingRow id="server.autoUpdate" setting={setting}>
      {(label) => <Switch {...label} checked={setting.value === true} onCheckedChange={(on) => void setting.set(on).then(onChange)} />}
    </SettingRow>
  );
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;

/** While an update runs: what it does, over a bar of how much of the new version is down (full while restarting). */
function UpdateProgress({ job, background }: { job: NonNullable<ServerUpdateStatus['job']>; background?: string | undefined }) {
  const progress = job.progress;
  const restarting = job.state === 'restarting';
  const what = background ? `Downloading Atelier ${background} in the background…` : 'Downloading the new version…';
  let text: string;
  if (restarting) text = 'Restarting the server. This page reconnects when it is back.';
  else if (progress?.unpacking) text = 'Unpacking the new version…';
  else if (progress) text = `${what} ${progress.percent}% · ${megabytes(progress.done)} of ${megabytes(progress.total)}`;
  // An updater from before 0.7.1 says only the last line it printed.
  else text = `${what}${job.message ? ` ${job.message}` : ''}`;
  const percent = restarting ? 100 : (progress?.percent ?? 0);
  return (
    <span className="flex flex-col gap-2">
      <span className="tabular-nums">{text}</span>
      {(progress || restarting) && <ProgressBar value={percent / 100} aria-label="Server update" aria-valuetext={restarting ? 'Restarting' : `${percent}%`} className="max-w-80" />}
    </span>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What an automatic update says while it is on its way, in words; null when there is nothing to say. */
function autoDetail(status: ServerUpdateStatus): ReactNode {
  const auto = status.auto;
  if (!auto?.enabled || auto.state === 'idle') return null;
  const version = auto.version ?? status.latest?.version ?? 'the new version';
  const job = status.job;
  if (auto.state === 'downloading') {
    if (job && job.state === 'pulling') return <UpdateProgress job={job} background={version} />;
    return `Downloading Atelier ${version} in the background…`;
  }
  if (auto.state === 'waiting') {
    const waiting = auto.waitingFor;
    const parts = waiting ? [waiting.turns > 0 ? plural(waiting.turns, 'reply', 'replies') : null, waiting.background > 0 ? plural(waiting.background, 'background task', 'background tasks') : null].filter(Boolean) : [];
    return `Atelier ${version} is downloaded and installs as soon as nothing is running${parts.length ? ` (${parts.join(', ')})` : ''}.`;
  }
  if (auto.state === 'installing') return `Installing Atelier ${version}. This page reconnects in a moment.`;
  const when = auto.retryAt ? ` Trying again at ${new Date(auto.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
  return `The automatic update to Atelier ${version} didn’t work: ${auto.error ?? 'no reason given'}.${when}`;
}

function UpdateDetail({ status, newer }: { status: ServerUpdateStatus; newer: string | null }): ReactNode {
  const job = status.job;
  if (job && (job.state === 'pulling' || job.state === 'restarting')) {
    // An automatic download says so, in the words of its state.
    return status.auto?.enabled && status.auto.state === 'downloading' && job.state === 'pulling' ? autoDetail(status) : <UpdateProgress job={job} />;
  }
  if (status.install === 'source') return 'This server was built from source; update it by rebuilding its image.';
  if (status.install === 'manual') {
    return (
      <>
        {status.updaterError ? `${status.updaterError} ` : 'This server has no updater service. '}
        To update, run <code className="font-mono text-footnote break-all">{MANUAL_UPDATE}</code> on its host, in the folder with compose.yaml.
      </>
    );
  }
  const auto = autoDetail(status);
  if (auto) return auto;
  if (job?.state === 'done' && job.finishedAt) return `Updated ${relativeTime(job.finishedAt)}.`;
  if (!newer) return null;
  return status.auto?.enabled
    ? 'This server updates itself as soon as nothing is running. Update now restarts it right away, and replies being written stop.'
    : 'Downloads the new version and restarts the server. Replies being written stop; the apps reconnect by themselves.';
}

function failure(status: ServerUpdateStatus): string | null {
  return status.job?.state === 'failed' ? `The last update failed: ${status.job.message ?? 'no reason given'}` : null;
}
