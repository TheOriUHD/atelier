import { useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { APP } from '@atelier/protocol';
import { Button, Select, Switch, type SelectOption } from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';
import { changeLending, useConnection, useLending } from '../../lib/lending.ts';
import { desktop, isMac, openExternal, os, type LendingChange, type UpdateChannel, type UpdateStatus } from '../../lib/platform.ts';
import { ComputerUseSection } from './computer-use-section.tsx';
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
        <SettingRow id="system.version" detail={<Copyright />}>
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
      <ComputerUseSection />
      <LentSection />
    </>
  );
}

/** The copyright line under the version; the name opens the author's GitHub. */
function Copyright() {
  return (
    <>
      © {APP.author.since}{' '}
      <button type="button" onClick={() => openExternal(APP.author.url)} className="rounded-xs text-interactive-text outline-none focus-ring hover:underline">
        {APP.author.name}
      </button>
    </>
  );
}

/**
 * Signed in to a server: what the person allowed it to do on this computer (ARCHITECTURE §21), beyond the folders they
 * opened here. Allowing happens where they use it (the first session without a folder, choosing an SSH host, adding a
 * connector or model server here); this takes it back.
 */
function LentSection() {
  const lending = useLending();
  const { data: connection } = useConnection();
  const { error, run } = useWrite();
  const allowed = lending.allowed;
  const shown = (['scratch', 'ssh', 'mcp', 'http', 'chatgptChat', 'home'] as const).filter((s) => lending.lends(s));
  if (!lending.server || !allowed || !shown.length) return null;
  const server = connection?.serverUrl ? new URL(connection.serverUrl).host : 'the server';
  const change = (c: LendingChange) => void run(() => changeLending(c));
  return (
    <SettingsSection title={`What ${server} can do here`}>
      {lending.lends('home') && (
        <SettingRow id="system.lendHome" error={error}>
          {(label) => <Switch {...label} checked={allowed.home} onCheckedChange={(on) => change({ kind: 'home', allowed: on })} />}
        </SettingRow>
      )}
      {lending.lends('scratch') && (
        <SettingRow id="system.lendScratch" error={error}>
          {(label) => <Switch {...label} checked={allowed.scratch} onCheckedChange={(on) => change({ kind: 'scratch', allowed: on })} />}
        </SettingRow>
      )}
      {lending.lends('ssh') && (
        <SettingRow id="system.lendSsh" stacked error={error}>
          <LentList items={allowed.ssh.map((host) => ({ key: host, label: host, remove: () => change({ kind: 'ssh', host, allowed: false }) }))} />
        </SettingRow>
      )}
      {lending.lends('mcp') && (
        <SettingRow id="system.lendConnectors" stacked error={error}>
          <LentList items={allowed.connectors.map((c) => ({ key: c.id, label: c.name || c.id, remove: () => change({ kind: 'connector', id: c.id, allowed: false }) }))} />
        </SettingRow>
      )}
      {lending.lends('http') && (
        <SettingRow id="system.lendHttp" stacked error={error}>
          <LentList items={allowed.http.map((a) => ({ key: a.id, label: a.baseUrl, remove: () => change({ kind: 'http', id: a.id, allowed: false }) }))} />
        </SettingRow>
      )}
      {lending.lends('chatgptChat') && (
        <SettingRow id="system.lendChatgptChat" error={error}>
          {(label) => <Switch {...label} checked={allowed.chatgptChat} onCheckedChange={(on) => change({ kind: 'chatgptChat', allowed: on })} />}
        </SettingRow>
      )}
    </SettingsSection>
  );
}

/** Hosts, connectors or addresses lent to the server, each with Remove. */
function LentList({ items }: { items: { key: string; label: string; remove(): void }[] }) {
  if (!items.length) return <p className="text-body text-fg-muted">None yet.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.key} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-mono text-body text-fg">{item.label}</span>
          <Button size="sm" onClick={item.remove}>
            Remove
          </Button>
        </li>
      ))}
    </ul>
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
