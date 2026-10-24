/**
 * The chips above the Code and Cowork composers (design/components.md › Above the Code composer): where to work
 * (this computer, a codespace, another computer of the person's, an SSH host), the folder there (or no folder), and
 * adding one.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, FolderClosed, FolderDot, FolderPlus, Laptop, Monitor, Plug, Plus, Server, type LucideIcon } from 'lucide-react';
import type { CodespaceSummary, SshConnectionView, WorkspaceSummary } from '@atelier/protocol';
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuTrigger,
  toast,
} from '../../components/ui/index.ts';
import { lendSsh, useLending } from '../../lib/lending.ts';
import { desktop } from '../../lib/platform.ts';
import { keys, useWorkspaces } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { CODESPACE_STATES } from '../settings/cloud-page.tsx';
import { RemoteFolderDialog } from '../ssh/remote-folder-dialog.tsx';
import { chooseLocalFolder, codespaceWhere, requestTrust } from '../workspaces/trust.tsx';
import { SshConnectionDialog } from '../ssh/connection-dialog.tsx';
import { sshName, useSshConnections } from '../ssh/use-ssh.ts';
import { useDialog } from '../settings/use-dialog.ts';
import { OpenRepoDialog } from './open-repo-dialog.tsx';
import { NO_FOLDER, environmentOf, initialChoice, initialWorkspace, recentWorkspaces, workspaceLabel, type Environment, type FolderChoice } from './workspaces.ts';

export const NO_FOLDER_HINT = 'Open the desktop app to work in a folder on your computer, or use a codespace.';
/** Other computers' folders are the ones their desktop app opened. */
const OPEN_IN_DESKTOP = 'Open folders in the desktop app first';

const ENVIRONMENTS: Record<Environment, { label: string; icon: LucideIcon }> = {
  local: { label: 'Local', icon: Laptop },
  cloud: { label: 'Cloud', icon: Cloud },
  remote: { label: 'Remote Control', icon: Monitor },
  ssh: { label: 'SSH', icon: Server },
};

/** Chips are secondary 28px buttons with 13px labels. */
const CHIP_CLASS = 'px-2 text-control-sm';

const envOf = (w: WorkspaceSummary) => environmentOf(w, desktop?.device.id);

/** Whether the desktop app runs its own backend ("Run on this computer"); SSH hosts are reached from it. */
function useOwnBackend(): boolean {
  const { data } = useQuery({ queryKey: ['connection'], queryFn: () => desktop!.connection.get(), enabled: !!desktop });
  return data?.mode === 'local';
}

/**
 * The environments this app offers: this computer only in the desktop app; SSH hosts with its own backend, or reached
 * from it for a server that takes them.
 */
function useEnvironments(): Environment[] {
  const ownBackend = useOwnBackend();
  const lending = useLending();
  if (!desktop) return ['cloud', 'remote'];
  return ownBackend || lending.ssh ? ['local', 'cloud', 'remote', 'ssh'] : ['local', 'cloud', 'remote'];
}

function storedEnvironment(key: string): Environment | null {
  try {
    return localStorage.getItem(key) as Environment | null;
  } catch {
    return null;
  }
}

/**
 * Where a home's folders come from: the requested folder's environment, else the person's last pick for this mode
 * (kept in this browser), else this computer in the desktop app and the most recent folder's elsewhere. No folder
 * (`NO_FOLDER`) comes from the app's own backend: on `requestedHost` over SSH, else on this computer, whatever
 * environment was picked last. `folders` are that environment's folders of the person's, most recent first; `choice`
 * is what a new session starts in, and `scratchHost` where no folder is offered (null for this computer, undefined
 * where it isn't).
 */
