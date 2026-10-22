import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CircleCheck, Hand, Import, LogOut, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { CONNECTOR_PRESETS, mcpToolName, type McpServerConfig, type McpServerStatus } from '@atelier/protocol';
import {
  Badge,
  Button,
  ConfirmDialog,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SegmentedControl,
  Spinner,
  Switch,
  cn,
  toast,
  type SegmentedControlItem,
} from '../../components/ui/index.ts';
import { keys, useAppInfo, useMcpStatus, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { AddConnectorDialog, EditConnectorDialog, ImportDialog, TYPE_LABELS, connectorIcon, connectorTarget, openSignIn } from './connector-dialogs.tsx';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { ITEM_ROW_CLASS } from './item-row.tsx';
import { plural } from './provider-wizard.tsx';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { useSetting } from './use-setting.ts';

type State = McpServerStatus['state'];
type SignIn = McpServerStatus['signIn'];
type Tool = McpServerStatus['tools'][number];
type Policy = 'allow' | 'ask' | 'deny';

const STATE_LABELS: Record<State, string> = { connecting: 'Connecting', ready: 'Ready', error: 'Error', disabled: 'Off' };
const DOT_CLASS: Record<Exclude<State, 'connecting'>, string> = { ready: 'bg-success', error: 'bg-danger', disabled: 'bg-line-stronger' };

/** A per-tool control, as permission rules on `mcp__server__tool`. Connector tools ask unless a rule says otherwise. */
const POLICIES: SegmentedControlItem<Policy>[] = [
  { value: 'allow', label: 'Always allow', icon: CircleCheck },
  { value: 'ask', label: 'Ask', icon: Hand },
  { value: 'deny', label: 'Block', icon: Ban },
];

/** Every connector's live status. Asking connects the servers not tried yet; `mcp.changed` keeps it current. */
/** The status shown for a connector: switched off wins, and a server not reported yet is about to connect. */
function stateOf(config: McpServerConfig, status: McpServerStatus | undefined): State {
  return config.enabled ? (status?.state ?? 'connecting') : 'disabled';
}

/** Signing an OAuth connector in, from its row or its page; the sign-in page opens in a new tab or the browser. */
function useSignIn(name: string) {
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      await openSignIn(name);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setStarting(false);
    }
  };
  const cancel = () => rpc().call('mcp.cancelSignIn', { name }).catch((e: unknown) => void toast.error(describeError(e).message));
  return { starting, start, cancel };
}

/** MCP servers in the system settings, their live state, and one connector's tools. */
export function ConnectorsPage() {
  const { settings } = useSettings();
  const statuses = useMcpStatus();
  const { data: app } = useAppInfo();
  // stdio servers and the import run where the backend runs: only the desktop app's own backend may.
  const desktop = app?.surface === 'desktop';
  const [open, setOpen] = useState<string | null>(null);
  const servers = settings?.mcpServers ?? {};
  const config = open === null ? undefined : servers[open];
  const status = (name: string) => statuses?.find((s) => s.name === name);

  if (open !== null && config) {
    return <ConnectorDetail name={open} config={config} status={status(open)} desktop={desktop} onBack={() => setOpen(null)} />;
  }
  return <ConnectorList servers={servers} status={status} desktop={desktop} onOpen={setOpen} />;
}

function ConnectorList({
  servers,
  status,
  desktop,
  onOpen,
}: {
  servers: Record<string, McpServerConfig>;
  status(name: string): McpServerStatus | undefined;
  desktop: boolean;
  onOpen(name: string): void;
}) {
  const add = useDialog();
  const importing = useDialog();
  const entry = settingEntry('connectors.list');
  const names = Object.keys(servers);
  const taken = new Set(names);
  return (
    <>
      <SettingsSection
        id="connectors.list"
        title={entry.label}
        description={entry.description}
        action={
          <div className="flex items-center gap-2">
            {desktop && (
              <Button size="sm" leadingIcon={Import} onClick={importing.show}>
                Import from Claude Code
              </Button>
            )}
            <Button size="sm" variant="primary" leadingIcon={Plus} onClick={add.show}>
              Add connector
            </Button>
          </div>
        }
      >
        {names.length === 0 ? (
          <p className="pb-3 text-body text-fg-muted">No connectors yet. Add one to give sessions tools from other services.</p>
        ) : (
          <DataTable
            label={entry.label}
            columns={[
              { label: 'Connector' },
              { label: 'Type', className: 'w-24' },
              { label: 'Status', className: 'w-36' },
              { label: 'Tools', className: 'w-20' },
              { label: 'Enabled', hidden: true, className: 'w-12' },
            ]}
          >
            {names.map((name) => (
              <ConnectorRow key={name} name={name} config={servers[name]!} status={status(name)} onOpen={() => onOpen(name)} />
            ))}
          </DataTable>
        )}
      </SettingsSection>
      <AddConnectorDialog key={add.key} open={add.open} onOpenChange={add.onOpenChange} desktop={desktop} taken={taken} onAdded={onOpen} />
      {desktop && <ImportDialog key={importing.key} open={importing.open} onOpenChange={importing.onOpenChange} taken={taken} />}
    </>
  );
}

