import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ProviderConfig, SecretSummary } from '@atelier/protocol';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  Icon,
  IconButton,
  Select,
  TextField,
  Tooltip,
  toast,
  type SelectOption,
} from '../../components/ui/index.ts';
import { relativeTime, shortDate } from '../../lib/dates.ts';
import { keys, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { secretId } from './connector-form.ts';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { SecretField } from './secret-field.tsx';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';

type Kind = SecretSummary['kind'];

const KIND_LABELS: Record<Kind, string> = { api_key: 'API key', token: 'Token', mcp_oauth: 'OAuth token', github: 'GitHub', oidc: 'Client secret' };
/** What admins add by hand; OAuth and GitHub tokens come from their own sign-in flows. */
const KINDS: SelectOption<Kind>[] = [
  { value: 'api_key', label: 'API key' },
  { value: 'token', label: 'Token' },
];

/** A settings path that refers to a secret, as people know it: "Connector github", "Provider Anthropic", "Web search". */
export function usedByLabels(paths: string[], providers: ProviderConfig[]): string[] {
  const labels = paths.flatMap((path) => {
    const [head, name] = path.split('.');
    if (head === 'mcpServers' && name) return [`Connector ${name}`];
    if (head === 'providers' && name) return [`Provider ${providers.find((p) => p.id === name)?.name ?? name}`];
    if (path.startsWith('capabilities.webSearch.')) return ['Web search'];
    return [path];
  });
  return [...new Set(labels)];
}

/** The stored secrets as masked tails, what refers to them, and adding, rotating and deleting them. Plaintext never comes back. */
export function SecretsPage() {
  const { settings } = useSettings();
  const { data: secrets } = useQuery({ queryKey: keys.secrets, queryFn: () => rpc().call('secrets.list', {}), staleTime: 0 });
  const add = useDialog();
  const entry = settingEntry('secrets.list');
  return (
    <>
      <SettingsSection
        id="secrets.list"
        title={entry.label}
        description={entry.description}
        action={
          <Button size="sm" variant="primary" leadingIcon={Plus} onClick={add.show}>
            Add secret
          </Button>
        }
      >
        {secrets?.length === 0 ? (
          <p className="pb-3 text-body text-fg-muted">No secrets yet. Keys you enter for providers, web search and connectors are kept here.</p>
        ) : (
          <DataTable
            label={entry.label}
            columns={[
              { label: 'Secret' },
              { label: 'Value', className: 'w-24' },
              { label: 'Used by' },
              { label: 'Created', className: 'w-28' },
              { label: 'Last used', className: 'w-28' },
              { label: 'Rotated', className: 'w-28' },
              { label: 'Actions', hidden: true, className: 'w-[52px]' },
            ]}
          >
            {secrets?.map((s) => (
              <SecretRow key={s.id} secret={s} usedBy={usedByLabels(s.usedBy, settings?.providers ?? [])} />
            ))}
          </DataTable>
        )}
      </SettingsSection>
      <AddSecretDialog key={add.key} open={add.open} onOpenChange={add.onOpenChange} taken={new Set(secrets?.map((s) => s.id))} />
    </>
  );
}

function SecretRow({ secret, usedBy }: { secret: SecretSummary; usedBy: string[] }) {
  const qc = useQueryClient();
  const rotate = useDialog();
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    try {
      await rpc().call('secrets.delete', { id: secret.id });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await qc.invalidateQueries({ queryKey: keys.secrets });
  };
  return (
    <TableRow>
      <Cell title={`${secret.label} · \${secret:${secret.id}}`}>
        <span className="block truncate text-fg">{secret.label}</span>
        <span className="block truncate text-footnote text-fg-muted">{KIND_LABELS[secret.kind]}</span>
      </Cell>
      <Cell className="truncate font-mono text-code">{secret.masked}</Cell>
      <Cell>
        {usedBy.length ? (
          <ul aria-label={`Uses of ${secret.label}`}>
            {usedBy.map((label) => (
              <li key={label} title={label} className="truncate">
                {label}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-fg-muted">Not used</span>
        )}
      </Cell>
      <When at={secret.createdAt} />
      <When at={secret.lastUsedAt} never="Never" />
      <When at={secret.rotatedAt} never="—" />
      <Cell className="text-right">
        <span className="inline-flex items-center gap-0.5">
          <IconButton icon={RefreshCw} label={`Rotate ${secret.label}`} size="xs" onClick={rotate.show} />
          {usedBy.length ? (
            // aria-disabled rather than disabled: the button stays hoverable and focusable, so its tooltip can say why.
            <Tooltip content={`Used by ${usedBy.join(', ')}. Remove that first.`}>
              <Button size="xs" variant="ghost" iconOnly aria-label={`Delete ${secret.label}`} aria-disabled className="aria-disabled:pointer-events-auto">
                <Icon icon={Trash2} />
              </Button>
            </Tooltip>
          ) : (
            <IconButton icon={Trash2} label={`Delete ${secret.label}`} size="xs" onClick={() => setDeleting(true)} />
          )}
        </span>
      </Cell>
      <RotateDialog key={rotate.key} open={rotate.open} onOpenChange={rotate.onOpenChange} secret={secret} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${secret.label}?`}
        description="The value is erased and can’t be recovered. Nothing in settings refers to it."
        onConfirm={remove}
      />
    </TableRow>
  );
}

/** A relative time ("3 days ago"), with the date on hover. */
function When({ at, never }: { at: number | null; never?: string }) {
  return <Cell title={at === null ? undefined : shortDate(at)}>{at === null ? never : relativeTime(at)}</Cell>;
}

interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** Stores `input` (a new secret, or a new value for one); the value is never sent back. */
function useStoreSecret(onDone: () => void) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const store = async (input: { id: string; label: string; kind: Kind; value: string }, success: string) => {
    setSaving(true);
    setError(null);
    try {
      await rpc().call('secrets.set', input);
      await qc.invalidateQueries({ queryKey: keys.secrets });
      toast.success(success);
      onDone();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, store };
}

function RotateDialog({ open, onOpenChange, secret }: DialogProps & { secret: SecretSummary }) {
  const [value, setValue] = useState('');
  const { saving, error, store } = useStoreSecret(() => onOpenChange(false));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Rotate ${secret.label}`} description="The new value replaces the old one everywhere it is used, from the next connection on.">
        <SecretForm
          error={error}
          saving={saving}
          submitLabel="Rotate"
          disabled={!value.trim()}
          onSubmit={() => store({ id: secret.id, label: secret.label, kind: secret.kind, value: value.trim() }, `Rotated ${secret.label}`)}
        >
          <Field label="New value">
            <SecretField value={value} onValueChange={setValue} placeholder="Paste the new value" />
          </Field>
        </SecretForm>
      </DialogContent>
    </Dialog>
  );
}

function AddSecretDialog({ open, onOpenChange, taken }: DialogProps & { taken: ReadonlySet<string> }) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<Kind>('api_key');
  const [value, setValue] = useState('');
  const { saving, error, store } = useStoreSecret(() => onOpenChange(false));
  const base = secretId(label) || 'secret';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 60)}-${n}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add secret" description="For settings that refer to a key by reference, such as a custom connector’s header.">
        <SecretForm
          error={error}
          saving={saving}
          submitLabel="Add secret"
          disabled={!label.trim() || !value.trim()}
          onSubmit={() => store({ id, label: label.trim(), kind, value: value.trim() }, `Added ${label.trim()}`)}
        >
          <Field label="Label" description={`Refer to it in settings as \${secret:${id}}.`}>
            <TextField autoFocus value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Kind">
            <Select variant="field" options={KINDS} value={kind} onValueChange={setKind} />
          </Field>
          <Field label="Value">
            <SecretField value={value} onValueChange={setValue} placeholder="Paste it here" />
          </Field>
        </SecretForm>
      </DialogContent>
    </Dialog>
  );
}

function SecretForm({
  error,
  saving,
  submitLabel,
  disabled,
  onSubmit,
  children,
}: {
  error: string | null;
  saving: boolean;
  submitLabel: string;
  disabled: boolean;
  onSubmit(): void;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <div className="flex flex-col gap-4">{children}</div>
      {error && (
        <p role="alert" className="mt-4 text-body text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-6 flex items-center justify-end gap-3">
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" disabled={disabled} loading={saving}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
