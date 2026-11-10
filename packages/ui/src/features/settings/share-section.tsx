import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { z } from 'zod';
import { Password, type NetworkShare } from '@atelier/protocol';
import { Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, Field, Icon, IconButton, Switch, TextField } from '../../components/ui/index.ts';
import { toast } from '../../components/ui/toaster.tsx';
import { writeClipboard } from '../../lib/copy-diagnostics.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from '../auth/form.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { settingEntry } from './search-index.ts';

const SHARE = ['network', 'share'] as const;

/**
 * Settings › Connection › Share on your network, on this computer's own backend: other devices on the network use Atelier
 * here as a server, signed in as the person with a password (core/network/share-server.ts).
 */
export function ShareSection() {
  const qc = useQueryClient();
  const { data: share } = useQuery({
    queryKey: SHARE,
    queryFn: () => rpc().call('network.status', {}),
    // Who is signed in from the network changes without this window doing anything.
    refetchInterval: (query) => (query.state.data?.enabled ? 5000 : false),
  });
  const [setup, setSetup] = useState<'on' | 'password' | 'port' | null>(null);
  const [stopping, setStopping] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const entry = settingEntry('connection.share');
  if (!share) return null;
  const saved = (next: NetworkShare) => qc.setQueryData(SHARE, next);
  const change = async (input: { enabled: boolean; port?: number; password?: string }) => saved(await rpc().call('network.set', input));
  const turnOff = async () => {
    try {
      await change({ enabled: false });
      toast.success('Atelier is no longer shared on your network.');
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };
  return (
    <SettingsSection id="connection.share" title={entry.label} description={entry.description}>
      <SettingRow
        id="connection.shareSwitch"
        detail={share.enabled ? <ShareState share={share} /> : undefined}
        error={share.enabled ? share.error : null}
      >
        {(label) => (
          <Switch
            {...label}
            checked={share.enabled}
            onCheckedChange={(on) => {
              if (on) setSetup('on');
              else if (share.signedIn > 0) setStopping(true);
              else void turnOff();
            }}
          />
        )}
      </SettingRow>
      {share.enabled && share.listening && <Addresses share={share} />}
      {share.enabled && (
        <div className="flex flex-wrap justify-end gap-2 py-3">
          <Button onClick={() => setSetup('port')}>Change port…</Button>
          <Button onClick={() => setSetup('password')}>Change password…</Button>
          <Button disabled={share.signedIn === 0} onClick={() => setSigningOut(true)}>
            Sign everyone out
          </Button>
        </div>
      )}
      <ShareDialog share={share} step={setup} onClose={() => setSetup(null)} onChange={change} />
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title="Stop sharing on your network?"
        description={`${signedInText(share.signedIn)} on other devices ${share.signedIn === 1 ? 'is' : 'are'} signed out, and they can’t reach Atelier here until you share it again.`}
        confirmLabel="Stop sharing"
        onConfirm={turnOff}
      />
      <ConfirmDialog
        open={signingOut}
        onOpenChange={setSigningOut}
        title="Sign everyone out?"
        description="Every browser and app on the network signed in to Atelier here is signed out. They can sign in again with the password."
        confirmLabel="Sign everyone out"
        onConfirm={async () => {
          try {
            saved(await rpc().call('network.signOutAll', {}));
          } catch (e) {
            toast.error(describeError(e).message);
          }
        }}
      />
    </SettingsSection>
  );
}

const signedInText = (n: number) => (n === 1 ? 'One sign-in' : `${n} sign-ins`);

function ShareState({ share }: { share: NetworkShare }) {
  if (!share.listening) return <>Not reachable right now.</>;
  return (
    <>
      On port {share.port}. Sign in as <span className="text-fg">{share.username}</span> with the password you chose.{' '}
      {share.signedIn === 0 ? 'No device is signed in.' : `${signedInText(share.signedIn)} from the network.`}
    </>
  );
}

/** Where other devices open it, each with a copy button. */
function Addresses({ share }: { share: NetworkShare }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line-subtle pb-3">
      <ul className="flex flex-col gap-1.5">
        {share.addresses.map((address) => (
          <li key={address}>
            <CopyAddress address={address} />
          </li>
        ))}
      </ul>
      <p className="text-footnote text-fg-muted">
        Open one of these in a browser on the other device, or choose this computer under “Found on your network” in the Atelier app there.
      </p>
    </div>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-fill-ghost-hover py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-body text-fg">{address}</code>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? 'Copied' : `Copy ${address}`}
        size="sm"
        onClick={() =>
          void writeClipboard(address).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      />
    </div>
  );
}

const Port = z.coerce.number({ error: 'Enter a number.' }).int('Enter a whole number.').min(1024, 'Choose a port from 1024 to 65535.').max(65535, 'Choose a port from 1024 to 65535.');

/** Turning it on (the password first, if none was chosen), a new password, or another port. */
function ShareDialog({
  share,
  step,
  onClose,
  onChange,
}: {
  share: NetworkShare;
  step: 'on' | 'password' | 'port' | null;
  onClose(): void;
  onChange(input: { enabled: boolean; port?: number; password?: string }): Promise<unknown>;
}) {
  const needsPassword = step === 'password' || (step === 'on' && !share.passwordSet);
  const askPort = step === 'port' || step === 'on';
  const [values, setValues] = useState({ password: '', port: String(share.port) });
  const schema = z.object({ password: needsPassword ? Password : z.string(), port: Port });
  const form = useFormSubmit(schema, {}, async ({ password, port }) => {
    await onChange({ enabled: step === 'on' ? true : share.enabled, port, ...(needsPassword ? { password } : {}) });
    onClose();
    if (step === 'password') toast.success('Password changed. Devices on the network sign in again with the new one.');
  });
  const title = step === 'password' ? 'Change the password' : step === 'port' ? 'Change the port' : 'Share Atelier on your network';
  return (
    <Dialog
      open={step !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
        else setValues({ password: '', port: String(share.port) });
      }}
    >
      <DialogContent
        title={title}
        description={
          step === 'password'
            ? 'Every device on the network is signed out and signs in again with the new password.'
            : step === 'port'
              ? 'Other devices reach Atelier here at this port. Atelier apps look for 7340 on the network.'
              : 'Phones, tablets and other computers on this network open Atelier here and sign in as you.'
        }
      >
        <form noValidate onSubmit={form.onSubmit(values)} className="flex flex-col gap-4">
          {step === 'on' && (
            <div className="flex gap-3 rounded-xl bg-warning-subtle p-3 text-body text-fg">
              <Icon icon={TriangleAlert} size="md" className="mt-0.5 shrink-0 text-warning-text" />
              <div className="flex flex-col gap-1.5">
                <p>They can do what you can here: use your chats, models and keys, and run commands in your folders.</p>
                <p className="text-fg-muted">
                  Share only on a network you trust, such as your home’s: the connection isn’t encrypted. For use away from home, an Atelier server with HTTPS is the way.
                </p>
              </div>
            </div>
          )}
          {needsPassword && (
            <>
              <Field label="Username">
                <TextField value={share.username} readOnly />
              </Field>
              <Field label={step === 'password' ? 'New password' : 'Password'} error={form.errors.password} description="At least 8 characters.">
                <TextField
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  value={values.password}
                  onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
                />
              </Field>
            </>
          )}
          {askPort && (
            <Field label="Port" error={form.errors.port}>
              <div className="w-32">
                <TextField inputMode="numeric" value={values.port} onChange={(e) => setValues((v) => ({ ...v, port: e.target.value }))} />
              </div>
            </Field>
          )}
          {step === 'on' && <p className="text-footnote text-fg-muted">If this computer asks whether Atelier may accept incoming connections, allow it.</p>}
          {form.errors.form && (
            <p role="alert" className="text-body text-danger-text">
              {form.errors.form}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button disabled={form.pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              {step === 'password' ? 'Change password' : step === 'port' ? 'Change port' : 'Share'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
