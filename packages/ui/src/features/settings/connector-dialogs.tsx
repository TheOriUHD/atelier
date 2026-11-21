import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Checkbox } from '@base-ui/react/checkbox';
import {
  Blocks,
  Check,
  ChevronRight,
  Cloud,
  Gamepad2,
  GitPullRequest,
  House,
  Lock,
  LockOpen,
  NotebookText,
  Plus,
  Search,
  SquareKanban,
  X,
  type LucideIcon,
} from 'lucide-react';
import { CONNECTOR_PRESETS, isLoopbackHost, type ConnectorPreset, type McpServerConfig, type McpTransport } from '@atelier/protocol';
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  Icon,
  IconButton,
  SegmentedControl,
  Spinner,
  Switch,
  TextArea,
  TextField,
  toast,
} from '../../components/ui/index.ts';
import { desktop as desktopApp, openExternal } from '../../lib/platform.ts';
import { allowHere, LIST as PERSONAL_LIST, startSignIn as startPersonalSignIn } from './personal-connectors.tsx';
import { keys, useAppInfo } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import {
  connectorFormErrors,
  connectorNameError,
  emptyForm,
  entryFromForm,
  entryForSignIn,
  entryFromImport,
  entryFromPreset,
  formFromConfig,
  personalFromPreset,
  presetUnavailable,
  wantsSecret,
  type ConnectorForm,
  type NewSecret,
  type Pair,
} from './connector-form.ts';
import { ItemTile } from './item-row.tsx';
import { plural } from './provider-wizard.tsx';
import { SecretField } from './secret-field.tsx';

const PRESET_ICONS: Record<string, LucideIcon> = {
  cloudflare: Cloud,
  github: GitPullRequest,
  notion: NotebookText,
  linear: SquareKanban,
  'brave-search': Search,
  'home-assistant': House,
  'roblox-studio': Gamepad2,
};

/** The glyph for a connector set up from `preset`; custom ones get the generic one. */
export function connectorIcon(preset: string | undefined): LucideIcon {
  return (preset && PRESET_ICONS[preset]) || Blocks;
}

export const TYPE_LABELS: Record<McpTransport, string> = { http: 'HTTP', sse: 'SSE', stdio: 'stdio' };

/** Where a connector lives: its URL, or the command line that starts it. */
export function connectorTarget(config: McpServerConfig): string {
  return config.type === 'stdio' ? [config.command, ...config.args].join(' ') : (config.url ?? '');
}

/** Stores the entry's secrets first, so the references resolve once it connects, then writes it. */
async function writeConnector(name: string, { entry, secrets }: { entry: object; secrets: NewSecret[] }): Promise<void> {
  for (const secret of secrets) await rpc().call('secrets.set', secret);
  await rpc().call('settings.set', { layer: 'global', path: ['mcpServers', name], value: entry });
}

/** Reloads settings, secrets and status; asking for the status connects the servers not tried yet. */
function refreshConnectors(qc: QueryClient) {
  return Promise.all([keys.settings, keys.secrets, keys.mcp].map((queryKey) => qc.invalidateQueries({ queryKey })));
}

/** Starts an OAuth connector's sign-in and opens its page: a new tab on the web, the browser on the desktop. */
export async function openSignIn(name: string): Promise<void> {
  const { url } = await rpc().call('mcp.signIn', { name });
  openExternal(url);
}

/** After adding an OAuth connector its sign-in starts right away; a failure also shows on the connector's page. */
const signInAdded = (name: string) => openSignIn(name).catch((e: unknown) => void toast.error(describeError(e).message));

interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * Where a program (a stdio connector) added from this window runs: `desktop` on the desktop app's own backend, `here`
 * on this computer for the server the desktop app is signed in to (as the person's own connector). `platform` is the
 * system it runs on, null where none can run.
 */
function useProgramHost(desktop: boolean): { here: boolean; platform: string | null } {
  const { data: app } = useAppInfo();
  const here = !desktop && app?.surface === 'web' && !!desktopApp?.lending;
  return { here, platform: desktop ? (app?.platform ?? null) : here ? desktopApp!.platform : null };
}

/** A preset or "Custom", then its form. stdio presets need the desktop app: its own backend, or this computer for a server. */
export function AddConnectorDialog({ open, onOpenChange, desktop, taken, onAdded }: DialogProps & { desktop: boolean; taken: ReadonlySet<string>; onAdded(name: string): void }) {
  const [choice, setChoice] = useState<ConnectorPreset | 'custom' | null>(null);
  const { here, platform } = useProgramHost(desktop);
  const done = (name: string) => {
    onOpenChange(false);
    onAdded(name);
  };
  const back = () => setChoice(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={choice === null ? 'Add connector' : choice === 'custom' ? 'Add a custom connector' : `Add ${choice.name}`}
        description={choice === null ? 'Connect a service, or any MCP server.' : undefined}
      >
        {choice === null ? (
          <PresetCatalog programs={desktop || here} platform={platform} onChoose={setChoice} />
        ) : choice === 'custom' ? (
          <ConnectorEditor initial={emptyForm()} desktop={desktop} here={here} taken={taken} onBack={back} onSaved={done} />
        ) : (
          <PresetForm preset={choice} desktop={desktop} here={here} platform={platform} taken={taken} onBack={back} onSaved={done} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The ready-made connectors and Custom; `programs` is whether one that runs a program can run from here. */
export function PresetCatalog({ programs, platform, onChoose }: { programs: boolean; platform: string | null; onChoose(choice: ConnectorPreset | 'custom'): void }) {
  return (
    <div className="-mx-2 flex flex-col">
      {CONNECTOR_PRESETS.map((preset) => (
        <CatalogItem
          key={preset.id}
          icon={connectorIcon(preset.id)}
          title={preset.name}
          description={preset.description}
          unavailable={presetUnavailable(preset, programs, platform)}
          onClick={() => onChoose(preset)}
        />
      ))}
      <CatalogItem icon={Blocks} title="Custom" description="Any MCP server, by its URL or the command that starts it." onClick={() => onChoose('custom')} />
    </div>
  );
}

function CatalogItem({ icon, title, description, unavailable, onClick }: { icon: LucideIcon; title: string; description: string; unavailable?: string | undefined; onClick(): void }) {
  return (
    <button
      type="button"
      disabled={!!unavailable}
      onClick={onClick}
      className="flex items-center gap-3 rounded-xl px-2 py-2 text-left outline-none focus-ring enabled:hover:bg-fill-ghost-hover disabled:opacity-60"
    >
      <ItemTile icon={icon} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-strong text-fg">{title}</span>
        <span className="text-footnote text-fg-muted">{description}</span>
        {unavailable && <span className="text-footnote text-fg-secondary">{unavailable}</span>}
      </span>
      {!unavailable && <Icon icon={ChevronRight} className="text-fg-muted" />}
    </button>
  );
}

/** `name`, then `name-2`, `name-3` … until it is free. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}-${n}`;
  return candidate;
}

/**
 * A token, or signing in to the preset's hosted server. A token setup that runs a program (stdio) needs the desktop app:
 * on its own backend it is one of the backend's connectors; for a server it runs on this computer (`here`), so it is the
 * person's own. `personal` makes every one the person's own (Your connectors).
 */
export function PresetForm({
  preset,
  desktop,
  here,
  platform,
  personal = false,
  taken,
  onBack,
  onSaved,
}: {
  preset: ConnectorPreset;
  desktop: boolean;
  here: boolean;
  platform: string | null;
  personal?: boolean;
  taken: ReadonlySet<string>;
  onBack(): void;
  onSaved(name: string): void;
}) {
  const qc = useQueryClient();
  const tokenSetup = !preset.desktopOnly || desktop || here;
  // On a server's shared list, signing in (for everyone) comes first: the program would be this person's only.
  const sharedFirst = !!preset.oauth && preset.desktopOnly && !desktop && !personal;
  const [mode, setMode] = useState<'token' | 'oauth'>(tokenSetup && !sharedFirst ? 'token' : 'oauth');
  const oauth = mode === 'oauth';
  // A program for a server runs on this computer: only its person can use it.
  const own = personal || (!oauth && preset.desktopOnly && !desktop);
  const [name, setName] = useState(() => freeName(preset.id, taken));
  const [token, setToken] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  // Once it is written, the connector is among the taken names: that must not read as an error on the way out.
  const [written, setWritten] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = {
    name: connectorNameError(name, taken),
    token: oauth || !preset.token || token.trim() ? undefined : `Paste your ${preset.token.label}.`,
    ...Object.fromEntries(preset.fields.map((f) => [f.id, oauth || fields[f.id]?.trim() ? undefined : `Enter the ${f.label.toLowerCase()}.`])),
  };
  const shown: Record<string, string | undefined> = attempted && !written ? errors : {};

  const save = async () => {
    setAttempted(true);
    if (Object.values(errors).some(Boolean)) return;
    setSaving(true);
    setError(null);
    const trimmed = name.trim();
    try {
      if (own) {
        const saved = await rpc().call('connectors.save', personalFromPreset(preset, trimmed, token, fields, platform ?? '', oauth));
        // Chosen on this computer: it may run (or reach) it here.
        if (here) await allowHere(saved);
        setWritten(true);
        await Promise.all([PERSONAL_LIST, keys.mcp].map((queryKey) => qc.invalidateQueries({ queryKey })));
        toast.success(personal ? `Added ${trimmed}` : `Added ${trimmed} as your own connector: it runs on this computer.`);
        if (saved.auth) await startPersonalSignIn(saved.id).catch((e: unknown) => void toast.error(describeError(e).message));
        onSaved(trimmed);
        return;
      }
      await writeConnector(trimmed, oauth ? { entry: entryForSignIn(preset), secrets: [] } : entryFromPreset(preset, trimmed, token, fields, platform ?? ''));
      setWritten(true);
      await refreshConnectors(qc);
      toast.success(`Added ${trimmed}`);
      if (oauth) await signInAdded(trimmed);
      onSaved(trimmed);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorForm onSubmit={save} error={error} saving={saving} submitLabel={oauth ? 'Add and sign in' : 'Add connector'} onBack={onBack}>
      <Field label="Name" description={`Tools appear to models as mcp__${name.trim() || 'name'}__tool.`} error={shown.name}>
        <TextField value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      </Field>
      {preset.oauth && preset.token && tokenSetup && (
        <SegmentedControl
          aria-label="How to connect"
          items={[
            { value: 'token', label: preset.token.label },
            { value: 'oauth', label: `Sign in with ${preset.name}` },
          ]}
          value={mode}
          onValueChange={setMode}
          className="self-start"
        />
      )}
      {oauth ? (
        <p className="text-body text-fg-secondary">
          Once it’s added, {preset.name} opens {desktop ? 'in your browser' : 'in a new tab'} for you to sign in and allow access. Atelier keeps what it gets
          encrypted and uses it {personal ? 'for your sessions only' : 'for everyone’s sessions'}.
        </p>
      ) : (
        <>
          {preset.token && (
            <Field
              label={preset.token.label}
              description={
                <>
                  {preset.token.help} {own ? 'Kept encrypted on the server, for you only.' : 'Stored encrypted by Atelier, never in settings files.'}{' '}
                  <a href={preset.token.url} target="_blank" rel="noreferrer" className="text-interactive-text underline-offset-2 hover:underline">
                    Create one
                  </a>
                </>
              }
              error={shown.token}
            >
              <SecretField value={token} onValueChange={setToken} placeholder="Paste it here" invalid={!!shown.token} />
            </Field>
          )}
          {preset.fields.map((f) => (
            <Field key={f.id} label={f.label} error={shown[f.id]}>
              <TextField value={fields[f.id] ?? ''} placeholder={f.placeholder} spellCheck={false} onChange={(e) => setFields((all) => ({ ...all, [f.id]: e.target.value }))} />
            </Field>
          ))}
          {preset.setup && <p className="text-body text-fg-secondary">{preset.setup}</p>}
          {preset.note && <p className="text-footnote text-fg-muted">{preset.note}</p>}
          {own && !personal && (
            <p className="text-footnote text-fg-muted">On a server it becomes your own connector: it runs on this computer, in this desktop app, and only you use it.</p>
          )}
        </>
      )}
    </EditorForm>
  );
}

/** Edits a connector's connection, as the custom form does. Its name, switches and tool settings stay. */
export function EditConnectorDialog({ open, onOpenChange, name, config, desktop }: DialogProps & { name: string; config: McpServerConfig; desktop: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Edit ${name}`}>
        <ConnectorEditor initial={formFromConfig(name, config)} existing={config} desktop={desktop} taken={new Set()} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

const TYPES = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'stdio' },
] as const satisfies readonly { value: McpTransport; label: string }[];

function ConnectorEditor({
  initial,
  existing,
  desktop,
  here = false,
  taken,
  onBack,
  onSaved,
}: {
  initial: ConnectorForm;
  existing?: McpServerConfig;
  desktop: boolean;
  /** This desktop app runs programs for the server it is signed in to: a new stdio one becomes the person's own. */
  here?: boolean;
  taken: ReadonlySet<string>;
  onBack?(): void;
  onSaved(name: string): void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  // Once it is written, the connector is among the taken names: that must not read as an error on the way out.
  const [written, setWritten] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = connectorFormErrors(form, taken);
  const shown = attempted && !written ? errors : {};
  const update = (patch: Partial<ConnectorForm>) => setForm((f) => ({ ...f, ...patch }));
  const stdio = form.type === 'stdio';
  // On a server these run there, where localhost is the server itself. Added in the desktop app, a new one at localhost
  // means that computer: it becomes the person's own connector, reached through this desktop app. In a browser it stays
  // the server's (a program on the server itself), as the hint says.
  const { data: app } = useAppInfo();
  const host = URL.parse(form.url.trim())?.hostname;
  const onServer = app?.surface === 'web' && !stdio && !!host && isLoopbackHost(host);
  const throughHere = onServer && !existing && !!desktopApp;
  // A program for a server can only run on a computer of the person's: this one, as their own connector.
  const programHere = here && !existing;
  const runsHere = stdio && !desktop && programHere;

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setError(null);
    try {
      const name = form.name.trim();
      if (throughHere || runsHere) {
        // Its values go as they are: your own connector keeps them encrypted as your secrets.
        const values = Object.fromEntries(form.pairs.filter((p) => p.name.trim()).map((p) => [p.name.trim(), p.value]));
        const args = form.args
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean);
        const saved = await rpc().call(
          'connectors.save',
          runsHere
            ? { name, type: 'stdio', command: form.command.trim(), args, env: values }
            : { name, type: form.type, url: form.url.trim(), headers: values, ...(form.oauth ? { auth: 'oauth' as const } : {}) },
        );
        await allowHere(saved);
        await Promise.all([PERSONAL_LIST, keys.mcp].map((queryKey) => qc.invalidateQueries({ queryKey })));
        setWritten(true);
        toast.success(runsHere ? `Added ${name} as your own connector: it runs on this computer.` : `Added ${name} as your own connector: Atelier reaches it through this computer.`);
        onSaved(name);
        return;
      }
      await writeConnector(name, entryFromForm(form, existing));
      setWritten(true);
      await refreshConnectors(qc);
      toast.success(existing ? `Saved ${name}` : `Added ${name}`);
      if (!existing && !stdio && form.oauth) await signInAdded(name);
      onSaved(name);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorForm onSubmit={save} error={error} saving={saving} submitLabel={existing ? 'Save' : 'Add connector'} onBack={onBack}>
      <Field label="Name" description={`Tools appear to models as mcp__${form.name.trim() || 'name'}__tool.`} error={shown.name} disabled={!!existing}>
        <TextField autoFocus={!existing} value={form.name} spellCheck={false} onChange={(e) => update({ name: e.target.value })} />
      </Field>
      <div className="flex flex-col">
        <span id="connector-type" className="mb-2 text-[14px]/[14px] font-medium text-fg">
          Connects over
        </span>
        <SegmentedControl
          aria-labelledby="connector-type"
          items={TYPES.map((t) => ({ ...t, disabled: t.value === 'stdio' && !desktop && !programHere }))}
          value={form.type}
          onValueChange={(type) => update({ type })}
          className="self-start"
        />
        <p className="mt-1.5 text-footnote text-fg-muted">
          {desktop
            ? 'HTTP is the current standard; SSE is the older streaming one. stdio starts the server as a program on this computer.'
            : programHere
              ? 'HTTP is the current standard; SSE is the older streaming one. stdio starts the server as a program on this computer: it becomes your own connector, which only you use.'
              : 'HTTP is the current standard; SSE is the older streaming one. Servers that run as a program (stdio) can only be added in the desktop app.'}
        </p>
      </div>
      {stdio ? (
        <>
          <Field label="Command" description="The program, or its full path. ${VAR} here and in the arguments is filled in from that computer’s environment." error={shown.command}>
            <TextField value={form.command} placeholder="npx" spellCheck={false} className="font-mono" onChange={(e) => update({ command: e.target.value })} />
          </Field>
          <Field label="Arguments" description="One per line.">
            <TextArea value={form.args} rows={3} placeholder={'-y\n@scope/mcp-server'} spellCheck={false} className="font-mono" onChange={(e) => update({ args: e.target.value })} />
          </Field>
        </>
      ) : (
        <>
          <Field
            label="URL"
            error={shown.url}
            description={
              throughHere
                ? `${host} is this computer: it becomes your own connector, reached through this desktop app (the server can't reach your computer's ${host} itself).`
                : onServer
                  ? `${host} is the Atelier server itself: this connector runs there. One on your own computer is added in the desktop app, where ${host} means that computer.`
                  : undefined
            }
          >
            <TextField value={form.url} placeholder="https://example.com/mcp" inputMode="url" spellCheck={false} onChange={(e) => update({ url: e.target.value })} />
          </Field>
          <div className="flex items-start justify-between gap-4">
            <span className="flex flex-col">
              <span id="connector-oauth" className="text-[14px]/[14px] font-medium text-fg">
                Sign in with OAuth
              </span>
              <span id="connector-oauth-help" className="mt-1.5 text-footnote text-fg-muted">
                For servers you sign in to instead of giving them a token. {existing ? 'Sign in on its page.' : 'Signing in starts once it’s added.'}
              </span>
            </span>
            <Switch aria-labelledby="connector-oauth" aria-describedby="connector-oauth-help" checked={form.oauth} onCheckedChange={(oauth) => update({ oauth })} />
          </div>
        </>
      )}
      <PairsEditor
        noun={stdio ? 'Variable' : 'Header'}
        title={stdio ? 'Environment variables' : 'Headers'}
        own={throughHere || runsHere}
        pairs={form.pairs}
        error={shown.pairs}
        onChange={(pairs) => update({ pairs })}
      />
    </EditorForm>
  );
}

/**
 * Headers or environment variables. A value is a literal, a `${secret:id}` / `${ENV}` reference, or a literal
 * marked to be kept as a secret: those move to the secret store on save (credential-like names are marked already).
 * For the person's own connector (`own`) every value is kept as their secret, so there is nothing to mark.
 */
function PairsEditor({ noun, title, own = false, pairs, error, onChange }: { noun: string; title: string; own?: boolean; pairs: Pair[]; error: string | undefined; onChange(pairs: Pair[]): void }) {
  const set = (index: number, patch: Partial<Pair>) => onChange(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-6 items-center justify-between">
        <span className="text-[14px]/[14px] font-medium text-fg">{title}</span>
        <Button size="xs" variant="ghost" leadingIcon={Plus} onClick={() => onChange([...pairs, { name: '', value: '' }])}>
          Add {noun.toLowerCase()}
        </Button>
      </div>
      {pairs.map((p, i) => {
        const reference = p.value.includes('${');
        const secret = own || (wantsSecret(p) && !reference);
        return (
          <div key={i} className="flex items-center gap-2">
            <TextField aria-label={`${noun} ${i + 1} name`} placeholder="Name" spellCheck={false} value={p.name} className="w-40 shrink-0" onChange={(e) => set(i, { name: e.target.value })} />
            <TextField
              aria-label={`${noun} ${i + 1} value`}
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={own ? 'Value' : 'Value or ${secret:id}'}
              spellCheck={false}
              value={p.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            {!own && (
              <IconButton
                icon={secret || p.value.includes('${secret:') ? Lock : LockOpen}
                label={`Keep ${noun.toLowerCase()} ${i + 1} as a secret`}
                aria-pressed={secret}
                disabled={reference}
                className="aria-pressed:text-interactive-text"
                onClick={() => set(i, { secret: !secret })}
              />
            )}
            <IconButton icon={X} label={`Remove ${noun.toLowerCase()} ${i + 1}`} onClick={() => onChange(pairs.filter((_, j) => j !== i))} />
          </div>
        );
      })}
      {own
        ? pairs.length > 0 && <p className="text-footnote text-fg-muted">Kept encrypted on the server, for you only.</p>
        : pairs.some((p) => wantsSecret(p) && !p.value.includes('${')) && (
            <p className="text-footnote text-fg-muted">Locked values are stored encrypted in Keys & secrets; the connector only refers to them.</p>
          )}
      {error && <p className="text-footnote text-danger-text">{error}</p>}
    </div>
  );
}

export function EditorForm({ onSubmit, error, saving, submitLabel, onBack, children }: { onSubmit(): void; error: string | null; saving: boolean; submitLabel: string; onBack?: (() => void) | undefined; children: ReactNode }) {
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-col gap-4">{children}</div>
      {error && (
        <p role="alert" className="mt-4 text-body text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-6 flex items-center justify-end gap-3">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Desktop: Claude Code's servers, chosen with checkboxes; flagged literal credentials move into the secret store. */
export function ImportDialog({ open, onOpenChange, taken }: DialogProps & { taken: ReadonlySet<string> }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Import from Claude Code"
        description="Connectors from Claude Code’s ~/.claude.json and the .mcp.json files in your folders on this computer. Credentials written into them move to the secret store."
      >
        <ImportList taken={taken} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ImportList({ taken, onDone }: { taken: ReadonlySet<string>; onDone(): void }) {
  const qc = useQueryClient();
  const { data: entries, error: loadError } = useQuery({ queryKey: ['mcp.import'], queryFn: () => rpc().call('mcp.import', {}), staleTime: 0 });
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = entries?.filter((e) => !taken.has(e.name) && !skipped.has(e.name)) ?? [];

  const run = async () => {
    setImporting(true);
    setError(null);
    try {
      for (const entry of chosen) await writeConnector(entry.name, entryFromImport(entry));
      toast.success(`Imported ${plural(chosen.length, 'connector')}`);
      onDone();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setImporting(false);
      // Also after a failure part way: what was written shows up.
      void refreshConnectors(qc);
    }
  };

  const toggle = (name: string, on: boolean) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (on) next.delete(name);
      else next.add(name);
      return next;
    });

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
                <Checkbox.Root
                  checked={!added && !skipped.has(entry.name)}
                  disabled={added}
                  aria-labelledby={`import-${entry.name}`}
                  aria-describedby={`import-${entry.name}-detail`}
                  onCheckedChange={(on) => toggle(entry.name, on)}
                  className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-xs text-on-interactive inset-ring inset-ring-line-strong outline-none focus-ring data-checked:bg-interactive data-checked:inset-ring-0 data-disabled:opacity-40"
                >
                  <Checkbox.Indicator>
                    <Icon icon={Check} className="size-3" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    <span id={`import-${entry.name}`} className="truncate text-body-strong text-fg">
                      {entry.name}
                    </span>
                    <Badge>{TYPE_LABELS[entry.config.type]}</Badge>
                  </span>
                  <span id={`import-${entry.name}-detail`} className="flex flex-col text-footnote text-fg-muted">
                    <span title={entry.source} className="truncate">
                      From {entry.source}
                    </span>
                    <span className="truncate font-mono">{connectorTarget(entry.config)}</span>
                    {added ? <span>Already added</span> : entry.secrets.length > 0 && <span>{plural(entry.secrets.length, 'credential')} to move to the secret store</span>}
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
