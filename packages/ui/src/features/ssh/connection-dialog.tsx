/**
 * Add SSH connection (design/components.md › SSH): a name, the host (`user@hostname` or one from ~/.ssh/config), a
 * port, an optional key, a starting folder and Test connection, which asks about a new host's key or a password the same
 * way a real connection does.
 */
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { SshConnectionInput, type SshConnectionView } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Field, TextField } from '../../components/ui/index.ts';
import { desktop } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { lendSsh } from '../../lib/lending.ts';

interface Values {
  name: string;
  host: string;
  port: string;
  keyPath: string;
  folder: string;
}

const toInput = (v: Values) => ({
  name: v.name,
  host: v.host,
  port: v.port.trim() ? Number(v.port) : null,
  keyPath: v.keyPath.trim() || null,
  folder: v.folder.trim() || null,
});

type Errors = Partial<Record<keyof Values | 'form', string>>;

/** Validates what was typed (the same rules the backend applies); the messages, by field. */
export function validate(v: Values): { errors: Errors; input?: SshConnectionInput } {
  const port = v.port.trim();
  const errors: Errors = {};
  if (port && !/^\d+$/.test(port)) errors.port = 'Use a port number, or leave it empty.';
  const parsed = SshConnectionInput.safeParse(toInput(v));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[issue.path[0] as keyof Values] ??= issue.message;
  }
  return Object.keys(errors).length || !parsed.success ? { errors } : { errors, input: parsed.data };
}

/** Adds a connection, or changes `connection`; `onSaved` hears of it. */
export function SshConnectionDialog({
  open,
  onOpenChange,
  connection,
  onSaved,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  connection?: SshConnectionView;
  onSaved?(connection: SshConnectionView): void;
}) {
  const qc = useQueryClient();
  const hostList = useId();
  const { data: hosts } = useQuery({ queryKey: ['sshHosts'], queryFn: () => rpc().call('workspaces.sshHosts', {}), enabled: open, staleTime: 0 });
  const [values, setValues] = useState<Values>({
    name: connection?.name ?? '',
    host: connection?.host ?? '',
    port: connection?.port ? String(connection.port) : '',
    keyPath: connection?.keyPath ?? '',
    folder: connection?.folder ?? '',
  });
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState<'save' | 'test' | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; message: string } | null>(null);
  const set = (key: keyof Values) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setTested(null);
  };

  const test = async () => {
    const { errors: found, input } = validate(values);
    setErrors(found);
    if (!input) return;
    setPending('test');
    setTested(null);
    try {
      // Tried from this computer: a server may reach the host from here.
      await lendSsh(input.host);
      setTested(await rpc().call('ssh.test', { ...input, ...(connection ? { id: connection.id } : {}) }));
    } catch (e) {
      setTested({ ok: false, message: describeError(e).message });
    } finally {
      setPending(null);
    }
  };

  const save = async () => {
    const { errors: found, input } = validate(values);
    setErrors(found);
    if (!input) return;
    setPending('save');
    try {
      await lendSsh(input.host);
      const saved = await rpc().call('ssh.save', { ...input, ...(connection ? { id: connection.id } : {}) });
      await qc.invalidateQueries({ queryKey: keys.ssh });
      onOpenChange(false);
      onSaved?.(saved);
    } catch (e) {
      setErrors({ form: describeError(e).message });
    } finally {
      setPending(null);
    }
  };

  const text = (key: keyof Values) => ({
    value: values[key],
    onChange: (e: { target: { value: string } }) => set(key)(e.target.value),
    autoCapitalize: 'none' as const,
    autoComplete: 'off',
    spellCheck: false,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={connection ? 'Edit SSH connection' : 'Add SSH connection'}
        description="Connect to a remote machine to work in its folders. Atelier uses your ssh setup: ~/.ssh/config, your keys and agent."
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Name" description="A friendly name for this SSH connection." error={errors.name}>
            <TextField autoFocus placeholder="Work laptop" {...text('name')} />
          </Field>
          <Field label="SSH host" description="user@myserver.com or a host from ~/.ssh/config." error={errors.host}>
            <TextField list={hostList} placeholder="user@hostname" className="font-mono" {...text('host')} />
            <datalist id={hostList}>
              {hosts?.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </Field>
          <Field label="SSH port" description="Leave empty to use the default (22) or your SSH configuration." error={errors.port}>
            <TextField inputMode="numeric" placeholder="22" className="font-mono" {...text('port')} />
          </Field>
          <Field label="SSH key (optional)" description="Path to a private key. Leave empty to use your SSH configuration or agent." error={errors.keyPath}>
            <div className="flex gap-2">
              <TextField placeholder="~/.ssh/id_ed25519" className="flex-1 font-mono" {...text('keyPath')} />
              {desktop && (
                <Button
                  onClick={() =>
                    void desktop!.files.pickKey().then((picked) => {
                      if (picked) set('keyPath')(picked);
                    })
                  }
                >
                  Browse…
                </Button>
              )}
            </div>
          </Field>
          <Field label="Starting folder (optional)" description="Where new sessions start on this host. Start with ~/ for its home folder." error={errors.folder}>
            <TextField placeholder="~/projects" className="font-mono" {...text('folder')} />
          </Field>
          <div className="flex items-start gap-3">
            <Button onClick={() => void test()} loading={pending === 'test'} disabled={pending === 'save'}>
              Test connection
            </Button>
            {tested && (
              <p role="status" className={`flex min-w-0 items-start gap-1.5 pt-1 text-footnote ${tested.ok ? 'text-success-text' : 'text-danger-text'}`}>
                {tested.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
                <span className="min-w-0 break-words">{tested.message}</span>
              </p>
            )}
          </div>
          {errors.form && (
            <p role="alert" className="text-footnote text-danger-text">
              {errors.form}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={pending === 'save'}>
              {connection ? 'Save' : 'Add SSH connection'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
