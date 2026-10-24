/**
 * Customize › Connectors › Your connectors (ARCHITECTURE §9-B), on a server: everyone's own connectors beside the
 * admin's, with values only they use. One that runs a program (stdio) runs it on a computer of theirs where the desktop
 * app is signed in here and allows it; adding or importing it in that desktop app allows it there. One at an address on
 * that computer or its network is reached through it the same way.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Import, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import type { McpImportEntry, McpServerStatus, McpTransport, PersonalConnector, PersonalConnectorView } from '@atelier/protocol';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SegmentedControl,
  Spinner,
  Switch,
  TextArea,
  TextField,
  toast,
} from '../../components/ui/index.ts';
import { changeLending, useLending } from '../../lib/lending.ts';
import { desktop, openExternal } from '../../lib/platform.ts';
import { keys, useAppInfo, useMcpStatus } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { EditorForm, TYPE_LABELS, connectorTarget } from './connector-dialogs.tsx';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { plural } from './provider-wizard.tsx';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';

const LIST = ['connectors.list'] as const;

/** An address on this computer or its network, which the server reaches through the desktop. */
export function isLocalAddress(url: string): boolean {
  const host = URL.parse(url)?.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  return host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost') || !host.includes('.') || /^(127|10)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^f[cd]/.test(host);
}

/** Lets this computer run (or reach) the connector for the server, as the person just chose it here. */
async function allowHere(connector: PersonalConnector): Promise<void> {
  if (connector.type === 'stdio') {
    await changeLending({ kind: 'connector', id: connector.id, name: connector.name, command: connector.command!, args: connector.args, envKeys: connector.envKeys, allowed: true });
  } else if (connector.url && isLocalAddress(connector.url)) {
    await changeLending({ kind: 'http', id: connector.id, baseUrl: new URL(connector.url).origin, allowed: true });
  }
}

async function startSignIn(id: string): Promise<void> {
  const { url } = await rpc().call('connectors.signIn', { id });
  openExternal(url);
}

