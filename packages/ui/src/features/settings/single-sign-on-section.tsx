import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { oidcProviderId, type OidcNewAccounts, type OidcProviderSummary } from '@atelier/protocol';
import { Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, Field, IconButton, Select, TextField, type SelectOption } from '../../components/ui/index.ts';
import { toast } from '../../components/ui/toaster.tsx';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from '../auth/form.ts';
import { CopyButton } from '../chat/copy-button.tsx';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { settingEntry } from './search-index.ts';
import { SecretField } from './secret-field.tsx';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';

const PROVIDERS = ['server', 'oidc'] as const;

const NEW_ACCOUNTS: SelectOption<OidcNewAccounts>[] = [
  { value: 'pending', label: 'Create an account an admin approves' },
  { value: 'user', label: 'Create an account right away' },
  { value: 'none', label: 'Turn them away' },
];
const NEW_ACCOUNT_WORDS: Record<OidcNewAccounts, string> = { pending: 'With approval', user: 'Right away', none: 'Existing accounts only' };

/** Settings › Admin › Server: the identity providers people sign in with in a browser. Absent on the desktop app's own backend. */
export function SingleSignOnSection() {
  const entry = settingEntry('server.oidc');
  const { data } = useQuery({ queryKey: PROVIDERS, queryFn: () => rpc().call('oidc.list', {}), staleTime: 0 });
  const adding = useDialog();
  if (!data) return null;
  return (
    <SettingsSection
      id="server.oidc"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" leadingIcon={Plus} onClick={adding.show}>
          Add provider
        </Button>
      }
    >
      {data.providers.length === 0 ? (
        <p className="pb-3 text-body text-fg-muted">No identity providers yet.</p>
      ) : (
        <DataTable
          label={entry.label}
          columns={[{ label: 'Name' }, { label: 'New people', className: 'w-44' }, { label: 'Accounts', className: 'w-24' }, { label: 'Actions', hidden: true, className: 'w-20' }]}
        >
          {data.providers.map((p) => (
            <ProviderRow key={p.id} provider={p} redirectBase={data.redirectBase} />
          ))}
        </DataTable>
      )}
      <ProviderDialog key={adding.key} open={adding.open} onOpenChange={adding.onOpenChange} redirectBase={data.redirectBase} />
    </SettingsSection>
  );
}

function ProviderRow({ provider, redirectBase }: { provider: OidcProviderSummary; redirectBase: string }) {
  const qc = useQueryClient();
  const editing = useDialog();
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    try {
      await rpc().call('oidc.remove', { id: provider.id });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await qc.invalidateQueries({ queryKey: PROVIDERS });
  };
  return (
    <TableRow>
      <Cell className="truncate text-fg" title={provider.issuer}>
        {provider.name}
      </Cell>
      <Cell>{NEW_ACCOUNT_WORDS[provider.newAccounts]}</Cell>
      <Cell className="tabular-nums">{provider.people}</Cell>
      <Cell className="text-right">
        <IconButton icon={Pencil} label={`Edit ${provider.name}`} size="sm" onClick={editing.show} />
        <IconButton icon={Trash2} label={`Remove ${provider.name}`} size="sm" onClick={() => setConfirm(true)} />
        <ProviderDialog key={editing.key} open={editing.open} onOpenChange={editing.onOpenChange} redirectBase={redirectBase} provider={provider} />
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Remove ${provider.name}?`}
          description="It no longer signs anyone in. Their accounts stay; those who have no password or passkey need a password from an admin."
          confirmLabel="Remove"
          onConfirm={remove}
        />
      </Cell>
    </TableRow>
  );
}

const Fields = z.object({
  name: z.string().trim().min(1, 'Name it: the sign-in page says “Continue with” this name.').max(60),
  issuer: z.url('Enter the issuer’s address, starting with https://.').trim().max(2048),
  clientId: z.string().trim().min(1, 'Enter the client ID from your provider.').max(512),
});

function ProviderDialog({
  open,
  onOpenChange,
  redirectBase,
  provider,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  redirectBase: string;
  provider?: OidcProviderSummary;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(provider?.name ?? '');
  const [issuer, setIssuer] = useState(provider?.issuer ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [newAccounts, setNewAccounts] = useState<OidcNewAccounts>(provider?.newAccounts ?? 'pending');
  const form = useFormSubmit(Fields, { exists: 'name' }, async (v) => {
    await rpc().call('oidc.save', { ...v, newAccounts, ...(provider ? { id: provider.id } : {}), ...(secret ? { clientSecret: secret } : {}) });
    await qc.invalidateQueries({ queryKey: PROVIDERS });
    toast.success(provider ? `${v.name} saved.` : `${v.name} added. Connect your own account in Settings › Account.`);
    onOpenChange(false);
  });
  const redirectUri = `${redirectBase}/${provider?.id ?? oidcProviderId(name)}/callback`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={provider ? `Edit ${provider.name}` : 'Add an identity provider'}
        description="Create an OpenID Connect application at your provider, with this redirect URI, then fill in what it gives you."
      >
        <form noValidate onSubmit={form.onSubmit({ name, issuer, clientId })} className="flex flex-col gap-4">
          <Field label="Name" description="The sign-in page says “Continue with” this name." error={form.errors.name}>
            <TextField autoFocus maxLength={60} placeholder="Authentik" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Redirect URI" description={provider ? undefined : 'Follows the name until you add the provider, then it stays.'}>
            <div className="flex items-center gap-2">
              <TextField readOnly value={redirectUri} className="min-w-0 flex-1 font-mono text-code" />
              <CopyButton text={redirectUri} size="md" label="Copy redirect URI" />
            </div>
          </Field>
          <Field label="Issuer" description="Authentik calls it OpenID Configuration Issuer." error={form.errors.issuer}>
            <TextField
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://auth.example.com/application/o/atelier/"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
            />
          </Field>
          <Field label="Client ID" error={form.errors.clientId}>
            <TextField autoComplete="off" autoCapitalize="none" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </Field>
          <Field label="Client secret" description="Leave it empty for a public client.">
            <SecretField value={secret} onValueChange={setSecret} stored={provider?.secret ?? undefined} placeholder="Paste it here" />
          </Field>
          <Field label="Someone without an account here" description="Your provider decides who gets this far; only an account you connected yourself is matched to an existing one.">
            <Select options={NEW_ACCOUNTS} value={newAccounts} onValueChange={setNewAccounts} />
          </Field>
          {form.errors.form && (
            <p role="alert" className="text-footnote text-danger-text">
              {form.errors.form}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              {provider ? 'Save' : 'Add provider'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