export function useEnvironment(mode: 'code' | 'work', requested: string | undefined, requestedHost?: string) {
  const key = `atelier.environment.${mode}`;
  const { data: workspaces = [] } = useWorkspaces();
  const offered = useEnvironments();
  const ownBackend = useOwnBackend();
  const lending = useLending();
  // Where no folder can be offered: this computer and SSH hosts, with the app's own backend or where it lends them to a server.
  const scratchHere = ownBackend || lending.scratch;
  const scratchOnSsh = ownBackend || lending.ssh;
  const [picked, setPicked] = useState(() => storedEnvironment(key));
  const asked = workspaces.find((w) => w.id === requested);
  const latest = initialWorkspace(workspaces, undefined);
  const remembered = picked && offered.includes(picked) ? picked : null;
  const environment: Environment = asked
    ? envOf(asked)
    : requested === NO_FOLDER && (requestedHost ? scratchOnSsh : scratchHere)
      ? requestedHost
        ? 'ssh'
        : 'local'
      : (remembered ?? (desktop ? 'local' : latest ? envOf(latest) : 'cloud'));
  const here = recentWorkspaces(workspaces.filter((w) => envOf(w) === environment));
  // On SSH: the host asked for (or the folder's), else the one of the latest session there.
  const scratchHost =
    environment === 'local' && scratchHere
      ? null
      : environment === 'ssh' && scratchOnSsh
        ? (requestedHost ?? asked?.host ?? here[0]?.host ?? undefined)
        : undefined;
  const choose = (next: Environment) => {
    try {
      localStorage.setItem(key, next);
    } catch {
      // Storage unavailable; the pick still holds on this page.
    }
    setPicked(next);
  };
  return { environment, folders: here.filter((w) => !w.scratch), choice: initialChoice(here, requested, scratchHost), scratchHost, choose };
}

/** Where a folder lives when it isn't on a computer of yours: an SSH host or a codespace. */
function KindBadge({ workspace, className }: { workspace: WorkspaceSummary; className?: string }) {
  if (workspace.kind === 'local') return null;
  return <Badge className={className}>{workspace.kind === 'ssh' ? 'SSH' : 'Codespace'}</Badge>;
}

export interface WorkspaceChipsProps {
  environment: Environment;
  /** The environment's folders of the person's (no scratch folders), most recent first. */
  folders: WorkspaceSummary[];
  value: FolderChoice | undefined;
  /** Whether the folder menu offers No folder (a new scratch folder for each session). */
  noFolder: boolean;
  /** Picks an environment, and a folder there (else its most recent one), or `NO_FOLDER` on an SSH `host`. */
  onEnvironmentChange(environment: Environment, folderId?: string, host?: string): void;
  /** A folder's id, or `NO_FOLDER`. */
  onChange(folderId: string): void;
}

