import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, UserRound } from 'lucide-react';
import { z } from 'zod';
import {
  CustomPersonality,
  CUSTOM_PERSONALITY_MAX,
  CUSTOM_PERSONALITY_LIMIT,
  effectiveSafeguards,
  PERSONAL_INSTRUCTIONS_MAX,
  type Personality,
  type AuthSessionSummary,
  type PasskeySummary,
  type UserPrefs,
  type UserSummary,
} from '@atelier/protocol';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Icon,
  IconButton,
  Select,
  Switch,
  TextArea,
  TextField,
  toast,
  type SelectOption,
} from '../../components/ui/index.ts';
import { relativeTime, shortDate } from '../../lib/dates.ts';
import { blobUrl, desktop } from '../../lib/platform.ts';
import { keys, useAccount, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { ChangePasswordForm } from '../auth/change-password-form.tsx';
import { useFormSubmit } from '../auth/form.ts';
import { addPasskey, passkeysAvailable } from '../auth/passkeys.ts';
import { leaveSetup, logout } from '../auth/sign-in.ts';
import { isLocal } from '../auth/screen-lock.ts';
import { isImage, readBase64 } from '../chat/use-attachments.ts';
import { SAFEGUARD_CATEGORIES } from './capabilities-page.tsx';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { InstructionsField } from './instructions-field.tsx';
import { settingEntry } from './search-index.ts';
import { ScreenLockSection } from './screen-lock-section.tsx';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { useDraftText, usePref, useWrite } from './use-setting.ts';

type ResponseStyle = UserPrefs['personalization']['responseStyle'];

const STYLES: SelectOption<ResponseStyle>[] = [
  { value: 'default', label: 'Default' },
  { value: 'concise', label: 'Concise' },
  { value: 'explanatory', label: 'Explanatory' },
  { value: 'formal', label: 'Formal' },
];

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * Profile, then the account itself and its passkeys, then where it is signed in. On "Run on this computer" there is
 * no sign-in to manage (no password, sessions or devices), only the optional screen lock.
 */
export function AccountPage() {
  const { account } = useAccount();
  if (!account) return null;
  if (isLocal()) {
    return (
      <>
        <ProfileSection account={account} />
        <PersonalInstructionsSection />
        <ScreenLockSection />
        {desktop?.connection?.reset && <ChangeSetupSection />}
      </>
    );
  }
  return (
    <>
      <ProfileSection account={account} />
      <PersonalInstructionsSection />
      <RemoteControlSection />
      <AccountSection account={account} />
      {passkeysAvailable() && <PasskeysSection />}
      <SessionsSection />
      <DevicesSection />
    </>
  );
}

function RemoteControlSection() {
  const setting = usePref<boolean>(['remoteControl']);
  return <SettingsSection title="Session access"><SettingRow id="remoteControl" setting={setting}>{(label) => <Switch {...label} checked={setting.value ?? true} onCheckedChange={(value) => setting.set(value)} />}</SettingRow></SettingsSection>;
}

/** Name and photo live on the account; the reply (and `account.changed`) update the cache. */
function useUpdateAccount() {
  const qc = useQueryClient();
  return async (patch: { name?: string; avatar?: string | null }) => {
    qc.setQueryData(keys.account, await rpc().call('account.update', patch));
  };
}

function ProfileSection({ account }: { account: UserSummary }) {
  const update = useUpdateAccount();
  const nameWrite = useWrite();
  const name = useDraftText({
    value: account.name,
    set: (value) =>
      nameWrite.run(async () => {
        if (!value.trim()) throw new Error('Enter your name.');
        await update({ name: value });
      }),
  });
  const callMe = usePref<string>(['callMe']);
  const callMeDraft = useDraftText(callMe);
  const instructions = usePref<string>(['personalization', 'instructions']);
  const instructionsDraft = useDraftText(instructions);
  const style = usePref<ResponseStyle>(['personalization', 'responseStyle']);

  return (
    <SettingsSection title="Profile">
      <AvatarRow account={account} onChange={(avatar) => update({ avatar })} />
      <SettingRow id="profile.name" error={nameWrite.error}>
        {(label) => <TextField {...label} {...name} placeholder="Your name" maxLength={80} className="w-[253px]" />}
      </SettingRow>
      <SettingRow id="profile.callMe" setting={callMe}>
        {(label) => (
          <TextField {...label} {...callMeDraft} placeholder={account.name} maxLength={80} className="w-[253px]" />
        )}
      </SettingRow>
      <SettingRow id="personalization.instructions" setting={instructions} stacked>
        {(label) => (
          <TextArea
            {...label}
            {...instructionsDraft}
            rows={6}
            placeholder="For example: I work in TypeScript and prefer short answers with code first."
          />
        )}
      </SettingRow>
      <PersonalityRow />
      <SettingRow id="personalization.responseStyle" setting={style}>
        {(label) => <Select {...label} options={STYLES} value={style.value} onValueChange={(v) => void style.set(v)} />}
      </SettingRow>
      <SafeguardsRow account={account} />
    </SettingsSection>
  );
}

function PersonalityRow() {
  const setting = usePref<Personality>(['personalization', 'personality']);
  const value = setting.value ?? { selected: 'atelier', customModes: [] };
  const [editing, setEditing] = useState<CustomPersonality | null>(null);
  const selected = value.customModes.find((mode) => `custom:${mode.id}` === value.selected);
  const options: SelectOption<string>[] = [
    { value: 'atelier', label: 'Atelier — helpful and pragmatic' },
    { value: 'technical', label: 'Technical — precise and earnest' },
    { value: 'relaxed', label: 'Relaxed — casual, more emoji' },
    ...value.customModes.map((mode) => ({ value: `custom:${mode.id}`, label: mode.name })),
  ];
  return (
    <SettingRow id="personalization.personality" setting={setting} stacked>
      {(label) => (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            {...label}
            options={options}
            value={value.selected}
            onValueChange={(selected) => void setting.set({ ...value, selected })}
          />
          <Button
            size="sm"
            disabled={value.customModes.length >= CUSTOM_PERSONALITY_LIMIT}
            onClick={() => setEditing({ id: crypto.randomUUID(), name: '', instructions: '' })}
          >
            Add custom mode
          </Button>
          {selected && (
            <>
              <Button size="sm" onClick={() => setEditing(selected)}>
                Edit mode
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void setting.set({
                    selected: 'atelier',
                    customModes: value.customModes.filter((mode) => mode.id !== selected.id),
                  })
                }
              >
                Delete mode
              </Button>
            </>
          )}
          {editing && (
            <PersonalityDialog
              key={editing.id}
              mode={editing}
              onClose={() => setEditing(null)}
              onSave={async (mode) => {
                const customModes = [...value.customModes.filter((item) => item.id !== mode.id), mode];
                if (await setting.set({ selected: `custom:${mode.id}`, customModes })) setEditing(null);
              }}
            />
          )}
        </div>
      )}
    </SettingRow>
  );
}