function ConnectorRow({ name, config, status, onOpen }: { name: string; config: McpServerConfig; status: McpServerStatus | undefined; onOpen(): void }) {
  const enabled = useSetting<boolean>(['mcpServers', name, 'enabled'], { toast: true });
  const signing = useSignIn(name);
  const state = stateOf(config, status);
  const signIn = state === 'error' ? status?.signIn : undefined;
  const on = status?.tools.filter((t) => t.enabled).length ?? 0;
  const total = status?.tools.length ?? 0;
  return (
    // The name's button covers the row, so the whole row opens the connector; the switch sits above it.
    <TableRow className="relative hover:bg-fill-ghost-hover">
      <Cell>
        <button type="button" onClick={onOpen} className="flex max-w-full items-center gap-3 rounded-sm text-left outline-none focus-ring after:absolute after:inset-0">
          <ConnectorTile preset={config.preset} />
          <span className="truncate text-fg">{name}</span>
        </button>
        {state === 'error' && status?.error && !signIn && (
          <p title={status.error} className="truncate pl-[34px] text-footnote text-danger-text">
            {status.error}
          </p>
        )}
      </Cell>
      <Cell>{TYPE_LABELS[config.type]}</Cell>
      <Cell>
        {signIn === 'needed' ? (
          <Button size="xs" className="relative" loading={signing.starting} onClick={() => void signing.start()}>
            Sign in
          </Button>
        ) : (
          <StateLabel state={state} signIn={signIn} />
        )}
      </Cell>
      <Cell>{state === 'ready' ? (on === total ? total : `${on} of ${total}`) : '—'}</Cell>
      <Cell className="text-right">
        <Switch className="relative" aria-label={`Enable ${name}`} checked={config.enabled} onCheckedChange={(v) => void enabled.set(v)} />
      </Cell>
    </TableRow>
  );
}

/**
 * Customize › Connectors for everyone but admins: the connectors set up on this server, whether they work and the
 * tools they bring. Admins manage them; people switch them per conversation under + › Connectors.
 */
