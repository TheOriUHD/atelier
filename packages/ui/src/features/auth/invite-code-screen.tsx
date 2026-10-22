/** "I have a code": an invite code first, then the account it creates. */
import { useState } from 'react';
import { z } from 'zod';
import { normalizeInviteCode, type UserSummary } from '@atelier/protocol';
import { Button, Field, TextField } from '../../components/ui/index.ts';
import { AuthLayout, InviteScreen, LinkButton } from './auth-screens.tsx';
import { useFormSubmit } from './form.ts';
import { checkInvite } from './sign-in.ts';

const Code = z.object({
  code: z
    .string()
    .transform((s) => normalizeInviteCode(s) ?? '')
    .refine((s) => s !== '', 'An invite code has 16 letters and digits, like A1B2-C3D4-E5F6-G7H8.'),
});

export function InviteCodeScreen({ onSignedIn, onBack }: { onSignedIn(user: UserSummary): void; onBack(): void }) {
  const [input, setInput] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const form = useFormSubmit(Code, { invalid_invite: 'code', rate_limited: 'code' }, async (v) => {
    await checkInvite(v.code);
    setCode(v.code);
  });
  const back = <LinkButton onClick={onBack}>Back to sign in</LinkButton>;

  if (code) return <InviteScreen token={code} onSignedIn={onSignedIn} footer={back} />;
  return (
    <AuthLayout title="Join with a code" subtitle="Enter the invite code an admin of this server gave you." footer={back}>
      <form noValidate onSubmit={form.onSubmit({ code: input })} className="flex flex-col gap-4">
        <Field label="Invite code" error={form.errors.code ?? form.errors.form}>
          <TextField
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="h-10 font-mono"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={form.pending}>
          Continue
        </Button>
      </form>
    </AuthLayout>
  );
}
