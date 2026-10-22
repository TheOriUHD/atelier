/**
 * Settings › Account on "Run on this computer": the optional screen lock (design/components.md › Screen lock rows).
 * The backend keeps the PIN or password as a slow hash and checks it; this only collects it.
 */
import { useState } from 'react';
import { z } from 'zod';
import {
  LOCK_PASSWORD_MIN,
  LOCK_PIN_RE,
  type AutoLockMinutes,
  type ScreenLockKind,
  type ScreenLockStatus,
} from '@atelier/protocol';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  SegmentedControl,
  Select,
  TextField,
  toast,
  type SelectOption,
} from '../../components/ui/index.ts';
import { useFormSubmit } from '../auth/form.ts';
import { useScreenLock } from '../auth/screen-lock.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { settingEntry } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';

const AUTO_LOCK: SelectOption<`${AutoLockMinutes}`>[] = [
  { value: '0', label: 'Never' },
  { value: '5', label: 'After 5 minutes' },
  { value: '15', label: 'After 15 minutes' },
  { value: '30', label: 'After 30 minutes' },
  { value: '60', label: 'After 1 hour' },
];

const KINDS = [
  { value: 'pin', label: 'PIN' },
  { value: 'password', label: 'Password' },
] as const;

const noun = (kind: ScreenLockKind | null) => (kind === 'password' ? 'password' : 'PIN');

export function ScreenLockSection() {
  const lock = useScreenLock();
  const setting = useDialog();
  const turningOff = useDialog();
  const [autoError, setAutoError] = useState<string | null>(null);
  const entry = settingEntry('account.screenLock');
  if (!lock) return null;

  const lockNow = () =>
    void rpc()
      .call('lock.lock', {})
      .catch((e: unknown) => toast.error(describeError(e).message));
  const setAutoLock = async (value: string) => {
    setAutoError(null);
    try {
      await rpc().call('lock.setAutoLock', { minutes: Number(value) as AutoLockMinutes });
    } catch (e) {
      setAutoError(describeError(e).message);
    }
  };

  return (
    <SettingsSection id="account.screenLock" title={entry.label} description={entry.description}>
      <SettingRow id="account.lockSecret" detail={lock.enabled ? `On, with a ${noun(lock.kind)}.` : 'Off.'}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {lock.enabled ? (
            <>
              <Button variant="ghost" onClick={turningOff.show}>
                Turn off
              </Button>
              <Button onClick={setting.show}>Change</Button>
              <Button onClick={lockNow}>Lock now</Button>
            </>
          ) : (
            <Button onClick={setting.show}>Set up</Button>
          )}
        </div>
      </SettingRow>
      {lock.enabled && (
        <SettingRow id="account.autoLock" error={autoError}>
          {(label) => (
            <Select
              {...label}
              options={AUTO_LOCK}
              value={`${lock.autoLockMinutes}`}
              onValueChange={(v) => void setAutoLock(v)}
            />
          )}
        </SettingRow>
      )}
      <SetLockDialog key={setting.key} open={setting.open} onOpenChange={setting.onOpenChange} lock={lock} />
      <TurnOffDialog key={turningOff.key} open={turningOff.open} onOpenChange={turningOff.onOpenChange} lock={lock} />
    </SettingsSection>
  );
}

const SetLock = z
  .object({
    kind: z.enum(['pin', 'password']),
    current: z.string(),
    secret: z.string(),
    confirm: z.string(),
    changing: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.changing && !v.current)
      ctx.addIssue({ code: 'custom', path: ['current'], message: 'Enter the one you use now.' });
    if (v.kind === 'pin' && !LOCK_PIN_RE.test(v.secret))
      ctx.addIssue({ code: 'custom', path: ['secret'], message: 'Use 4 to 8 digits.' });
    if (v.kind === 'password' && v.secret.length < LOCK_PASSWORD_MIN)
      ctx.addIssue({ code: 'custom', path: ['secret'], message: `At least ${LOCK_PASSWORD_MIN} characters.` });
    if (v.secret !== v.confirm)
      ctx.addIssue({
        code: 'custom',
        path: ['confirm'],
        message: v.kind === 'pin' ? 'The PINs don’t match.' : 'The passwords don’t match.',
      });
  });