function PersonalityDialog({
  mode,
  onClose,
  onSave,
}: {
  mode: CustomPersonality;
  onClose(): void;
  onSave(mode: CustomPersonality): Promise<void>;
}) {
  const [name, setName] = useState(mode.name);
  const [instructions, setInstructions] = useState(mode.instructions);
  const form = useFormSubmit(CustomPersonality, {}, onSave);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title={mode.name ? 'Edit custom mode' : 'Add custom mode'}
        description="Communication style only, not a different model or identity. Applies to new conversations; response style stays independent."
      >
        <form noValidate onSubmit={form.onSubmit({ id: mode.id, name, instructions })} className="flex flex-col gap-4">
          <Field label="Mode name" error={form.errors.name}>
            <TextField autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Style instructions"
            description={`Up to ${CUSTOM_PERSONALITY_MAX.toLocaleString()} characters.`}
            error={form.errors.instructions ?? form.errors.form}
          >
            <TextArea
              value={instructions}
              maxLength={CUSTOM_PERSONALITY_MAX}
              rows={6}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="For example: Be a patient tutor. Ask one guiding question at a time."
            />
          </Field>
          <DialogFooter>
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              Save mode
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The person's own ATELIER.md, kept by the backend; saved explicitly like the system AGENTS.md, since every new session reads it. */
function PersonalInstructionsSection() {
  const file = usePref<string>(['personalization', 'atelierMd']);
  return (
    <SettingsSection title="Instructions for Code and Cowork">
      <SettingRow id="personalization.atelierMd" setting={file} stacked>
        {(label) => (
          <InstructionsField
            label={label}
            saved={file.value ?? ''}
            max={PERSONAL_INSTRUCTIONS_MAX}
            monospace
            placeholder={'# How I work\n\n- Explain a plan before large changes.\n- Write commit messages in English.'}
            onSave={file.set}
          />
        )}
      </SettingRow>
    </SettingsSection>
  );
}

/** Read-only: the administrator turns safeguards on (docs/PROMPTS.md §9). Nothing shows while none apply. */
function SafeguardsRow({ account }: { account: UserSummary }) {
  const { settings } = useSettings();
  const safeguards = settings && effectiveSafeguards(settings.safeguards, account.safeguards);
  if (!safeguards) return null;
  const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
  const covers = [
    ...SAFEGUARD_CATEGORIES.filter(([key]) => safeguards.categories.includes(key)).map(([, id]) =>
      lower(settingEntry(id).label),
    ),
    ...(safeguards.younger ? ['rules for younger people'] : []),
  ];
  return (
    <SettingRow id="account.safeguards" detail={`Covers ${covers.join(', ')}.`}>
      <span className="text-body text-fg-secondary">On, set by your administrator</span>
    </SettingRow>
  );
}

/** Uploads the image to the blob store and points the account's avatar at it. */
function AvatarRow({ account, onChange }: { account: UserSummary; onChange(avatar: string | null): Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { error, run } = useWrite();

  const upload = (file: File) =>
    run(async () => {
      if (!isImage(file.type)) throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
      if (file.size > MAX_AVATAR_BYTES) throw new Error('That image is larger than 5 MB.');
      setUploading(true);
      try {
        const ref = await rpc().call('files.upload', {
          name: file.name,
          mime: file.type,
          dataBase64: await readBase64(file),
        });
        await onChange(ref.blob);
      } finally {
        setUploading(false);
      }
    });

  return (
    <SettingRow id="profile.avatar" error={error}>
      <div className="flex items-center gap-2">
        {account.avatar && (
          <Button variant="ghost" size="sm" onClick={() => void run(() => onChange(null))}>
            Remove
          </Button>
        )}
        <Button size="sm" loading={uploading} onClick={() => input.current?.click()}>
          {account.avatar ? 'Change' : 'Upload'}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          aria-label="Profile photo"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
        {account.avatar ? (
          <img src={blobUrl(account.avatar)} alt="" className="ml-2 size-16 rounded-full object-cover" />
        ) : (
          <span
            aria-hidden
            className="ml-2 flex size-16 items-center justify-center rounded-full bg-fill-primary text-title text-on-primary"
          >
            {account.name.trim().slice(0, 1).toUpperCase() || <Icon icon={UserRound} size="lg" />}
          </span>
        )}
      </div>
    </SettingRow>
  );
}

function AccountSection({ account }: { account: UserSummary }) {
  const qc = useQueryClient();
  const [changingPassword, setChangingPassword] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  return (
    <SettingsSection title="Account">
      <SettingRow id="account.username">
        <span className="font-mono text-body text-fg-secondary">{account.username}</span>
      </SettingRow>
      <SettingRow id="account.password">
        <Button onClick={() => setChangingPassword(true)}>Change password</Button>
      </SettingRow>
      <SignOutRows />
      <SettingRow id="account.logoutEverywhere">
        <Button onClick={() => setLoggingOut(true)}>Log out everywhere</Button>
      </SettingRow>
      <Dialog open={changingPassword} onOpenChange={setChangingPassword}>
        <DialogContent
          title="Change password"
          description="You stay signed in here. Everywhere else you are signed out."
        >
          <ChangePasswordForm
            onDone={() => {
              setChangingPassword(false);
              toast.success('Password changed.');
              void qc.invalidateQueries({ queryKey: keys.authSessions });
            }}
            actions={(pending) => (
              <DialogFooter className="mt-2">
                <Button onClick={() => setChangingPassword(false)}>Cancel</Button>
                <Button type="submit" variant="primary" loading={pending}>
                  Change password
                </Button>
              </DialogFooter>
            )}
          />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={loggingOut}
        onOpenChange={setLoggingOut}
        title="Log out of all devices?"
        description="Every browser and app signed in to your account is signed out, including this one."
        confirmLabel="Log out everywhere"
        onConfirm={async () => {
          try {
            // The backend then signs this connection out too, which shows the sign-in screen.
            await rpc().call('account.logoutEverywhere', {});
          } catch (e) {
            toast.error(describeError(e).message);
          }
        }}
      />
    </SettingsSection>
  );
}

/** "Log out" for everyone; the desktop app then goes back to its first-run choice, a browser to its server's sign-in. */
function SignOutRows() {
  const canLeave = !!desktop?.connection?.reset;
  const [switching, setSwitching] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { data: connection } = useQuery({
    queryKey: ['desktop', 'connection'],
    queryFn: () => desktop!.connection.get(),
    enabled: canLeave,
  });
  const server = connection?.serverUrl ?? 'the server';
  const signOut = async () => {
    setSigningOut(true);
    try {
      await (canLeave ? leaveSetup() : logout());
    } catch (e) {
      toast.error(describeError(e).message);
      setSigningOut(false);
    }
  };
  return (
    <>
      <SettingRow
        id="account.signOut"
        detail={canLeave ? 'Then Atelier asks again whether to use a server or this computer.' : undefined}
      >
        <Button loading={signingOut} onClick={() => void signOut()}>
          Log out
        </Button>
      </SettingRow>
      {canLeave && (
        <SettingRow id="account.server" detail={connection?.serverUrl ?? undefined}>
          <Button onClick={() => setSwitching(true)}>Switch…</Button>
        </SettingRow>
      )}
      <ConfirmDialog
        open={switching}
        onOpenChange={setSwitching}
        title="Switch to this computer or another server?"
        description={`This app logs out of ${server}. Your chats stay on the server.`}
        confirmLabel="Log out and switch"
        onConfirm={async () => {
          try {
            await leaveSetup();
          } catch (e) {
            toast.error(describeError(e).message);
          }
        }}
      />
    </>
  );
}

/** "Run on this computer": back to the first-run choice without deleting anything. */
function ChangeSetupSection() {
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsSection title="Setup">
      <SettingRow id="account.changeSetup">
        <Button onClick={() => setConfirming(true)}>Change setup…</Button>
      </SettingRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Change setup?"
        description="Your chats on this computer stay; choose “Run on this computer” again to get back to them."
        confirmLabel="Change setup"
        onConfirm={async () => {
          try {
            await leaveSetup();
          } catch (e) {
            toast.error(describeError(e).message);
          }
        }}
      />
    </SettingsSection>
  );
}

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh|darwin/, 'macOS'],
  [/Windows|win32/, 'Windows'],
  [/Linux|linux/, 'Linux'],
];
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const first = (ua: string, list: [RegExp, string][]) => list.find(([re]) => re.test(ua))?.[1];

