import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Password } from '@atelier/protocol';
import { Field, TextField } from '../../components/ui/index.ts';
import { rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from './form.ts';

const New = z.object({ current: z.string(), next: Password, confirm: z.string() });
const matching = (v: z.infer<typeof New>) => v.next === v.confirm;
const Change = New.extend({ current: z.string().min(1, 'Enter your current password.') }).refine(matching, { path: ['confirm'], message: 'The passwords don’t match.' });
const First = New.refine(matching, { path: ['confirm'], message: 'The passwords don’t match.' });

/**
 * Current password, new password and its confirmation. Changing it signs out the account's other
 * sessions. `actions` renders the submit row and receives whether the change is in flight. An account
 * without a password (`first`, made through an identity provider) has no current one to ask for.
 */
export function ChangePasswordForm({
  currentLabel = 'Current password',
  first = false,
  onDone,
  actions,
}: {
  currentLabel?: string;
  first?: boolean;
  onDone(): void;
  actions(pending: boolean): ReactNode;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const form = useFormSubmit(first ? First : Change, { invalid_credentials: 'current' }, async (v) => {
    await rpc().call('account.changePassword', { current: v.current, next: v.next });
    onDone();
  });

  return (
    <form noValidate onSubmit={form.onSubmit({ current, next, confirm })} className="flex flex-col gap-4">
      {!first && (
        <Field label={currentLabel} error={form.errors.current}>
          <TextField
            type="password"
            autoComplete="current-password"
            autoFocus
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
      )}
      <Field label="New password" description="At least 8 characters." error={form.errors.next}>
        <TextField type="password" autoComplete="new-password" autoFocus={first} value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirm new password" error={form.errors.confirm}>
        <TextField
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      {form.errors.form && (
        <p role="alert" className="text-footnote text-danger-text">
          {form.errors.form}
        </p>
      )}
      {actions(form.pending)}
    </form>
  );
}
