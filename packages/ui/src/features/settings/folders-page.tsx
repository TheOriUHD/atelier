import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, KeyRound, Pencil, Plus, Server, ShieldCheck, X } from 'lucide-react';
import { z } from 'zod';
import type { DeviceSummary, SshConnectionView, WorkspaceSummary } from '@atelier/protocol';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, Field, IconButton, TextField, toast } from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';
import { lendSsh, useConnection, useLending } from '../../lib/lending.ts';
import { desktop } from '../../lib/platform.ts';
import { keys, useWorkspaces } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from '../auth/form.ts';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { SshConnectionDialog } from '../ssh/connection-dialog.tsx';
import { chooseLocalFolder, requestTrust, trustWorkspace } from '../workspaces/trust.tsx';
import { useSshConnections } from '../ssh/use-ssh.ts';

/** The machine a folder is on: an SSH host, a codespace, this computer, or another of the person's devices. */
function computerOf(workspace: WorkspaceSummary, devices: DeviceSummary[] | undefined): string {
  if (workspace.kind === 'ssh') return workspace.host ?? 'SSH host';
  if (workspace.kind === 'codespace') return `Codespace ${workspace.host ?? ''}`.trim();
  // No device: the machine this backend runs on, which is only ever the desktop app's own.
  if (!workspace.deviceId) return 'This computer';
  const device = devices?.find((d) => d.id === workspace.deviceId);
  return device?.current ? 'This computer' : (device?.name ?? 'A removed device');
}

const pathOf = (w: WorkspaceSummary) => (w.host ? `${w.host}:${w.root}` : w.root);

/** The person's folders on all their computers. The desktop app adds them; any client can forget one. */
export function FoldersPage() {
  // Scratch folders belong to the sessions that started with no folder, not to this list.
  const workspaces = useWorkspaces().data?.filter((w) => !w.scratch);
  const { data: devices } = useQuery({ queryKey: keys.devices, queryFn: () => rpc().call('account.devices', {}), staleTime: 0 });
  // SSH folders are reached from this computer: by the app's own backend, or for a server that takes them from here.
  const { data: connection } = useConnection();
  const lending = useLending();
  const sshHere = connection?.mode === 'local' || lending.ssh;
  const ssh = useDialog();
  const entry = settingEntry('folders.list');

  return (
    <>
    <SettingsSection
      id="folders.list"
      title={entry.label}
      description={entry.description}
      action={
        desktop ? (
          <div className="flex gap-2">
            {sshHere && (
              <Button size="sm" leadingIcon={Server} onClick={ssh.show}>
                Add SSH folder…
              </Button>
            )}
            <OpenFolderButton />
          </div>
        ) : null
      }
    >
      {workspaces?.length === 0 ? (
        <p className="pb-3 text-body text-fg-muted">
          {desktop ? 'No folders yet. Open one to work in it in Code sessions.' : 'No folders yet. Folders come from the desktop app: open one there and it shows up here.'}
        </p>
      ) : (
        <DataTable
          label={entry.label}
          columns={[
            { label: 'Folder' },
            { label: 'Computer', className: 'w-44' },
            { label: 'Last used', className: 'w-32' },
            { label: 'Actions', hidden: true, className: 'w-20' },
          ]}
        >
          {workspaces?.map((w) => <FolderRow key={w.id} workspace={w} computer={computerOf(w, devices)} />)}
        </DataTable>
      )}
      {desktop && <SshDialog key={ssh.key} open={ssh.open} onOpenChange={ssh.onOpenChange} />}
    </SettingsSection>
    {desktop && sshHere && <SshConnectionsSection />}
    </>
  );
}

/** The person's own SSH connections: edit one, remove it, or have Atelier forget its saved password. */
function SshConnectionsSection() {
  const entry = settingEntry('folders.ssh');
  const connections = useSshConnections();
  const add = useDialog();
  return (
    <SettingsSection
      id="folders.ssh"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" leadingIcon={Plus} onClick={add.show}>
          Add SSH connection…
        </Button>
      }
    >
      {connections.length === 0 ? (
        <p className="pb-3 text-body text-fg-muted">No SSH connections yet. Add one to work in a remote machine's folders.</p>
      ) : (
        <DataTable
          label={entry.label}
          columns={[
            { label: 'Connection' },
            { label: 'Host', className: 'w-56' },
            { label: 'Actions', hidden: true, className: 'w-32' },
          ]}
        >
          {connections.map((c) => (
            <SshConnectionRow key={c.id} connection={c} />
          ))}
        </DataTable>
      )}
      <SshConnectionDialog key={`add-${add.key}`} open={add.open} onOpenChange={add.onOpenChange} />
    </SettingsSection>
  );
}