/** "Chrome on macOS", "Atelier Desktop on Windows". */
function clientName(session: Pick<AuthSessionSummary, 'clientKind' | 'userAgent'>): string {
  const app = session.clientKind === 'desktop' ? 'Atelier Desktop' : (first(session.userAgent, BROWSERS) ?? 'Browser');
  const os = first(session.userAgent, SYSTEMS);
  return os ? `${app} on ${os}` : app;
}

const PLATFORMS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function SessionsSection() {
  const qc = useQueryClient();
  const { data: sessions } = useQuery({
    queryKey: keys.authSessions,
    queryFn: () => rpc().call('account.sessions', {}),
    staleTime: 0,
  });
  const entry = settingEntry('account.sessions');
  const revoke = async (id: string) => {
    try {
      await rpc().call('account.revokeSession', { id });
      await qc.invalidateQueries({ queryKey: keys.authSessions });
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };
  return (
    <SettingsSection id="account.sessions" title={entry.label} description={entry.description}>
      <DataTable
        label={entry.label}
        columns={[
          { label: 'Device' },
          { label: 'IP address', className: 'w-36' },
          { label: 'Created', className: 'w-28' },
          { label: 'Last seen', className: 'w-32' },
          { label: 'Actions', hidden: true, className: 'w-20' },
        ]}
      >
        {sessions?.map((s) => (
          <TableRow key={s.id}>
            <Cell title={s.userAgent}>
              <span className="flex items-center gap-2">
                <span className="truncate text-fg">{clientName(s)}</span>
                {s.current && <Badge tone="accent">Current</Badge>}
              </span>
            </Cell>
            <Cell className="truncate">{s.ip || '—'}</Cell>
            <Cell>{shortDate(s.createdAt)}</Cell>
            <Cell>{relativeTime(s.lastSeenAt)}</Cell>
            <Cell className="text-right">
              {!s.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Revoke ${clientName(s)} session`}
                  onClick={() => void revoke(s.id)}
                >
                  Revoke
                </Button>
              )}
            </Cell>
          </TableRow>
        ))}
      </DataTable>
    </SettingsSection>
  );
}

function DevicesSection() {
  const qc = useQueryClient();
  const { data: devices } = useQuery({
    queryKey: keys.devices,
    queryFn: () => rpc().call('account.devices', {}),
    staleTime: 0,
  });
  const entry = settingEntry('account.devices');
  const remove = async (id: string) => {
    try {
      await rpc().call('account.removeDevice', { id });
      await qc.invalidateQueries({ queryKey: keys.devices });
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };
  return (
    <SettingsSection id="account.devices" title={entry.label} description={entry.description}>
      {devices?.length === 0 ? (
        <p className="pb-3 text-body text-fg-muted">
          No devices yet. The Atelier desktop app adds the computer it runs on when you sign in there.
        </p>
      ) : (
        <DataTable
          label={entry.label}
          columns={[
            { label: 'Name' },
            { label: 'Platform', className: 'w-28' },
            { label: 'Added', className: 'w-28' },
            { label: 'Last seen', className: 'w-32' },
            { label: 'Actions', hidden: true, className: 'w-12' },
          ]}
        >
          {devices?.map((d) => (
            <TableRow key={d.id}>
              <Cell>
                <span className="flex items-center gap-2">
                  <span className="truncate text-fg">{d.name}</span>
                  {d.current && <Badge tone="accent">This computer</Badge>}
                </span>
              </Cell>
              <Cell>{PLATFORMS[d.platform] ?? d.platform}</Cell>
              <Cell>{shortDate(d.createdAt)}</Cell>
              <Cell>
                {d.online ? (
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="size-1.5 rounded-full bg-success" />
                    Online
                  </span>
                ) : (
                  relativeTime(d.lastSeenAt)
                )}
              </Cell>
              <Cell className="text-right">
                {!d.current && (
                  <IconButton icon={Trash2} label={`Remove ${d.name}`} size="sm" onClick={() => void remove(d.id)} />
                )}
              </Cell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </SettingsSection>
  );
}

/** Web only: a passkey is made by the browser's WebAuthn prompt; the backend lists and removes them. */
function PasskeysSection() {
  const entry = settingEntry('account.passkeys');
  const { data: passkeys } = useQuery({
    queryKey: keys.passkeys,
    queryFn: () => rpc().call('account.passkeys', {}),
    staleTime: 0,
  });
  const adding = useDialog();
  return (
    <SettingsSection
      id="account.passkeys"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" leadingIcon={Plus} onClick={adding.show}>
          Add passkey
        </Button>
      }
    >
      {passkeys?.length === 0 ? (
        <p className="pb-3 text-body text-fg-muted">No passkeys yet.</p>
      ) : (
        <DataTable
          label={entry.label}
          columns={[
            { label: 'Name' },
            { label: 'Added', className: 'w-28' },
            { label: 'Last used', className: 'w-32' },
            { label: 'Actions', hidden: true, className: 'w-12' },
          ]}
        >
          {passkeys?.map((p) => (
            <PasskeyRow key={p.id} passkey={p} />
          ))}
        </DataTable>
      )}
      <AddPasskeyDialog key={adding.key} open={adding.open} onOpenChange={adding.onOpenChange} />
    </SettingsSection>
  );
}

function PasskeyRow({ passkey }: { passkey: PasskeySummary }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    try {
      await rpc().call('account.removePasskey', { id: passkey.id });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await qc.invalidateQueries({ queryKey: keys.passkeys });
  };
  return (
    <TableRow>
      <Cell className="truncate text-fg">{passkey.name}</Cell>
      <Cell>{shortDate(passkey.createdAt)}</Cell>
      <Cell>{passkey.lastUsedAt ? relativeTime(passkey.lastUsedAt) : 'Never'}</Cell>
      <Cell className="text-right">
        <IconButton icon={Trash2} label={`Remove ${passkey.name}`} size="sm" onClick={() => setConfirm(true)} />
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Remove “${passkey.name}”?`}
          description="It no longer signs you in here. Delete it from your device or password manager too."
          confirmLabel="Remove"
          onConfirm={remove}
        />
      </Cell>
    </TableRow>
  );
}

const PasskeyName = z.object({
  name: z.string().trim().min(1, 'Name it, so you can tell your passkeys apart.').max(80),
});

function AddPasskeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(() => clientName({ clientKind: 'web', userAgent: navigator.userAgent }));
  const form = useFormSubmit(PasskeyName, {}, async (v) => {
    await addPasskey(v.name);
    await qc.invalidateQueries({ queryKey: keys.passkeys });
    toast.success('Passkey added. Use it on the sign-in page.');
    onOpenChange(false);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a passkey"
        description="Your browser then asks where to keep it: on this device, in your password manager or on a security key."
      >
        <form noValidate onSubmit={form.onSubmit({ name })} className="flex flex-col gap-4">
          <Field
            label="Name"
            description="So you can tell your passkeys apart."
            error={form.errors.name ?? form.errors.form}
          >
            <TextField autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
