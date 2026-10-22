import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Password } from '@atelier/protocol';
import { Field, TextField } from '../../components/ui/index.ts';
import { rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from './form.ts';

const Schema = z
  .object({ current: z.string().min(1, 'Enter your current password.'), next: Password, confirm: z.string() })
  .refine((v) => v.next === v.confirm, { path: ['confirm'], message: 'The passwords don’t match.' });

/**
 * Current password, new password and its confirmation. Changing it signs out the account's other
 * sessions. `actions` renders the submit row and receives whether the change is in flight.
 */
export function ChangePasswordForm({
  currentLabel = 'Current password',
  onDone,
  actions,
}: {
  currentLabel?: string;
  onDone(): void;
  actions(pending: boolean): ReactNode;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const form = useFormSubmit(Schema, { invalid_credentials: 'current' }, async (v) => {
    await rpc().call('account.changePassword', { current: v.current, next: v.next });
    onDone();
  });

  return (
    <form noValidate onSubmit={form.onSubmit({ current, next, confirm })} className="flex flex-col gap-4">
      <Field label={currentLabel} error={form.errors.current}>
        <TextField
          type="password"
          autoComplete="current-password"
          autoFocus
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field label="New password" description="At least 8 characters." error={form.errors.next}>
        <TextField type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
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
