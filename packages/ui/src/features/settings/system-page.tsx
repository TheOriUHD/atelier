import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APP } from '@atelier/protocol';
import { Button, Select, Switch, type SelectOption } from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';
import { desktop, isMac, openExternal, os, type UpdateChannel, type UpdateStatus } from '../../lib/platform.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useWrite } from './use-setting.ts';

const CHANNELS: SelectOption<UpdateChannel>[] = [
  { value: 'stable', label: 'Stable' },
  { value: 'beta', label: 'Beta' },
];

const UPDATES = ['desktop', 'updates'] as const;
const SYSTEM = ['desktop', 'system'] as const;

/**
 * Settings › System, only in the desktop app: its version and updates, launch at login and the data folder.
 * They belong to this computer, so main keeps them, not the account.
 */
export function SystemPage() {
  const qc = useQueryClient();
  const { data: status } = useQuery({ queryKey: UPDATES, queryFn: () => desktop!.updates.status() });
  useEffect(() => desktop!.updates.onStatus((next) => qc.setQueryData(UPDATES, next)), [qc]);
  return (
    <>
      <SettingsSection title="This app">
        <SettingRow id="system.version">
          <span className="text-body text-fg-secondary tabular-nums">{status?.version}</span>
        </SettingRow>
        <UpdatesRow status={status} />
        <AutomaticRow status={status} />
        <ChannelRow status={status} />
      </SettingsSection>
      <SettingsSection title="This computer">
        <LaunchAtLoginRow />
        <DataFolderRow />
      </SettingsSection>
    </>
  );
}

function describe({ state, checkedAt, automatic }: UpdateStatus): string | null {
  switch (state.kind) {
    case 'idle':
      if (checkedAt) return `Up to date. Checked ${relativeTime(checkedAt)}.`;
      return automatic ? 'Atelier checks when it starts and every 5 minutes.' : 'Automatic checks are off. Check now looks for a new version.';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return state.manual ? `Atelier ${state.version} is available.` : `Atelier ${state.version} is available. Downloading…`;
    case 'downloading':
      return state.version ? `Downloading Atelier ${state.version}… ${state.percent}%` : `Downloading… ${state.percent}%`;
    case 'downloaded':
      return `Atelier ${state.version} is ready. It installs when you quit Atelier, or restart now.`;
    case 'saved':
      return `Atelier ${state.version} is in your Downloads folder. Open the downloaded file and drag Atelier to Applications to update.`;
    case 'unsupported':
      return state.reason;
    case 'error':
      return null;
  }
}

function UpdatesRow({ status }: { status: UpdateStatus | undefined }) {
  const { error, run } = useWrite();
  const state = status?.state;
  let action: ReactNode = null;
  if (state?.kind === 'unsupported') action = <Button onClick={() => openExternal(APP.releases)}>Releases page</Button>;
  else if (state?.kind === 'available' && state.manual)
    action = (
      <Button variant="primary" onClick={() => void run(() => desktop!.updates.download())}>
        Download
      </Button>
    );
  else if (state?.kind === 'downloaded')
    action = (
      <Button variant="primary" onClick={() => void run(() => desktop!.updates.install())}>
        Restart to update
      </Button>
    );
  else if (state?.kind === 'idle' || state?.kind === 'checking' || state?.kind === 'error' || state?.kind === 'saved')
    action = (
      <Button loading={state.kind === 'checking'} onClick={() => void run(() => desktop!.updates.check())}>
        Check now
      </Button>
    );
  return (
    <SettingRow id="system.updates" detail={status && describe(status)} error={error ?? (state?.kind === 'error' ? state.message : null)}>
      {action}
    </SettingRow>
  );
}

function AutomaticRow({ status }: { status: UpdateStatus | undefined }) {
  const { error, run } = useWrite();
  return (
    <SettingRow id="system.autoUpdate" error={error}>
      {(label) =>
        status && <Switch {...label} checked={status.automatic} onCheckedChange={(on) => void run(() => desktop!.updates.setAutomatic(on))} />
      }
    </SettingRow>
  );
}

function ChannelRow({ status }: { status: UpdateStatus | undefined }) {
  const { error, run } = useWrite();
  return (
    <SettingRow id="system.updateChannel" error={error}>
      {(label) =>
        status && (
          <Select
            {...label}
            options={CHANNELS}
            value={status.channel}
            disabled={status.state.kind === 'unsupported'}
            onValueChange={(channel) => void run(() => desktop!.updates.setChannel(channel))}
          />
        )
      }
    </SettingRow>
  );
}

function useSystem() {
  return useQuery({ queryKey: SYSTEM, queryFn: () => desktop!.system.get() }).data;
}

function LaunchAtLoginRow() {
  const qc = useQueryClient();
  const system = useSystem();
  const { error, run } = useWrite();
  const set = (open: boolean) =>
    run(async () => {
      const openAtLogin = await desktop!.system.setOpenAtLogin(open);
      qc.setQueryData(SYSTEM, (prev: typeof system) => prev && { ...prev, openAtLogin });
    });
  return (
    <SettingRow id="system.launchAtLogin" error={error}>
      {(label) => <Switch {...label} checked={!!system?.openAtLogin} disabled={!system} onCheckedChange={(on) => void set(on)} />}
    </SettingRow>
  );
}

function DataFolderRow() {
  const system = useSystem();
  const { error, run } = useWrite();
  return (
    <SettingRow id="system.dataFolder" error={error} detail={system && <span className="font-mono break-all">{system.dataFolder}</span>}>
      <Button onClick={() => void run(() => desktop!.system.showDataFolder())}>
        {isMac ? 'Show in Finder' : os === 'win32' ? 'Show in Explorer' : 'Show in folder'}
      </Button>
    </SettingRow>
  );
}