/** The environment chip, the folder chip and the add-folder button. */
export function WorkspaceChips({ environment, folders, value, noFolder, onEnvironmentChange, onChange }: WorkspaceChipsProps) {
  const qc = useQueryClient();
  const { data: workspaces = [] } = useWorkspaces();
  const offered = useEnvironments();
  const ownBackend = useOwnBackend();
  const remote = recentWorkspaces(workspaces.filter((w) => envOf(w) === 'remote'));
  const { data: devices } = useQuery({ queryKey: keys.devices, queryFn: () => rpc().call('account.devices', {}), enabled: remote.length > 0 });
  const computerName = (id: string | null) => devices?.find((d) => d.id === id)?.name ?? 'Another computer';
  // Other computers with folders, most recently used first; offline while none of their folders can be reached.
  const computers = [...new Set(remote.map((w) => w.deviceId!))].map((id) => ({ id, online: remote.some((w) => w.deviceId === id && w.available) }));
  const sshHosts = [...new Set(workspaces.filter((w) => envOf(w) === 'ssh').map((w) => w.host!))];
  const [adding, setAdding] = useState(false);
  const browse = useDialog();
  const sshConnection = useDialog();
  const connections = useSshConnections();
  const codespace = useDialog();
  const folder = value?.kind === 'folder' ? value.workspace : undefined;
  const host = value?.kind === 'folder' ? value.workspace.host : value?.host;

  /** Adds a folder with the folder chip busy, then works in it. */
  const run = async (env: Environment, add: () => Promise<WorkspaceSummary | null>) => {
    setAdding(true);
    try {
      const added = await add();
      if (!added) return;
      await qc.invalidateQueries({ queryKey: keys.workspaces });
      onEnvironmentChange(env, added.id);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setAdding(false);
    }
  };
  const openFolder = () =>
    void run('local', async () => {
      const path = await chooseLocalFolder();
      return path ? rpc().call('workspaces.addLocal', { path }) : null;
    });
  /** A folder on the chosen SSH host, picked in the remote folder browser and trusted first. */
  const browseRemote = () => {
    if (host) void lendSsh(host).then(browse.show, (e: unknown) => toast.error(describeError(e).message));
    else toast.error('Choose an SSH connection first.');
  };
  const chooseRemote = (path: string) => {
    browse.onOpenChange(false);
    const picked = host!;
    void run('ssh', async () => {
      const known = workspaces.some((w) => w.kind === 'ssh' && w.host === picked && w.root === path && (!w.deviceId || w.deviceId === desktop?.device.id));
      if (!known && !(await requestTrust(path, picked))) return null;
      // Chosen on this computer: a server may reach the host from here.
      await lendSsh(picked);
      return rpc().call('workspaces.addSsh', { host: picked, path });
    });
  };
  /** A codespace's checkout is its folder; picking one that isn't yet makes it one, after "Trust this workspace?". */
  const pickCodespace = (picked: CodespaceSummary) => {
    const folder = workspaces.find((w) => w.kind === 'codespace' && w.host === picked.name);
    if (folder) onEnvironmentChange('cloud', folder.id);
    else
      void run('cloud', async () => {
        if (!(await requestTrust(picked.repo, codespaceWhere(picked.name)))) return null;
        return rpc().call('workspaces.addCodespace', { name: picked.name, trust: true });
      });
  };
  /** A host's latest session decides, as on the home: its folder, or no folder (also on a host without folders yet). */
  const pickHost = (picked: string) => {
    void lendSsh(picked).catch(() => undefined);
    const latest = recentWorkspaces(workspaces.filter((w) => envOf(w) === 'ssh' && w.host === picked))[0];
    if (latest && !latest.scratch) onEnvironmentChange('ssh', latest.id);
    else onEnvironmentChange('ssh', NO_FOLDER, picked);
  };
  const add = { local: { label: 'Open folder…', run: openFolder }, cloud: { label: 'Open a repository…', run: codespace.show }, ssh: { label: 'Browse remote folder…', run: browseRemote }, remote: null }[environment];
  const label = environment === 'remote' && folder ? computerName(folder.deviceId) : environment === 'ssh' && host ? sshName(connections, host) : ENVIRONMENTS[environment].label;

  return (
    <>
      <Menu>
        <MenuTrigger render={<Button size="sm" leadingIcon={ENVIRONMENTS[environment].icon} aria-label={`Environment: ${label}`} className={CHIP_CLASS} />}>
          <span className="max-w-40 truncate">{label}</span>
        </MenuTrigger>
        <MenuContent className="w-[200px]">
          {offered.includes('local') && (
            <MenuRadioGroup value={environment} onValueChange={(env: Environment) => onEnvironmentChange(env)}>
              <MenuRadioItem value="local" icon={Laptop} closeOnClick>
                Local
              </MenuRadioItem>
            </MenuRadioGroup>
          )}
          <MenuSubmenu label="Cloud" icon={Cloud} className="w-72">
            <CodespaceItems current={environment === 'cloud' ? folder?.host : undefined} onPick={pickCodespace} onConnect={codespace.show} />
            <MenuSeparator />
            <MenuItem icon={Plus} onClick={codespace.show}>
              Open a repository…
            </MenuItem>
          </MenuSubmenu>
          <MenuSubmenu label="Remote Control" icon={Monitor} className="w-80">
            {computers.length ? (
              <MenuRadioGroup
                value={environment === 'remote' ? (folder?.deviceId ?? '') : ''}
                onValueChange={(id: string) => onEnvironmentChange('remote', initialWorkspace(remote.filter((w) => w.deviceId === id), undefined)?.id)}
              >
                {computers.map((c) => (
                  <MenuRadioItem key={c.id} value={c.id} icon={Monitor} disabled={!c.online} description={c.online ? undefined : 'Offline'} closeOnClick>
                    {computerName(c.id)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            ) : (
              <MenuItem disabled description={ownBackend ? 'Shown when connected to an Atelier server' : OPEN_IN_DESKTOP}>
                No other computers
              </MenuItem>
            )}
          </MenuSubmenu>
          {offered.includes('ssh') && (
            <MenuSubmenu label="SSH" icon={Server} className="w-64">
              <SshHostItems known={sshHosts} connections={connections} current={environment === 'ssh' ? host : undefined} onPick={pickHost} />
              <MenuSeparator />
              <MenuItem icon={Plus} onClick={sshConnection.show}>
                Add SSH connection…
              </MenuItem>
            </MenuSubmenu>
          )}
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger render={<Button size="sm" leadingIcon={value?.kind === 'none' || folder?.scratch ? FolderDot : FolderClosed} loading={adding} className={CHIP_CLASS} />}>
          <span className="max-w-60 truncate">{folder ? workspaceLabel(folder) : value ? 'No folder' : 'Select folder…'}</span>
          {folder && <KindBadge workspace={folder} />}
        </MenuTrigger>
        {/* Plain rows: the path (and the computer) is the row's tooltip and accessible description. */}
        <MenuContent className="w-72">
          {noFolder && (
            <MenuRadioGroup value={value?.kind === 'none' ? NO_FOLDER : folder?.scratch ? folder.id : ''} onValueChange={(id: string) => onChange(id)}>
              <MenuRadioItem value={NO_FOLDER} icon={FolderDot} title="A new, empty folder for each session" closeOnClick>
                No folder
              </MenuRadioItem>
              {/* `/clear` goes on in its session's scratch folder. */}
              {folder?.scratch && (
                <MenuRadioItem value={folder.id} icon={FolderDot} title={folder.root} closeOnClick>
                  {workspaceLabel(folder)}
                </MenuRadioItem>
              )}
            </MenuRadioGroup>
          )}
          {noFolder && folders.length > 0 && <MenuSeparator />}
          {folders.length > 0 && (
            <MenuGroup>
              <MenuLabel>Recent</MenuLabel>
              <MenuRadioGroup value={folder?.id ?? ''} onValueChange={(id: string) => onChange(id)}>
                {folders.map((w) => (
                  <MenuRadioItem
                    key={w.id}
                    value={w.id}
                    icon={FolderClosed}
                    disabled={!w.available}
                    closeOnClick
                    title={environment === 'remote' ? `${computerName(w.deviceId)} · ${w.root}` : w.kind === 'ssh' ? workspaceLabel(w) : w.root}
                    description={w.available ? undefined : 'Its computer is offline'}
                  >
                    {workspaceLabel(w)}
                    <KindBadge workspace={w} className="ml-1.5" />
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          )}
          {add ? (
            <>
              {(noFolder || folders.length > 0) && <MenuSeparator />}
              <MenuItem icon={FolderPlus} onClick={add.run}>
                {add.label}
              </MenuItem>
            </>
          ) : (
            !noFolder &&
            !folders.some((w) => w.available) && (
              <MenuItem disabled description={OPEN_IN_DESKTOP}>
                No folder available
              </MenuItem>
            )
          )}
        </MenuContent>
      </Menu>
      {add && <IconButton icon={FolderPlus} label={add.label} variant="secondary" size="sm" onClick={add.run} />}
      {desktop && host && (
        <RemoteFolderDialog
          key={`browse-${browse.key}`}
          open={browse.open}
          onOpenChange={browse.onOpenChange}
          host={host}
          {...(connections.find((c) => c.host === host)?.folder ? { start: connections.find((c) => c.host === host)!.folder! } : {})}
          onSelect={chooseRemote}
        />
      )}
      {desktop && <SshConnectionDialog key={`sshc-${sshConnection.key}`} open={sshConnection.open} onOpenChange={sshConnection.onOpenChange} onSaved={(c) => pickHost(c.host)} />}
      <OpenRepoDialog key={codespace.key} open={codespace.open} onOpenChange={codespace.onOpenChange} onOpened={(w) => onEnvironmentChange('cloud', w.id)} />
    </>
  );
}

/** The person's codespaces with their state (asked for when the submenu opens). */
function CodespaceItems({ current, onPick, onConnect }: { current: string | null | undefined; onPick(codespace: CodespaceSummary): void; onConnect(): void }) {
  const github = useQuery({ queryKey: keys.github, queryFn: () => rpc().call('github.status', {}), staleTime: 0 });
  const connected = !!github.data?.connected;
  const { data, error } = useQuery({ queryKey: keys.codespaces, queryFn: () => rpc().call('codespaces.list', {}), staleTime: 0, enabled: connected });
  if (github.data && !connected)
    return (
      <MenuItem icon={Plug} description="Your codespaces are on your GitHub account" onClick={onConnect}>
        Connect GitHub…
      </MenuItem>
    );
  if (error)
    return (
      <MenuItem disabled description={describeError(error).message}>
        No codespaces
      </MenuItem>
    );
  if (!data) return null;
  if (!data.length) return <MenuItem disabled>No codespaces yet</MenuItem>;
  return (
    <MenuRadioGroup
      value={current ?? ''}
      onValueChange={(name: string) => {
        const picked = data.find((c) => c.name === name);
        if (picked) onPick(picked);
      }}
    >
      {data.map((c) => {
        const [state, tone] = CODESPACE_STATES[c.state] ?? [c.state, 'neutral'];
        return (
          <MenuRadioItem key={c.name} value={c.name} icon={Cloud} description={c.repo} closeOnClick>
            {c.displayName}
            <Badge tone={tone} className="ml-1.5">
              {state}
            </Badge>
          </MenuRadioItem>
        );
      })}
    </MenuRadioGroup>
  );
}

/** Hosts from ~/.ssh/config (asked for when the submenu opens) and those of the person's SSH folders. */
function SshHostItems({
  known,
  connections,
  current,
  onPick,
}: {
  known: string[];
  connections: readonly SshConnectionView[];
  current: string | null | undefined;
  onPick(host: string): void;
}) {
  // The person's own connections; a host that has folders but no connection (added before) stays reachable.
  const rows = [...connections.map((c) => ({ host: c.host, name: c.name })), ...known.filter((h) => !connections.some((c) => c.host === h)).map((h) => ({ host: h, name: h }))];
  if (!rows.length) return <MenuItem disabled>No SSH connections yet</MenuItem>;
  return (
    <MenuRadioGroup value={current ?? ''} onValueChange={(host: string) => onPick(host)}>
      {rows.map((r) => (
        <MenuRadioItem key={r.host} value={r.host} icon={Server} {...(r.name !== r.host ? { description: r.host } : {})} closeOnClick>
          {r.name}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/** The session header's folder chip, with where it lives and an Offline badge. */
export function FolderBadge({ workspace }: { workspace: WorkspaceSummary }) {
  return (
    <>
      <span title={workspace.root} className="flex h-6 min-w-0 items-center gap-1 rounded-sm bg-badge-bg px-1.5 text-footnote text-fg-secondary">
        <Icon icon={FolderClosed} className="size-3.5" />
        <span className="truncate">{workspaceLabel(workspace)}</span>
      </span>
      <KindBadge workspace={workspace} />
      {workspace.trusted === false && (
        <Badge tone="warning" title="Its own settings, hooks and instruction files are ignored until you trust it (Settings › Folders).">
          Not trusted
        </Badge>
      )}
      {!workspace.available && <Badge tone="warning">Offline</Badge>}
    </>
  );
}