function SshConnectionRow({ connection }: { connection: SshConnectionView }) {
  const qc = useQueryClient();
  const edit = useDialog();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.ssh });
  const forget = async () => {
    try {
      await rpc().call('ssh.forgetPassword', { id: connection.id });
      await refresh();
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };
  const remove = async () => {
    try {
      await rpc().call('ssh.remove', { id: connection.id });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await refresh();
  };
  return (
    <TableRow>
      <Cell>
        <span className="flex items-center gap-2">
          <span className="truncate text-fg">{connection.name}</span>
          {connection.passwordSaved && <Badge>Password saved</Badge>}
        </span>
        {connection.folder && <span className="block truncate font-mono text-footnote text-fg-muted">{connection.folder}</span>}
      </Cell>
      <Cell>
        <span className="block truncate font-mono text-footnote">{connection.port ? `${connection.host}:${connection.port}` : connection.host}</span>
      </Cell>
      <Cell className="text-right">
        <span className="flex justify-end gap-0.5">
          {connection.passwordSaved && <IconButton icon={KeyRound} label={`Forget the saved password of ${connection.name}`} size="sm" onClick={() => void forget()} />}
          <IconButton icon={Pencil} label={`Edit ${connection.name}`} size="sm" onClick={edit.show} />
          <IconButton icon={X} label={`Remove ${connection.name}`} size="sm" onClick={() => setConfirm(true)} />
        </span>
        <SshConnectionDialog key={`edit-${edit.key}`} open={edit.open} onOpenChange={edit.onOpenChange} connection={connection} />
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Remove ${connection.name}?`}
          description="Atelier forgets this connection and its saved password. Folders you opened there stay in your list, and the machine itself is untouched."
          confirmLabel="Remove"
          onConfirm={remove}
        />
      </Cell>
    </TableRow>
  );
}

function FolderRow({ workspace, computer }: { workspace: WorkspaceSummary; computer: string }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const remove = async () => {
    try {
      await rpc().call('workspaces.remove', { id: workspace.id });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await qc.invalidateQueries({ queryKey: keys.workspaces });
  };
  const trust = async () => {
    try {
      await trustWorkspace(workspace);
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await qc.invalidateQueries({ queryKey: keys.workspaces });
  };

  return (
    <TableRow>
      <Cell title={pathOf(workspace)}>
        <span className="flex items-center gap-2">
          <span className="truncate text-fg">{workspace.name}</span>
          {workspace.kind === 'ssh' && <Badge>SSH</Badge>}
          {workspace.kind === 'codespace' && <Badge>Codespace</Badge>}
          {workspace.trusted === false && (
            <Badge tone="warning" title="Its own settings, hooks and instruction files are ignored until you trust it.">
              Not trusted
            </Badge>
          )}
        </span>
        <span className="block truncate font-mono text-footnote text-fg-muted">{pathOf(workspace)}</span>
      </Cell>
      <Cell>
        <span className="flex items-center gap-2">
          <span className="truncate">{computer}</span>
          {!workspace.available && <Badge>Offline</Badge>}
        </span>
      </Cell>
      <Cell>{relativeTime(workspace.lastUsedAt)}</Cell>
      <Cell className="text-right">
        <span className="flex items-center justify-end gap-0.5">
          {workspace.trusted === false && (
            <IconButton icon={ShieldCheck} label={`Trust ${workspace.name}`} size="sm" onClick={() => void trust()} />
          )}
          <IconButton icon={X} label={`Remove ${workspace.name}`} size="sm" onClick={() => setConfirm(true)} />
        </span>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Remove ${workspace.name}?`}
          description="Atelier only forgets this folder. Nothing in it is deleted, and you can open it again any time."
          confirmLabel="Remove"
          onConfirm={remove}
        />
      </Cell>
    </TableRow>
  );
}

/** The native folder picker trusts the folder on this machine; the backend then adds it (its git top level). */
function OpenFolderButton() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const open = async () => {
    try {
      const path = await chooseLocalFolder();
      if (!path) return;
      setAdding(true);
      await rpc().call('workspaces.addLocal', { path });
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setAdding(false);
    }
    await qc.invalidateQueries({ queryKey: keys.workspaces });
  };

  return (
    <Button size="sm" variant="primary" leadingIcon={FolderOpen} loading={adding} onClick={() => void open()}>
      Open folder…
    </Button>
  );
}

const SshFolder = z.object({
  host: z.string().trim().min(1, 'Choose a host or enter user@host.'),
  path: z.string().trim().min(1, 'Enter a folder on the host, like ~/projects/app.'),
});

/** Adds a folder on an SSH host (`host` fills in the host); `onAdded` hears of the new folder. */
export function SshDialog({ open, onOpenChange, host = '', onAdded }: { open: boolean; onOpenChange(open: boolean): void; host?: string; onAdded?(folder: WorkspaceSummary): void }) {
  const qc = useQueryClient();
  const hostList = useId();
  const { data: config } = useQuery({ queryKey: ['sshHosts'], queryFn: () => rpc().call('workspaces.sshHosts', {}), enabled: open, staleTime: 0 });
  const connections = useSshConnections();
  // The person's connections first, then what ~/.ssh/config offers.
  const hosts = [...new Set([...connections.map((c) => c.host), ...(config ?? [])])];
  const [values, setValues] = useState({ host, path: connections.find((c) => c.host === host)?.folder ?? '' });
  const form = useFormSubmit(SshFolder, {}, async (v) => {
    if (!(await requestTrust(v.path, v.host))) return;
    // Added on this computer: a server may reach the host from here.
    await lendSsh(v.host);
    const added = await rpc().call('workspaces.addSsh', v);
    await qc.invalidateQueries({ queryKey: keys.workspaces });
    onOpenChange(false);
    onAdded?.(added);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add SSH folder"
        description="Atelier connects with your ssh setup: ~/.ssh/config, your keys and agent. The first folder on a host takes a few seconds while Atelier copies its runner there."
      >
        <form noValidate onSubmit={form.onSubmit(values)} className="flex flex-col gap-4">
          <Field label="Host" description="A host from ~/.ssh/config, or user@host." error={form.errors.host}>
            <TextField
              autoFocus={!host}
              list={hostList}
              value={values.host}
              onChange={(e) => setValues((v) => ({ ...v, host: e.target.value }))}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <datalist id={hostList}>
              {hosts.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </Field>
          <Field label="Folder" description="An absolute path, or one in the home folder like ~/projects/app." error={form.errors.path}>
            <TextField
              autoFocus={!!host}
              value={values.path}
              onChange={(e) => setValues((v) => ({ ...v, path: e.target.value }))}
              placeholder="~/projects/app"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          {form.errors.form && (
            <p role="alert" className="text-footnote text-danger-text">
              {form.errors.form}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              Add folder
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