export function PersonalConnectorsSection() {
  const { data: app } = useAppInfo();
  const qc = useQueryClient();
  const server = app?.surface === 'web';
  const { data: list } = useQuery({ queryKey: LIST, queryFn: () => rpc().call('connectors.list', {}), enabled: server });
  const statuses = useMcpStatus();
  const lending = useLending();
  const add = useDialog();
  const importing = useDialog();
  const [editing, setEditing] = useState<PersonalConnector | null>(null);
  // Saved from another window, or an admin's connector took a name: read the list again.
  useEffect(() => rpc().on('prefs.changed', () => void qc.invalidateQueries({ queryKey: LIST })), [qc]);
  if (!server) return null;
  const here = lending.lends('mcp');
  const taken = new Set(list?.map((v) => v.connector.name));

  return (
    <>
      <SettingsSection
        title="Your connectors"
        description="Connectors only you use, with your own keys. One that runs a program runs it on your computer, in the Atelier desktop app signed in here."
        action={
          <div className="flex items-center gap-2">
            {here && (
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
        {list?.length === 0 && <p className="pb-3 text-body text-fg-muted">None yet. Add one to use tools from a service only you connect to.</p>}
        {!!list?.length && (
          <DataTable
            label="Your connectors"
            columns={[
              { label: 'Connector' },
              { label: 'Type', className: 'w-24' },
              { label: 'Status', className: 'w-44' },
              { label: 'Enabled', hidden: true, className: 'w-12' },
              { label: 'Actions', hidden: true, className: 'w-10' },
            ]}
          >
            {list.map((view) => (
              <PersonalRow
                key={view.connector.id}
                view={view}
                status={statuses?.find((s) => s.personal && s.name === view.connector.name)}
                here={here}
                allowedHere={!!lending.allowed?.connectors.some((c) => c.id === view.connector.id) || !!lending.allowed?.http.some((a) => a.id === view.connector.id)}
                onEdit={() => setEditing(view.connector)}
              />
            ))}
          </DataTable>
        )}
      </SettingsSection>
      <Dialog open={add.open} onOpenChange={add.onOpenChange}>
        <DialogContent title="Add your connector" description="Any MCP server, by its URL or the command that starts it.">
          <PersonalEditor key={add.key} here={here} taken={taken} onDone={() => add.onOpenChange(false)} />
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent title={`Edit ${editing?.name ?? ''}`}>{editing && <PersonalEditor existing={editing} here={here} taken={taken} onDone={() => setEditing(null)} />}</DialogContent>
      </Dialog>
      {here && (
        <Dialog open={importing.open} onOpenChange={importing.onOpenChange}>
          <DialogContent
            title="Import from Claude Code"
            description="Connectors from Claude Code’s ~/.claude.json and the .mcp.json files in your folders on this computer. They become yours, their keys kept encrypted on the server; the ones that run a program run here."
          >
            <PersonalImport key={importing.key} taken={taken} onDone={() => importing.onOpenChange(false)} />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function statusText(view: PersonalConnectorView, status: McpServerStatus | undefined): { text: string; error?: string } {
  if (view.clash) return { text: 'Not used', error: `An admin's connector is also called ${view.connector.name}: rename yours.` };
  if (!view.connector.enabled) return { text: 'Off' };
  if (!status || status.state === 'connecting') return { text: 'Connecting' };
  if (status.signIn === 'needed') return { text: 'Not signed in' };
  if (status.signIn === 'waiting') return { text: 'Waiting for sign-in' };
  if (status.state === 'ready') return { text: status.device ? `Ready on ${status.device}` : `Ready, ${plural(status.tools.length, 'tool')}` };
  return { text: 'Error', ...(status.error ? { error: status.error } : {}) };
}

function PersonalRow({ view, status, here, allowedHere, onEdit }: { view: PersonalConnectorView; status: McpServerStatus | undefined; here: boolean; allowedHere: boolean; onEdit(): void }) {
  const qc = useQueryClient();
  const { connector } = view;
  const [removing, setRemoving] = useState(false);
  const shown = statusText(view, status);
  const local = connector.type === 'stdio' || (!!connector.url && isLocalAddress(connector.url));
  const refresh = () => Promise.all([LIST, keys.mcp].map((queryKey) => qc.invalidateQueries({ queryKey })));
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await refresh();
  };
  const switchTo = (enabled: boolean) => run(() => rpc().call('connectors.save', { ...inputFrom(connector), enabled }));
  const allow = () =>
    run(async () => {
      await allowHere(connector);
      await rpc().call('connectors.test', { id: connector.id });
    });
  const remove = () =>
    run(async () => {
      await rpc().call('connectors.remove', { id: connector.id });
      if (here && allowedHere) await changeLending(connector.type === 'stdio' ? { kind: 'connector', id: connector.id, allowed: false } : { kind: 'http', id: connector.id, allowed: false });
    });

  return (
    <TableRow>
      <Cell>
        <span className="block truncate text-fg">{connector.name}</span>
        <span title={targetOf(connector)} className="block truncate font-mono text-footnote text-fg-muted">
          {targetOf(connector)}
        </span>
        {shown.error && (
          <p title={shown.error} className="truncate text-footnote text-danger-text">
            {shown.error}
          </p>
        )}
      </Cell>
      <Cell>{TYPE_LABELS[connector.type]}</Cell>
      <Cell>
        <span className="flex items-center gap-1.5">
          {shown.text === 'Connecting' && <Spinner className="size-3" />}
          {shown.text}
        </span>
      </Cell>
      <Cell className="text-right">
        <Switch aria-label={`Enable ${connector.name}`} checked={connector.enabled} onCheckedChange={(on) => void switchTo(on)} />
      </Cell>
      <Cell className="text-right">
        <Menu>
          <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${connector.name} options`} size="sm" />} />
          <MenuContent align="end">
            <MenuItem icon={Pencil} onClick={onEdit}>
              Edit
            </MenuItem>
            {here && local && (
              <MenuItem icon={ShieldCheck} onClick={() => void allow()}>
                {connector.type === 'stdio' ? 'Run on this computer' : 'Reach through this computer'}
              </MenuItem>
            )}
            {connector.auth && (
              <MenuItem icon={ShieldCheck} onClick={() => void run(() => startSignIn(connector.id))}>
                Sign in
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onClick={() => setRemoving(true)}>
              Remove
            </MenuItem>
          </MenuContent>
        </Menu>
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${connector.name}?`}
          description="Its tools leave your conversations, and the server forgets its keys and sign-in."
          confirmLabel="Remove"
          onConfirm={remove}
        />
      </Cell>
    </TableRow>
  );
}

/** Where it lives: its URL, or the command line that starts it. */
const targetOf = (c: PersonalConnector) => (c.type === 'stdio' ? [c.command, ...c.args].join(' ') : (c.url ?? ''));

/** What saving it again unchanged sends: every value kept. */
function inputFrom(c: PersonalConnector) {
  const keep = (names: string[]) => Object.fromEntries(names.map((n) => [n, null]));
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    ...(c.command ? { command: c.command } : {}),
    args: c.args,
    ...(c.url ? { url: c.url } : {}),
    env: keep(c.envKeys),
    headers: keep(c.headerKeys),
    enabled: c.enabled,
    disabledTools: c.disabledTools,
    ...(c.auth ? { auth: c.auth } : {}),
  };
}

interface Pair {
  name: string;
  value: string;
  /** Saved before: an empty value keeps it. */
  saved: boolean;
}

const TYPES = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'stdio' },
] as const satisfies readonly { value: McpTransport; label: string }[];

function PersonalEditor({ existing, here, taken, onDone }: { existing?: PersonalConnector; here: boolean; taken: ReadonlySet<string>; onDone(): void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<McpTransport>(existing?.type ?? 'http');
  const [command, setCommand] = useState(existing?.command ?? '');
  const [args, setArgs] = useState(existing?.args.join('\n') ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [oauth, setOauth] = useState(!!existing?.auth);
  const [pairs, setPairs] = useState<Pair[]>(() => (existing ? (existing.type === 'stdio' ? existing.envKeys : existing.headerKeys).map((n) => ({ name: n, value: '', saved: true })) : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stdio = type === 'stdio';

  const save = async () => {
    const trimmed = name.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) return setError('Name it with up to 64 letters, digits, - and _.');
    if (trimmed !== existing?.name && taken.has(trimmed)) return setError(`You have a connector called ${trimmed} already.`);
    if (stdio ? !command.trim() : !url.trim()) return setError(stdio ? 'Enter the command that starts it.' : 'Enter its URL.');
    const values = Object.fromEntries(pairs.filter((p) => p.name.trim()).map((p) => [p.name.trim(), p.saved && !p.value ? null : p.value]));
    setSaving(true);
    setError(null);
    try {
      const saved = await rpc().call('connectors.save', {
        ...(existing ? { id: existing.id, enabled: existing.enabled, disabledTools: existing.disabledTools } : {}),
        name: trimmed,
        type,
        ...(stdio ? { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean) } : { url: url.trim(), ...(oauth ? { auth: 'oauth' as const } : {}) }),
        env: stdio ? values : {},
        headers: stdio ? {} : values,
      });
      // Chosen on this computer: it may run (or reach) it here.
      if (here) await allowHere(saved);
      await Promise.all([LIST, keys.mcp].map((queryKey) => qc.invalidateQueries({ queryKey })));
      toast.success(existing ? `Saved ${saved.name}` : `Added ${saved.name}`);
      if (saved.auth && !existing?.auth) await startSignIn(saved.id).catch((e: unknown) => void toast.error(describeError(e).message));
      onDone();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  const set = (index: number, patch: Partial<Pair>) => setPairs((all) => all.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const noun = stdio ? 'Variable' : 'Header';
  return (
    <EditorForm onSubmit={() => void save()} error={error} saving={saving} submitLabel={existing ? 'Save' : 'Add connector'}>
      <Field label="Name" description={`Its tools appear to models as mcp__${name.trim() || 'name'}__tool.`}>
        <TextField autoFocus={!existing} value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="flex flex-col">
        <span id="personal-connector-type" className="mb-2 text-[14px]/[14px] font-medium text-fg">
          Connects over
        </span>
        <SegmentedControl aria-labelledby="personal-connector-type" items={[...TYPES]} value={type} onValueChange={setType} className="self-start" />
        <p className="mt-1.5 text-footnote text-fg-muted">
          stdio starts the server as a program on your computer, where the desktop app is signed in here. An address on your computer or its network is reached through it too.
        </p>
      </div>
      {stdio ? (
        <>
          <Field label="Command">
            <TextField value={command} placeholder="npx" spellCheck={false} className="font-mono" onChange={(e) => setCommand(e.target.value)} />
          </Field>
          <Field label="Arguments" description="One per line.">
            <TextArea value={args} rows={3} placeholder={'-y\n@scope/mcp-server'} spellCheck={false} className="font-mono" onChange={(e) => setArgs(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <TextField value={url} placeholder="https://example.com/mcp" inputMode="url" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <div className="flex items-start justify-between gap-4">
            <span id="personal-connector-oauth" className="text-[14px]/[14px] font-medium text-fg">
              Sign in with OAuth
            </span>
            <Switch aria-labelledby="personal-connector-oauth" checked={oauth} onCheckedChange={setOauth} />
          </div>
        </>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex h-6 items-center justify-between">
          <span className="text-[14px]/[14px] font-medium text-fg">{stdio ? 'Environment variables' : 'Headers'}</span>
          <Button size="xs" variant="ghost" leadingIcon={Plus} onClick={() => setPairs((all) => [...all, { name: '', value: '', saved: false }])}>
            Add {noun.toLowerCase()}
          </Button>
        </div>
        {pairs.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <TextField aria-label={`${noun} ${i + 1} name`} placeholder="Name" spellCheck={false} value={p.name} disabled={p.saved} className="w-40 shrink-0" onChange={(e) => set(i, { name: e.target.value })} />
            <TextField
              aria-label={`${noun} ${i + 1} value`}
              type="password"
              autoComplete="off"
              placeholder={p.saved ? 'Unchanged' : stdio ? 'Value or ${VAR}' : 'Value'}
              spellCheck={false}
              value={p.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <IconButton icon={X} label={`Remove ${noun.toLowerCase()} ${i + 1}`} onClick={() => setPairs((all) => all.filter((_, j) => j !== i))} />
          </div>
        ))}
        <p className="text-footnote text-fg-muted">
          Kept encrypted on the server, for you only.{stdio ? ' ${VAR} is filled in from your computer’s environment when it starts.' : ''}
        </p>
      </div>
    </EditorForm>
  );
}

function PersonalImport({ taken, onDone }: { taken: ReadonlySet<string>; onDone(): void }) {
  const qc = useQueryClient();
  const { data: entries, error: loadError } = useQuery({
    queryKey: ['connectors.import'],
    queryFn: async () => {
      // Lets the server read Claude Code's connectors on this computer for a little while.
      await desktop?.lending?.allowImport?.();
      return rpc().call('connectors.import', {});
    },
    staleTime: 0,
    gcTime: 0,
  });
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = entries?.filter((e) => !taken.has(e.name) && !skipped.has(e.name)) ?? [];

  const run = async () => {
    setImporting(true);
    setError(null);
    try {
      for (const entry of chosen) await allowHere(await rpc().call('connectors.save', inputFromImport(entry)));
      toast.success(`Imported ${plural(chosen.length, 'connector')}`);
      onDone();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setImporting(false);
      void Promise.all([LIST, keys.mcp].map((queryKey) => qc.invalidateQueries({ queryKey })));
    }
  };

  return (
    <>
      {!entries && !loadError && (
        <p className="flex items-center gap-2 text-body text-fg-muted">
          <Spinner />
          Reading Claude Code’s settings…
        </p>
      )}
      {entries?.length === 0 && <p className="text-body text-fg-muted">No Claude Code connectors on this computer.</p>}
      {!!entries?.length && (
        <ul aria-label="Claude Code connectors" className="-mx-2 flex max-h-96 flex-col overflow-y-auto">
          {entries.map((entry) => {
            const added = taken.has(entry.name);
            return (
              <li key={entry.name} className="flex items-start gap-3 px-2 py-2">
                <Checkbox
                  className="mt-0.5"
                  checked={!added && !skipped.has(entry.name)}
                  disabled={added}
                  aria-labelledby={`personal-import-${entry.name}`}
                  aria-describedby={`personal-import-${entry.name}-detail`}
                  onCheckedChange={(on) =>
                    setSkipped((s) => {
                      const next = new Set(s);
                      if (on) next.delete(entry.name);
                      else next.add(entry.name);
                      return next;
                    })
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span id={`personal-import-${entry.name}`} className="truncate text-body-strong text-fg">
                      {entry.name}
                    </span>
                    <Badge>{TYPE_LABELS[entry.config.type]}</Badge>
                  </span>
                  <span id={`personal-import-${entry.name}-detail`} className="flex flex-col text-footnote text-fg-muted">
                    <span title={entry.source} className="truncate">
                      From {entry.source}
                    </span>
                    {/* Exactly what runs on this computer, as it will be allowed here. */}
                    <span className="font-mono break-all">{connectorTarget(entry.config)}</span>
                    {added && <span>Already added</span>}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(loadError || error) && (
        <p role="alert" className="mt-4 text-body text-danger-text">
          {loadError ? describeError(loadError).message : error}
        </p>
      )}
      <div className="mt-6 flex items-center justify-end gap-3">
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button variant="primary" disabled={chosen.length === 0} loading={importing} onClick={() => void run()}>
          {chosen.length > 1 ? `Import ${chosen.length} connectors` : 'Import'}
        </Button>
      </div>
    </>
  );
}

function inputFromImport({ name, config }: McpImportEntry) {
  return {
    name,
    type: config.type,
    ...(config.type === 'stdio' ? { command: config.command!, args: config.args, env: config.env, headers: {} } : { url: config.url!, env: {}, headers: config.headers, ...(config.auth ? { auth: config.auth } : {}) }),
  };
}
