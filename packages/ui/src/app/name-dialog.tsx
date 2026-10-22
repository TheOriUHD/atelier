import { useState } from 'react';
import { Button, Dialog, DialogContent, DialogFooter, TextField, toast } from '../components/ui/index.ts';
import { describeError } from '../lib/rpc.ts';

/** A dialog that asks for one name (a new group, a group's new name) and hands it to `onSubmit`. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  confirm,
  initial = '',
  onSubmit,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  label: string;
  confirm: string;
  initial?: string;
  onSubmit(name: string): Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const next = name.trim();
    if (!next) return;
    if (next === initial) return onOpenChange(false);
    setSaving(true);
    try {
      await onSubmit(next);
      onOpenChange(false);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setName(initial);
        onOpenChange(next);
      }}
    >
      <DialogContent title={title}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField aria-label={label} value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
