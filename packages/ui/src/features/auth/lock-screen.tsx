/**
 * The screen lock of "Run on this computer" (design/components.md › LockScreen). While it shows, nothing else of the
 * app is rendered and the backend refuses every call but unlocking. A forgotten PIN is removed with Touch ID on macOS,
 * or by deleting the lock file, which takes the same access to this computer as reading the data.
 */
import { useEffect, useState } from 'react';
import { FingerprintPattern } from 'lucide-react';
import { RpcError, type ScreenLockStatus } from '@atelier/protocol';
import { Button, Field, TextField } from '../../components/ui/index.ts';
import { desktop } from '../../lib/platform.ts';
import { describeError, errorCode, rpc } from '../../lib/rpc.ts';
import { AuthLayout, LinkButton } from './auth-screens.tsx';

export const LOCK_FILE = 'screen-lock.json';

/** "30 seconds", "2 minutes". */
function waitFor(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export function LockScreen({ status, name }: { status: ScreenLockStatus; name?: string }) {
  const pin = status.kind === 'pin';
  const noun = pin ? 'PIN' : 'password';
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [retryAt, setRetryAt] = useState(status.retryAt);
  const [now, setNow] = useState(() => Date.now());
  const [forgot, setForgot] = useState(false);
  const waiting = retryAt !== null && retryAt > now;

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const unlock = async () => {
    if (!secret || pending || waiting) return;
    setPending(true);
    setError(undefined);
    try {
      // The backend's `lock.changed` takes every window back to the app.
      await rpc().call('lock.unlock', { secret });
    } catch (e) {
      setSecret('');
      const next = e instanceof RpcError && typeof e.data?.retryAt === 'number' ? (e.data.retryAt as number) : null;
      setRetryAt(next);
      setNow(Date.now());
      setError(errorCode(e) === 'rate_limited' ? undefined : describeError(e).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      title="Atelier is locked"
      subtitle={name ? `Welcome back, ${name}. Enter your ${noun} to continue.` : `Enter your ${noun} to continue.`}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void unlock();
        }}
        className="flex flex-col gap-4"
      >
        <Field label={pin ? 'PIN' : 'Password'} error={error}>
          <TextField
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            inputMode={pin ? 'numeric' : undefined}
            maxLength={pin ? 8 : 256}
            value={secret}
            onChange={(e) => setSecret(pin ? e.target.value.replace(/\D/g, '') : e.target.value)}
            className="h-10"
          />
        </Field>
        {waiting && (
          <p role="status" className="text-footnote text-fg-muted">
            Too many wrong tries. Try again in {waitFor(retryAt - now)}.
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={waiting || !secret}>
          Unlock
        </Button>
      </form>
      <div className="mt-4 flex flex-col items-center gap-3 text-center text-body text-fg-secondary">
        {forgot ? (
          <ForgotHelp noun={noun} />
        ) : (
          <LinkButton onClick={() => setForgot(true)}>Forgot your {noun}?</LinkButton>
        )}
      </div>
    </AuthLayout>
  );
}

/** Touch ID where the Mac has it; elsewhere, where the lock file is. Neither shows any data. */
function ForgotHelp({ noun }: { noun: string }) {
  const [touchId, setTouchId] = useState<boolean | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    void desktop?.lock.canUseSystem().then(setTouchId, () => setTouchId(false));
    void desktop?.system.get().then(
      (s) => setFolder(s.dataFolder),
      () => undefined,
    );
  }, []);

  const remove = async () => {
    setMessage(undefined);
    const result = await desktop!.lock.removeWithSystem();
    if (result === 'cancelled') setMessage('Touch ID didn’t confirm it. The lock stays.');
    if (result === 'unavailable') setTouchId(false);
  };

  return (
    <>
      {touchId && (
        <>
          <p>
            Remove the lock with Touch ID. Your chats and settings stay as they are; you can set a new {noun} in
            Settings.
          </p>
          <Button leadingIcon={FingerprintPattern} onClick={() => void remove()}>
            Remove lock with Touch ID
          </Button>
          {message && <p role="alert">{message}</p>}
        </>
      )}
      {touchId === false && (
        <p>
          Quit Atelier, delete <span className="font-mono text-fg">{LOCK_FILE}</span>
          {folder ? (
            <>
              {' '}
              in <span className="font-mono break-all text-fg">{folder}</span>
            </>
          ) : (
            ' in Atelier’s data folder'
          )}
          , then open Atelier again. Your chats and settings stay as they are.
        </p>
      )}
    </>
  );
}
