/**
 * Settings › System › Computer use (ARCHITECTURE §22; design/components.md › Computer use): on or off, how the
 * assistant uses the apps the person allows, whether hidden apps come back, the denied apps, the apps allowed for good,
 * and the macOS permissions it needs. Kept by this computer's main process, not the account.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComputerApp, ComputerMode } from '@atelier/protocol';
import { Button, Dialog, DialogContent, SegmentedControl, Switch, TextField } from '../../components/ui/index.ts';
import { refreshComputer, useComputerStatus } from '../../lib/computer.ts';
import { desktop } from '../../lib/platform.ts';
import type { SettingId } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useWrite } from './use-setting.ts';

const MODES: { value: ComputerMode; label: string }[] = [
  { value: 'background', label: 'Background' },
  { value: 'full', label: 'Full control' },
];

export function ComputerUseSection() {
  const status = useComputerStatus();
  const qc = useQueryClient();
  const { error, run } = useWrite();
  const [adding, setAdding] = useState(false);
  if (!desktop?.computer || !status) return null;
  const computer = desktop.computer;
  const change = (write: () => Promise<unknown>) => void run(() => refreshComputer(qc, write));
  const settings = status.settings;
  if (!status.available) {
    return (
      <SettingsSection title="Computer use">
        <p className="pb-3 text-body text-fg-muted">Computer use isn’t available on this computer yet: it comes to macOS first.</p>
      </SettingsSection>
    );
  }
  const always = settings.always.local ?? [];
  return (
    <SettingsSection title="Computer use">
      <SettingRow id="system.computerUse" error={error}>
        {(label) => <Switch {...label} checked={settings.enabled} onCheckedChange={(on) => change(() => computer.settings({ enabled: on }))} />}
      </SettingRow>
      {settings.enabled && (
        <>
          <SettingRow id="system.computerUnhide" error={error}>
            {(label) => <Switch {...label} checked={settings.unhideOnFinish} onCheckedChange={(on) => change(() => computer.settings({ unhideOnFinish: on }))} />}
          </SettingRow>
          <SettingRow id="system.computerMode" error={error}>
            {(label) => <SegmentedControl {...label} items={MODES} value={settings.mode} onValueChange={(mode) => change(() => computer.settings({ mode }))} />}
          </SettingRow>
          <SettingRow id="system.computerDenied" stacked error={error}>
            <div className="flex flex-col gap-2">
              <AppList apps={settings.denied} empty="No apps denied." remove={(app) => change(() => computer.undeny(app.id))} />
              <Button size="sm" className="self-start" onClick={() => setAdding(true)}>
                Add app
              </Button>
            </div>
          </SettingRow>
          {always.length > 0 && (
            <SettingRow id="system.computerAlways" stacked error={error}>
              <AppList apps={always.map((g) => g.app)} empty="" remove={(app) => change(() => computer.revoke('local', app.id))} />
            </SettingRow>
          )}
        </>
      )}
      {status.platform === 'darwin' && (
        <>
          <PermissionRow id="system.computerAccessibility" granted={status.permissions.accessibility} kind="accessibility" />
          <PermissionRow id="system.computerScreen" granted={status.permissions.screenRecording} kind="screenRecording" />
        </>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title="Deny an app" description="Atelier won’t ask to use it; requests for it are turned down.">
          {adding && (
            <AppPicker
              denied={settings.denied}
              onPick={(app) => {
                setAdding(false);
                change(() => computer.deny(app));
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function AppList({ apps, empty, remove }: { apps: ComputerApp[]; empty: string; remove(app: ComputerApp): void }) {
  if (!apps.length) return empty ? <p className="text-body text-fg-muted">{empty}</p> : null;
  return (
    <ul className="flex flex-col gap-1">
      {apps.map((app) => (
        <li key={app.id} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-body text-fg">{app.name}</span>
          <Button size="sm" aria-label={`Remove ${app.name}`} onClick={() => remove(app)}>
            Remove
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The installed apps, searchable; the ones already denied are left out. */
function AppPicker({ denied, onPick }: { denied: ComputerApp[]; onPick(app: ComputerApp): void }) {
  const [query, setQuery] = useState('');
  const { data: apps } = useQuery({ queryKey: ['desktop', 'computer', 'apps', query], queryFn: () => desktop!.computer!.apps(query) });
  const shown = (apps ?? []).filter((a) => !denied.some((d) => d.id === a.id));
  return (
    <div className="flex flex-col gap-3">
      <TextField autoFocus aria-label="Search apps" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul aria-label="Apps" className="flex max-h-72 flex-col overflow-y-auto">
        {shown.map((app) => (
          <li key={app.id}>
            <button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg outline-none focus-ring hover:bg-fill-ghost-hover" onClick={() => onPick(app)}>
              {app.name}
            </button>
          </li>
        ))}
        {apps && !shown.length && <li className="px-2 py-1.5 text-body text-fg-muted">No app matches.</li>}
      </ul>
    </div>
  );
}

/** A macOS permission: granted, or a way to grant it (the question once, then System Settings). */
function PermissionRow({ id, granted, kind }: { id: SettingId; granted: boolean; kind: 'accessibility' | 'screenRecording' }) {
  const qc = useQueryClient();
  const { error, run } = useWrite();
  const computer = desktop!.computer!;
  return (
    <SettingRow id={id} error={error} detail={granted ? 'Granted' : 'Not granted'}>
      {!granted && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void run(() => refreshComputer(qc, () => computer.requestPermission(kind)))}>
            Grant…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void computer.openPermissionSettings(kind)}>
            Open System Settings
          </Button>
        </div>
      )}
    </SettingRow>
  );
}
