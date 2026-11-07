/**
 * "Join a co-op session…" (the sidebar's More, the command palette): for where an `atelier://join` link doesn't open the
 * app (a Linux AppImage registers no scheme), the person pastes the invite and lands on the join card.
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { inviteFragment, parseInviteFragment } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Field, TextField } from '../../components/ui/index.ts';

/** The fragment of a pasted invite (the https or atelier:// link, or the bare `v1.…`), or null when it isn't one. */
export function pastedInvite(text: string): string | null {
  const fragment = inviteFragment(text.trim());
  return parseInviteFragment(fragment) ? fragment : null;
}

export function JoinLinkDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const join = () => {
    const fragment = pastedInvite(text);
    if (!fragment) return setError('That isn’t an invite link. It looks like https://atelierhq.dev/join#v1.…');
    onOpenChange(false);
    void navigate({ to: '/join/$fragment', params: { fragment } });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setText('');
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent title="Join a co-op session" description="Paste the link someone sent you. You see whose session it is before anything connects." width={440}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            join();
          }}
        >
          <Field label="Paste the invite link" error={error}>
            <TextField
              autoFocus
              value={text}
              placeholder="https://atelierhq.dev/join#v1.…"
              spellCheck={false}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!text.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
