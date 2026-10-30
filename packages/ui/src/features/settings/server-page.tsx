import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { compareVersions, type ServerUpdateStatus, type SignupPolicy } from '@atelier/protocol';
import { Button, ConfirmDialog, Select, type SelectOption } from '../../components/ui/index.ts';
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

/** Absent on the desktop app's own backend (null), which updates with the app. */
function VersionSection() {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: SERVER_UPDATES,
    queryFn: () => rpc().call('server.updates', {}),
    refetchInterval: (query) => (running(query.state.data) ? 2000 : false),
  });
  const { error, run } = useWrite();
  const [confirming, setConfirming] = useState(false);
  if (!status) return null;

  const newer = status.latest && compareVersions(status.latest.version, status.version) > 0 ? status.latest.version : null;
  const check = () => run(async () => qc.setQueryData(SERVER_UPDATES, await rpc().call('server.updates', { refresh: true })));
  // The dialog closes either way; a refusal shows on the row.
  const update = async () => void (await run(async () => qc.setQueryData(SERVER_UPDATES, await rpc().call('server.update', {}))));

  let versionDetail: ReactNode;
  if (newer) versionDetail = `Atelier ${newer} is available.`;
  else if (status.latest) versionDetail = `Up to date. Checked ${relativeTime(status.latest.checkedAt)}.`;
  else versionDetail = status.latestError ?? 'Checking for a newer version…';

  return (
    <SettingsSection title="Version">
      <SettingRow id="server.version" detail={versionDetail}>
        <span className="text-body text-fg-secondary tabular-nums">{status.version}</span>
      </SettingRow>
      <SettingRow id="server.update" detail={updateDetail(status, newer)} error={error ?? failure(status)}>
        {status.install === 'updater' &&
          (running(status) ? (
            <Button loading disabled>
              Updating…
            </Button>
          ) : newer ? (
            <Button variant="primary" onClick={() => setConfirming(true)}>
              Update server
            </Button>
          ) : (
            <Button onClick={() => void check()}>Check now</Button>
          ))}
        {status.install !== 'updater' && <Button onClick={() => void check()}>Check now</Button>}
      </SettingRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Update the server to Atelier ${newer ?? ''}?`}
        description="The server downloads the new version and restarts. Everyone is disconnected for a minute or so, and replies being written stop; the apps reconnect by themselves."
        confirmLabel="Update server"
        onConfirm={update}
      />
    </SettingsSection>
  );
}

function updateDetail(status: ServerUpdateStatus, newer: string | null): ReactNode {
  const job = status.job;
  if (job?.state === 'pulling') return `Downloading the new version…${job.message ? ` ${job.message}` : ''}`;
  if (job?.state === 'restarting') return 'Restarting the server. This page reconnects when it is back.';
  if (status.install === 'source') return 'This server was built from source; update it by rebuilding its image.';
  if (status.install === 'manual') {
    return (
      <>
        {status.updaterError ? `${status.updaterError} ` : 'This server has no updater service. '}
        To update, run <code className="font-mono text-footnote break-all">{MANUAL_UPDATE}</code> on its host, in the folder with compose.yaml.
      </>
    );
  }
  if (job?.state === 'done' && job.finishedAt) return `Updated ${relativeTime(job.finishedAt)}.`;
  return newer ? 'Downloads the new version and restarts the server.' : null;
}

function failure(status: ServerUpdateStatus): string | null {
  return status.job?.state === 'failed' ? `The last update failed: ${status.job.message ?? 'no reason given'}` : null;
}
