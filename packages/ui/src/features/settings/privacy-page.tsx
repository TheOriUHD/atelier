import { useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogFooter, Field, Select, TextField, toast, type SelectOption } from '../../components/ui/index.ts';
import { useMode } from '../../app/navigation.ts';
import { saveBlob } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { usePref, useWrite } from './use-setting.ts';

const FOREVER = 'forever';
const RETENTION: SelectOption[] = [
  { value: FOREVER, label: 'Keep everything' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '365 days' },
];
const TEMPORARY: SelectOption[] = [
  { value: 'private', label: 'Don’t save (default)' },
  { value: 'fresh', label: 'Start fresh: also ignore memory and personal instructions' },
];

/** What Atelier keeps of the person's conversations, a copy of everything, and deleting it all. */
export function PrivacyPage() {
  const retention = usePref<number | null>(['privacy', 'historyRetentionDays']);
  const value = retention.value === null ? FOREVER : String(retention.value);
  // A period set some other way is still shown as it is.
  const options = RETENTION.some((o) => o.value === value) ? RETENTION : [...RETENTION, { value, label: `${value} days` }];
  const temporary = usePref<'private' | 'fresh'>(['privacy', 'temporaryChats']);
  return (
    <>
      <SettingsSection title="History">
        <SettingRow id="privacy.retention" setting={retention}>
          {(label) => (
            <Select {...label} options={options} value={value} onValueChange={(v) => void retention.set(v === FOREVER ? null : Number(v))} />
          )}
        </SettingRow>
        <SettingRow id="privacy.temporaryChats" setting={temporary}>
          {(label) => (
            <Select {...label} options={TEMPORARY} value={temporary.value ?? 'private'} onValueChange={(v) => void temporary.set(v as 'private' | 'fresh')} />
          )}
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Your data">
        <ExportRow />
        <DeleteAllRow />
      </SettingsSection>
    </>
  );
}

/** Builds the zip on the backend, then saves it from the blob store under its name. */
function ExportRow() {
  const [pending, setPending] = useState(false);
  const { error, run } = useWrite();
  const exportAll = () =>
    run(async () => {
      setPending(true);
      try {
        const { sha256, name } = await rpc().call('privacy.export', {});
        await saveBlob(sha256, name);
      } finally {
        setPending(false);
      }
    });
  return (
    <SettingRow id="privacy.export" error={error}>
      <Button leadingIcon={Download} loading={pending} onClick={() => void exportAll()}>
        Export
      </Button>
    </SettingRow>
  );
}

function DeleteAllRow() {
  const dialog = useDialog();
  return (
    <SettingRow id="privacy.deleteConversations">
      <Button onClick={dialog.show}>Delete all…</Button>
      <DeleteAllDialog key={dialog.key} open={dialog.open} onOpenChange={dialog.onOpenChange} />
    </SettingRow>
  );
}

const CONFIRMATION = 'DELETE';

/** Typing DELETE arms the button, so nobody wipes their history by pressing Enter on a dialog. */
function DeleteAllDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const navigate = useNavigate();
  const { sessionId } = useParams({ strict: false });
  const mode = useMode();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const { error, run } = useWrite();
  const armed = typed.trim() === CONFIRMATION;

  const deleteAll = () =>
    run(async () => {
      setPending(true);
      try {
        const { deleted } = await rpc().call('privacy.deleteConversations', {});
        onOpenChange(false);
        toast.success(deleted === 1 ? 'Deleted 1 conversation.' : `Deleted ${deleted} conversations.`);
        // The open conversation is gone too: show its mode's start page under Settings.
        if (sessionId) void navigate({ to: mode === 'code' ? '/code' : '/', search: (prev) => prev });
      } finally {
        setPending(false);
      }
    });

  return (
    <Dialog open={open} onOpenChange={(next) => pending || onOpenChange(next)}>
      <DialogContent
        title="Delete all conversations?"
        description="Every chat, Cowork task and Code session is deleted with its messages, files and artifacts. Projects stay, without their chats. This can’t be undone."
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (armed) void deleteAll();
          }}
          className="flex flex-col gap-4"
        >
          <Field label={`Type ${CONFIRMATION} to confirm`} error={error}>
            <TextField autoFocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" />
          </Field>
          <DialogFooter className="mt-2">
            <Button disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!armed} loading={pending}>
              Delete all conversations
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