export function ConnectorsOverview() {
  const statuses = useMcpStatus();
  return (
    <SettingsSection
      title="Connectors"
      description="Tools from other services for your conversations. An admin sets them up; choose which ones a conversation uses under + › Connectors."
    >
      {statuses?.length === 0 && <p className="pb-3 text-body text-fg-muted">No connectors yet.</p>}
      {!!statuses?.length && (
        <DataTable
          label="Connectors"
          columns={[
            { label: 'Connector' },
            { label: 'Type', className: 'w-24' },
            { label: 'Status', className: 'w-36' },
          ]}
        >
          {statuses.map((s) => (
            <TableRow key={s.name}>
              <Cell>
                <span className="flex items-center gap-3">
                  <ConnectorTile preset={undefined} />
                  <span className="truncate text-fg">{s.name}</span>
                </span>
                {s.tools.length > 0 && (
                  <p title={s.tools.map((t) => t.name).join(', ')} className="truncate pl-[34px] text-footnote text-fg-muted">
                    {plural(s.tools.length, 'tool')}: {s.tools.map((t) => t.name).join(', ')}
                  </p>
                )}
              </Cell>
              <Cell>{TYPE_LABELS[s.type]}</Cell>
              <Cell>
                <StateLabel state={s.state} />
              </Cell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </SettingsSection>
  );
}

/** The 22px tile with the connector's glyph (r6, 1px ring). */
function ConnectorTile({ preset }: { preset: string | undefined }) {
  return (
    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-sm text-fg-secondary inset-ring inset-ring-line">
      <Icon icon={connectorIcon(preset)} className="size-3.5" />
    </span>
  );
}

/** An OAuth connector without a sign-in shows that instead of an error. */
function StateLabel({ state, signIn }: { state: State; signIn?: SignIn }) {
  return (
    <span className="flex items-center gap-1.5">
      {state === 'connecting' || signIn === 'waiting' ? (
        <Spinner className="size-3" />
      ) : (
        <span aria-hidden className={cn('size-1.5 rounded-full', signIn ? 'bg-line-stronger' : DOT_CLASS[state])} />
      )}
      {signIn === 'waiting' ? 'Waiting for sign-in' : signIn === 'needed' ? 'Not signed in' : STATE_LABELS[state]}
    </span>
  );
}

function ConnectorDetail({
  name,
  config,
  status,
  desktop,
  onBack,
}: {
  name: string;
  config: McpServerConfig;
  status: McpServerStatus | undefined;
  desktop: boolean;
  onBack(): void;
}) {
  const qc = useQueryClient();
  const edit = useDialog();
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signing = useSignIn(name);
  const rules = useRuleLists();
  const preset = CONNECTOR_PRESETS.find((p) => p.id === config.preset);
  const state = stateOf(config, status);
  const signIn = state === 'error' ? status?.signIn : undefined;
  // Changing the server's settings reconnects it; its tools stay listed meanwhile, so the switch just used stays put.
  const [known, setKnown] = useState<Tool[]>([]);
  if (status?.tools.length && status.tools !== known) setKnown(status.tools);
  const tools = status?.tools.length ? status.tools : state === 'connecting' ? known : [];

  const test = async () => {
    setTesting(true);
    try {
      const result = await rpc().call('mcp.test', { name });
      qc.setQueryData<McpServerStatus[]>(keys.mcp, (list) => list?.map((s) => (s.name === name ? result : s)));
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setTesting(false);
    }
  };

  const signOut = async () => {
    try {
      await rpc().call('mcp.signOut', { name });
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };

  const remove = async () => {
    try {
      await rpc().call('settings.reset', { layer: 'global', path: ['mcpServers', name] });
      await rules.forget(name);
      await qc.invalidateQueries({ queryKey: keys.settings });
      onBack();
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };

  const meta = [
    state === 'ready' ? plural(tools.length, 'tool') : null,
    status?.protocolEra === 'modern' ? 'MCP 2026-07-28' : status?.protocolEra === 'legacy' ? 'MCP 2025 or earlier' : null,
  ].filter(Boolean);

  return (
    <>
      <button type="button" onClick={onBack} className="-mt-1 mb-4 flex items-center gap-1.5 rounded-sm text-body text-fg-secondary outline-none focus-ring hover:text-fg">
        <Icon icon={ArrowLeft} />
        All connectors
      </button>
      <div className="flex items-center gap-2.5">
        <ConnectorTile preset={config.preset} />
        <h2 className="truncate text-section-heading text-fg">{name}</h2>
        <Badge>{TYPE_LABELS[config.type]}</Badge>
        <span className="flex-1" />
        {signIn === 'needed' ? (
          <Button variant="primary" loading={signing.starting} onClick={() => void signing.start()}>
            Sign in
          </Button>
        ) : (
          <Button disabled={!config.enabled || signIn === 'waiting'} loading={testing} onClick={() => void test()}>
            Test connection
          </Button>
        )}
        <Menu>
          <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${name} options`} />} />
          <MenuContent align="end">
            <MenuItem icon={Pencil} onClick={edit.show}>
              Edit
            </MenuItem>
            {config.auth && config.enabled && !signIn && (
              <MenuItem icon={LogOut} onClick={() => setSigningOut(true)}>
                Sign out
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onClick={() => setRemoving(true)}>
              Remove
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {preset && <p className="mt-3 text-body text-fg-secondary">{preset.description}</p>}
      <p title={connectorTarget(config)} className="mt-2 truncate font-mono text-code text-fg-muted">
        {connectorTarget(config)}
      </p>
      <div aria-live="polite" className="mt-2 flex items-center gap-1.5 text-footnote text-fg-muted">
        <span className="text-fg-secondary">
          <StateLabel state={state} signIn={signIn} />
        </span>
        {meta.map((m) => (
          <span key={m}>· {m}</span>
        ))}
      </div>
      {state === 'error' && status?.error && (
        <p role="alert" className="mt-2 text-body text-danger-text">
          {status.error}
        </p>
      )}
      {signIn === 'needed' && <p className="mt-2 text-body text-fg-secondary">Sign in to connect it. Every session then uses this sign-in.</p>}
      {signIn === 'waiting' && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg-secondary">
          <span>Waiting for you to sign in {desktop ? 'in your browser' : 'in the other tab'}…</span>
          <Button size="sm" variant="ghost" loading={signing.starting} onClick={() => void signing.start()}>
            Open it again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void signing.cancel()}>
            Cancel
          </Button>
        </div>
      )}
      <SettingsSection title="Tools" description="Switch a tool off to keep it from models. Tools ask before they run unless you always allow or block them.">
        {tools.length > 0 ? (
          <ul aria-label={`Tools of ${name}`}>
            {tools.map((tool) => (
              <ToolRow key={tool.name} server={name} tool={tool} config={config} rules={rules} />
            ))}
          </ul>
        ) : (
          <p className="pb-3 text-body text-fg-muted">
            {state === 'connecting'
              ? 'Connecting…'
              : state === 'disabled'
                ? 'Switch the connector on to see its tools.'
                : signIn
                  ? 'Its tools show up once it’s signed in.'
                  : state === 'error'
                    ? 'Its tools show up once it connects.'
                    : 'This server has no tools.'}
          </p>
        )}
      </SettingsSection>
      <EditConnectorDialog key={edit.key} open={edit.open} onOpenChange={edit.onOpenChange} name={name} config={config} desktop={desktop} />
      <ConfirmDialog
        open={signingOut}
        onOpenChange={setSigningOut}
        title={`Sign out of ${name}?`}
        description="Atelier forgets what the sign-in gave it. Its tools stop working in every session until an admin signs in again."
        confirmLabel="Sign out"
        onConfirm={signOut}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${name}?`}
        description={
          config.auth
            ? 'Its tools leave every session, its tool permissions are removed and Atelier forgets its sign-in.'
            : 'Its tools leave every session and its tool permissions are removed. Its stored keys stay in Keys & secrets, where you can delete them once nothing uses them.'
        }
        confirmLabel="Remove"
        onConfirm={remove}
      />
    </>
  );
}

/** The system's permission lists, as far as connector tools go. */
function useRuleLists() {
  const allow = useSetting<string[]>(['permissions', 'allow'], { toast: true });
  const ask = useSetting<string[]>(['permissions', 'ask'], { toast: true });
  const deny = useSetting<string[]>(['permissions', 'deny'], { toast: true });
  const lists = { allow, ask, deny };
  /** Writes the lists `keep` changes, in turn. */
  const update = async (keep: (rule: string, list: Policy) => boolean, add?: { rule: string; list: Policy }) => {
    for (const [kind, list] of Object.entries(lists) as [Policy, typeof allow][]) {
      const next = [...list.value.filter((r) => keep(r, kind)), ...(add?.list === kind ? [add.rule] : [])];
      if (next.join('\n') !== list.value.join('\n')) await list.set(next);
    }
  };
  return {
    policy: (rule: string): Policy => (deny.value.includes(rule) ? 'deny' : allow.value.includes(rule) ? 'allow' : 'ask'),
    /** Ask is the default for connector tools, so it needs no rule. */
    setPolicy: (rule: string, policy: Policy) => update((r) => r !== rule, policy === 'ask' ? undefined : { rule, list: policy }),
    /** Drops the rules for a removed server's tools (`mcp__name`, `mcp__name__…`). */
    forget: (server: string) => {
      const prefix = mcpToolName(server, '');
      return update((r) => r !== prefix.slice(0, -2) && !r.startsWith(prefix));
    },
  };
}

function ToolRow({ server, tool, config, rules }: { server: string; tool: Tool; config: McpServerConfig; rules: ReturnType<typeof useRuleLists> }) {
  const disabled = useSetting<string[]>(['mcpServers', server, 'disabledTools'], { toast: true });
  const enabled = !config.disabledTools.includes(tool.name);
  const rule = mcpToolName(server, tool.name);
  return (
    <li className={ITEM_ROW_CLASS}>
      <div className={cn('min-w-0 flex-1', !enabled && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body text-fg">{tool.name}</span>
          {tool.readOnly && <Badge>Read-only</Badge>}
        </div>
        {tool.description && (
          <p title={tool.description} className="line-clamp-2 text-footnote text-fg-muted">
            {tool.description}
          </p>
        )}
      </div>
      <SegmentedControl
        variant="icon"
        size="sm"
        aria-label={`When ${tool.name} may run`}
        items={POLICIES}
        value={rules.policy(rule)}
        disabled={!enabled}
        onValueChange={(policy) => void rules.setPolicy(rule, policy)}
      />
      <Switch
        aria-label={`Use ${tool.name}`}
        checked={enabled}
        onCheckedChange={(on) => void disabled.set(on ? disabled.value.filter((t) => t !== tool.name) : [...disabled.value, tool.name])}
      />
    </li>
  );
}