function SetLockDialog({
  open,
  onOpenChange,
  lock,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  lock: ScreenLockStatus;
}) {
  const changing = lock.enabled;
  const [kind, setKind] = useState<ScreenLockKind>(lock.kind ?? 'pin');
  const [current, setCurrent] = useState('');
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const form = useFormSubmit(
    SetLock,
    { wrong_secret: 'current', rate_limited: 'current', invalid_lock: 'secret' },
    async (v) => {
      await rpc().call('lock.set', {
        lock: { kind: v.kind, secret: v.secret },
        ...(changing ? { current: v.current } : {}),
      });
      toast.success(
        changing
          ? `Screen lock ${noun(v.kind)} changed.`
          : 'Screen lock is on. Atelier locks when it starts and when you lock it.',
      );
      onOpenChange(false);
    },
  );
  const pin = kind === 'pin';
  const digits = (value: string) => (pin ? value.replace(/\D/g, '') : value);
  const currentPin = lock.kind === 'pin';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={changing ? 'Change the screen lock' : 'Set up a screen lock'}
        description="It hides Atelier until you enter it. Your data on this computer is not encrypted by it."
      >
        <form
          noValidate
          onSubmit={form.onSubmit({ kind, current, secret, confirm, changing })}
          className="flex flex-col gap-4"
        >
          {changing && (
            <Field label={currentPin ? 'Current PIN' : 'Current password'} error={form.errors.current}>
              <TextField
                type="password"
                autoFocus
                autoComplete="off"
                inputMode={currentPin ? 'numeric' : undefined}
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
          )}
          <SegmentedControl
            aria-label="Lock with"
            items={KINDS}
            value={kind}
            onValueChange={(v) => {
              setKind(v);
              setSecret('');
              setConfirm('');
            }}
            className="self-start"
          />
          <Field
            label={pin ? 'New PIN' : 'New password'}
            description={pin ? '4 to 8 digits.' : `At least ${LOCK_PASSWORD_MIN} characters.`}
            error={form.errors.secret}
          >
            <TextField
              type="password"
              autoFocus={!changing}
              autoComplete="new-password"
              inputMode={pin ? 'numeric' : undefined}
              maxLength={pin ? 8 : 256}
              value={secret}
              onChange={(e) => setSecret(digits(e.target.value))}
            />
          </Field>
          <Field label={pin ? 'Confirm PIN' : 'Confirm password'} error={form.errors.confirm}>
            <TextField
              type="password"
              autoComplete="new-password"
              inputMode={pin ? 'numeric' : undefined}
              maxLength={pin ? 8 : 256}
              value={confirm}
              onChange={(e) => setConfirm(digits(e.target.value))}
            />
          </Field>
          {form.errors.form && (
            <p role="alert" className="text-footnote text-danger-text">
              {form.errors.form}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              {changing ? 'Change' : 'Turn on'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const TurnOff = z.object({ current: z.string().min(1, 'Enter the one you use now.') });

function TurnOffDialog({
  open,
  onOpenChange,
  lock,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  lock: ScreenLockStatus;
}) {
  const [current, setCurrent] = useState('');
  const pin = lock.kind === 'pin';
  const form = useFormSubmit(TurnOff, { wrong_secret: 'current', rate_limited: 'current' }, async (v) => {
    await rpc().call('lock.clear', { current: v.current });
    toast.success('Screen lock is off.');
    onOpenChange(false);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Turn off the screen lock?" description="Atelier then opens without asking.">
        <form noValidate onSubmit={form.onSubmit({ current })} className="flex flex-col gap-4">
          <Field label={pin ? 'Current PIN' : 'Current password'} error={form.errors.current ?? form.errors.form}>
            <TextField
              type="password"
              autoFocus
              autoComplete="off"
              inputMode={pin ? 'numeric' : undefined}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={form.pending}>
              Turn off
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
