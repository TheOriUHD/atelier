import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Checkbox } from '@base-ui/react/checkbox';
import {
  Blocks,
  Check,
  ChevronRight,
  Cloud,
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
import { CONNECTOR_PRESETS, type ConnectorPreset, type McpServerConfig, type McpTransport } from '@atelier/protocol';
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
import { openExternal } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
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

/** A preset or "Custom", then its form. stdio presets need the desktop app's backend. */
export function AddConnectorDialog({ open, onOpenChange, desktop, taken, onAdded }: DialogProps & { desktop: boolean; taken: ReadonlySet<string>; onAdded(name: string): void }) {
  const [choice, setChoice] = useState<ConnectorPreset | 'custom' | null>(null);
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
          <div className="-mx-2 flex flex-col">
            {CONNECTOR_PRESETS.map((preset) => (
              <CatalogItem
                key={preset.id}
                icon={connectorIcon(preset.id)}
                title={preset.name}
                description={preset.description}
                unavailable={preset.desktopOnly && !desktop && !preset.oauth ? 'Only in the desktop app: it runs a program on your computer.' : undefined}
                onClick={() => setChoice(preset)}
              />
            ))}
            <CatalogItem icon={Blocks} title="Custom" description="Any MCP server, by its URL or the command that starts it." onClick={() => setChoice('custom')} />
          </div>
        ) : choice === 'custom' ? (
          <ConnectorEditor initial={emptyForm()} desktop={desktop} taken={taken} onBack={back} onSaved={done} />
        ) : (
          <PresetForm preset={choice} desktop={desktop} taken={taken} onBack={back} onSaved={done} />
        )}
      </DialogContent>
    </Dialog>
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

/** A token, or signing in to the preset's hosted server. A token setup that runs a program (stdio) needs the desktop app. */
function PresetForm({ preset, desktop, taken, onBack, onSaved }: { preset: ConnectorPreset; desktop: boolean; taken: ReadonlySet<string>; onBack(): void; onSaved(name: string): void }) {
  const qc = useQueryClient();
  const tokenSetup = !preset.desktopOnly || desktop;
  const [mode, setMode] = useState<'token' | 'oauth'>(tokenSetup ? 'token' : 'oauth');
  const oauth = mode === 'oauth';
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
    token: oauth || token.trim() ? undefined : `Paste your ${preset.token.label}.`,
    ...Object.fromEntries(preset.fields.map((f) => [f.id, oauth || fields[f.id]?.trim() ? undefined : `Enter the ${f.label.toLowerCase()}.`])),
  };
  const shown: Record<string, string | undefined> = attempted && !written ? errors : {};

  const save = async () => {
    setAttempted(true);
    if (Object.values(errors).some(Boolean)) return;
    setSaving(true);
    setError(null);
    try {
      await writeConnector(name.trim(), oauth ? { entry: entryForSignIn(preset), secrets: [] } : entryFromPreset(preset, name.trim(), token, fields));
      setWritten(true);
      await refreshConnectors(qc);
      toast.success(`Added ${name.trim()}`);
      if (oauth) await signInAdded(name.trim());
      onSaved(name.trim());
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
      {preset.oauth && tokenSetup && (
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
          encrypted and uses it for everyone’s sessions.
        </p>
      ) : (
        <>
          <Field
            label={preset.token.label}
            description={
              <>
                {preset.token.help} Stored encrypted by Atelier, never in settings files.{' '}
                <a href={preset.token.url} target="_blank" rel="noreferrer" className="text-interactive-text underline-offset-2 hover:underline">
                  Create one
                </a>
              </>
            }
            error={shown.token}
          >
            <SecretField value={token} onValueChange={setToken} placeholder="Paste it here" invalid={!!shown.token} />
          </Field>
          {preset.fields.map((f) => (
            <Field key={f.id} label={f.label} error={shown[f.id]}>
              <TextField value={fields[f.id] ?? ''} placeholder={f.placeholder} spellCheck={false} onChange={(e) => setFields((all) => ({ ...all, [f.id]: e.target.value }))} />
            </Field>
          ))}
          {preset.note && <p className="text-footnote text-fg-muted">{preset.note}</p>}
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
  taken,
  onBack,
  onSaved,
}: {
  initial: ConnectorForm;
  existing?: McpServerConfig;
  desktop: boolean;
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

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setError(null);
    try {
      const name = form.name.trim();
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
          items={TYPES.map((t) => ({ ...t, disabled: t.value === 'stdio' && !desktop }))}
          value={form.type}
          onValueChange={(type) => update({ type })}
          className="self-start"
        />
        <p className="mt-1.5 text-footnote text-fg-muted">
          {desktop
            ? 'HTTP is the current standard; SSE is the older streaming one. stdio starts the server as a program on this computer.'
            : 'HTTP is the current standard; SSE is the older streaming one. Servers that run as a program (stdio) can only be added in the desktop app.'}
        </p>
      </div>
      {stdio ? (
        <>
          <Field label="Command" error={shown.command}>
            <TextField value={form.command} placeholder="npx" spellCheck={false} className="font-mono" onChange={(e) => update({ command: e.target.value })} />
          </Field>
          <Field label="Arguments" description="One per line.">
            <TextArea value={form.args} rows={3} placeholder={'-y\n@scope/mcp-server'} spellCheck={false} className="font-mono" onChange={(e) => update({ args: e.target.value })} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" error={shown.url}>
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
      <PairsEditor noun={stdio ? 'Variable' : 'Header'} title={stdio ? 'Environment variables' : 'Headers'} pairs={form.pairs} error={shown.pairs} onChange={(pairs) => update({ pairs })} />
    </EditorForm>
  );
}

/**
 * Headers or environment variables. A value is a literal, a `${secret:id}` / `${ENV}` reference, or a literal
 * marked to be kept as a secret: those move to the secret store on save (credential-like names are marked already).
 */
function PairsEditor({ noun, title, pairs, error, onChange }: { noun: string; title: string; pairs: Pair[]; error: string | undefined; onChange(pairs: Pair[]): void }) {
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
        const secret = wantsSecret(p) && !reference;
        return (
          <div key={i} className="flex items-center gap-2">
            <TextField aria-label={`${noun} ${i + 1} name`} placeholder="Name" spellCheck={false} value={p.name} className="w-40 shrink-0" onChange={(e) => set(i, { name: e.target.value })} />
            <TextField
              aria-label={`${noun} ${i + 1} value`}
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder="Value or ${secret:id}"
              spellCheck={false}
              value={p.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <IconButton
              icon={secret || p.value.includes('${secret:') ? Lock : LockOpen}
              label={`Keep ${noun.toLowerCase()} ${i + 1} as a secret`}
              aria-pressed={secret}
              disabled={reference}
              className="aria-pressed:text-interactive-text"
              onClick={() => set(i, { secret: !secret })}
            />
            <IconButton icon={X} label={`Remove ${noun.toLowerCase()} ${i + 1}`} onClick={() => onChange(pairs.filter((_, j) => j !== i))} />
          </div>
        );
      })}
      {pairs.some((p) => wantsSecret(p) && !p.value.includes('${')) && (
        <p className="text-footnote text-fg-muted">Locked values are stored encrypted in Keys & secrets; the connector only refers to them.</p>
      )}
      {error && <p className="text-footnote text-danger-text">{error}</p>}
    </div>
  );
}

function EditorForm({ onSubmit, error, saving, submitLabel, onBack, children }: { onSubmit(): void; error: string | null; saving: boolean; submitLabel: string; onBack?: (() => void) | undefined; children: ReactNode }) {
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
