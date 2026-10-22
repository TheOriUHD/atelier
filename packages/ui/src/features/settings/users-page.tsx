import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, Plus, Ticket, Trash2, UserCheck, UserX } from 'lucide-react';
import { z } from 'zod';
import { Username, type InviteSummary, type SafeguardsOverride, type UserSummary } from '@atelier/protocol';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  TextField,
  toast,
  type SelectOption,
} from '../../components/ui/index.ts';
import { relativeTime, shortDate } from '../../lib/dates.ts';
import { desktop } from '../../lib/platform.ts';
import { keys, useAccount } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from '../auth/form.ts';
import { CopyButton } from '../chat/copy-button.tsx';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { useSetting } from './use-setting.ts';

type Role = 'admin' | 'user';

const ROLES: SelectOption<Role>[] = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Admin' },
];

/** Runs an admin action on users; failures (such as removing the last admin) are toasted with the backend's message. */
function useUserAction() {
  const qc = useQueryClient();
  return async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await call();
    } catch (e) {
      toast.error(describeError(e).message);
      return undefined;
    } finally {
      void qc.invalidateQueries({ queryKey: keys.users });
    }
  };
}

export function UsersPage() {
  const { account } = useAccount();
  const { data: users } = useQuery({ queryKey: keys.users, queryFn: () => rpc().call('users.list', {}), staleTime: 0 });
  const addUser = useDialog();
  const entry = settingEntry('users.list');
  // Each person's override of Admin › Capabilities › Content safeguards; "Default" follows that switch.
  const everyone = useSetting<boolean>(['safeguards', 'enabled']).value;
  const safeguards: SelectOption<SafeguardsOverride>[] = [
    { value: 'inherit', label: `Default (${everyone ? 'on' : 'off'})` },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' },
  ];
  return (
    <>
      <SettingsSection
        id="users.list"
        title={entry.label}
        description={entry.description}
        action={
          <Button size="sm" variant="primary" leadingIcon={Plus} onClick={addUser.show}>
            Add user
          </Button>
        }
      >
        <DataTable
          label={entry.label}
          columns={[
            { label: 'Name' },
            { label: 'Role', className: 'w-28' },
            { label: 'Safeguards', className: 'w-36' },
            { label: 'Status', className: 'w-44' },
            { label: 'Last active', className: 'w-32' },
            { label: 'Actions', hidden: true, className: 'w-10' },
          ]}
        >
          {users
            ?.filter((u) => u.role !== 'pending')
            .map((u) => <UserRow key={u.id} user={u} self={u.id === account?.id} safeguards={safeguards} />)}
        </DataTable>
      </SettingsSection>
      <PendingSection users={users?.filter((u) => u.role === 'pending')} />
      <InvitesSection />
      <AddUserDialog key={addUser.key} open={addUser.open} onOpenChange={addUser.onOpenChange} />
    </>
  );
}

function StatusBadge({ user }: { user: UserSummary }) {
  if (user.disabled) return <Badge tone="danger">Disabled</Badge>;
  if (user.mustChangePassword) return <Badge tone="warning">Temporary password</Badge>;
  return <Badge tone="success">Active</Badge>;
}

function UserRow({ user, self, safeguards }: { user: UserSummary; self: boolean; safeguards: SelectOption<SafeguardsOverride>[] }) {
  const act = useUserAction();
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <TableRow>
      <Cell>
        <span className="flex items-center gap-2">
          <span className="truncate text-fg">{user.name}</span>
          {self && <Badge>You</Badge>}
        </span>
        <span className="block truncate text-footnote text-fg-muted">{user.username}</span>
      </Cell>
      <Cell>
        <Select
          aria-label={`Role of ${user.name}`}
          className="-ml-2"
          // Admins can't demote themselves here: that would lock them out of this page.
          disabled={self}
          options={ROLES}
          value={user.role as Role}
          onValueChange={(role) => void act(() => rpc().call('users.update', { id: user.id, role }))}
        />
      </Cell>
      <Cell>
        <Select
          aria-label={`Safeguards for ${user.name}`}
          className="-ml-2"
          options={safeguards}
          value={user.safeguards}
          onValueChange={(value) => void act(() => rpc().call('users.update', { id: user.id, safeguards: value }))}
        />
      </Cell>
      <Cell>
        <StatusBadge user={user} />
      </Cell>
      <Cell>{user.lastActiveAt ? relativeTime(user.lastActiveAt) : 'Never'}</Cell>
      <Cell className="text-right">
        {!self && (
          <Menu>
            <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${user.name} options`} size="sm" />} />
            <MenuContent align="end">
              <MenuItem icon={KeyRound} onClick={() => setConfirm('reset')}>
                Reset password…
              </MenuItem>
              <MenuItem
                icon={user.disabled ? UserCheck : UserX}
                onClick={() => void act(() => rpc().call('users.update', { id: user.id, disabled: !user.disabled }))}
              >
                {user.disabled ? 'Enable' : 'Disable'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={Trash2} danger onClick={() => setConfirm('delete')}>
                Delete…
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        <ConfirmDialog
          open={confirm === 'reset'}
          onOpenChange={(open) => !open && setConfirm(null)}
          title={`Reset ${user.name}’s password?`}
          description="They are signed out everywhere. You get a temporary password to give them, and they choose a new one when they sign in with it."
          confirmLabel="Reset password"
          onConfirm={async () => {
            const result = await act(() => rpc().call('users.resetPassword', { id: user.id }));
            if (!result) return;
            setPassword(result.temporaryPassword);
            setShowPassword(true);
          }}
        />
        <ConfirmDialog
          open={confirm === 'delete'}
          onOpenChange={(open) => !open && setConfirm(null)}
          title={`Delete ${user.name}?`}
          description={`${user.name}’s chats, projects and files are deleted with the account. This can’t be undone.`}
          onConfirm={() => act(() => rpc().call('users.delete', { id: user.id })).then(() => undefined)}
        />
        <Dialog open={showPassword} onOpenChange={setShowPassword}>
          <DialogContent title="Temporary password">
            {password && <TemporaryPassword user={user} password={password} />}
            <DialogFooter>
              <Button variant="primary" onClick={() => setShowPassword(false)}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Cell>
    </TableRow>
  );
}

/** Shown once, right after it was created; the backend never returns it again. */
function TemporaryPassword({ user, password }: { user: UserSummary; password: string }) {
  return (
    <div className="flex flex-col gap-3 text-left">
      <p className="text-body text-fg-secondary">
        Give this to {user.name} privately. They sign in as <span className="font-mono text-fg">{user.username}</span> and choose
        their own password. It won’t be shown again.
      </p>
      <div className="flex items-center gap-2">
        <TextField readOnly aria-label="Temporary password" value={password} className="font-mono" onFocus={(e) => e.target.select()} />
        <CopyButton text={password} size="md" label="Copy password" />
      </div>
    </div>
  );
}

const NewUser = z.object({
  username: Username,
  name: z.string().trim().min(1, 'Enter their name.').max(80),
  role: z.enum(['admin', 'user']),
});

function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<{ username: string; name: string; role: Role }>({ username: '', name: '', role: 'user' });
  const [created, setCreated] = useState<{ user: UserSummary; temporaryPassword: string } | null>(null);
  const form = useFormSubmit(NewUser, { exists: 'username' }, async (v) => {
    setCreated(await rpc().call('users.create', v));
    void qc.invalidateQueries({ queryKey: keys.users });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={created ? `${created.user.name} can sign in now` : 'Add user'}>
        {created ? (
          <>
            <TemporaryPassword user={created.user} password={created.temporaryPassword} />
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form noValidate onSubmit={form.onSubmit(values)} className="flex flex-col gap-4">
            <Field label="Full name" error={form.errors.name}>
              <TextField autoFocus value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} />
            </Field>
            <Field label="Username" description="What they sign in with." error={form.errors.username}>
              <TextField
                autoCapitalize="none"
                spellCheck={false}
                value={values.username}
                onChange={(e) => setValues((v) => ({ ...v, username: e.target.value }))}
              />
            </Field>
            <Field label="Role" error={form.errors.role}>
              <Select variant="field" options={ROLES} value={values.role} onValueChange={(role) => setValues((v) => ({ ...v, role }))} />
            </Field>
            {form.errors.form && (
              <p role="alert" className="text-footnote text-danger-text">
                {form.errors.form}
              </p>
            )}
            <DialogFooter className="mt-2">
              <Button onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={form.pending}>
                Add user
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PendingSection({ users }: { users: UserSummary[] | undefined }) {
  const act = useUserAction();
  const entry = settingEntry('users.pending');
  return (
    <SettingsSection id="users.pending" title={entry.label} description={entry.description}>
      {users?.length === 0 && <p className="pb-3 text-body text-fg-muted">Nobody is waiting.</p>}
      {users?.map((u) => (
        <div key={u.id} className="flex min-h-14 items-center gap-3 border-b border-line-subtle py-3 last:border-b-0">
          <div className="min-w-0 flex-1">
            <p className="truncate text-body text-fg">
              {u.name} <span className="text-fg-muted">· {u.username}</span>
            </p>
            <p className="text-footnote text-fg-muted">Signed up {relativeTime(u.createdAt)}</p>
          </div>
          <Button size="sm" aria-label={`Reject ${u.name}`} onClick={() => void act(() => rpc().call('users.delete', { id: u.id }))}>
            Reject
          </Button>
          <Button
            size="sm"
            variant="primary"
            aria-label={`Approve ${u.name}`}
            onClick={() => void act(() => rpc().call('users.update', { id: u.id, role: 'user' }))}
          >
            Approve
          </Button>
        </div>
      ))}
    </SettingsSection>
  );
}

const isOpen = (invite: InviteSummary, now = Date.now()) => !invite.usedAt && invite.expiresAt > now;

/** Only the last group of a code is kept, so admins can tell codes apart; links made before codes have none. */
const maskedCode = (invite: InviteSummary) => (invite.hint ? `••••-••••-••••-${invite.hint}` : 'Invite link');

/** Where the person signs in: this page's address in a browser, the server's in the desktop app. */
function serverAddress(serverUrl: string | null): string {
  return serverUrl ? serverUrl.replace(/\/+$/, '') : `${location.origin}${location.pathname.replace(/\/+$/, '')}`;
}

function InvitesSection() {
  const qc = useQueryClient();
  const { data: invites } = useQuery({ queryKey: keys.invites, queryFn: () => rpc().call('invites.list', {}), staleTime: 0 });
  const dialog = useDialog();
  const entry = settingEntry('users.invites');
  const open = invites?.filter((i) => isOpen(i));
  const revoke = async (id: string) => {
    try {
      await rpc().call('invites.revoke', { id });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    void qc.invalidateQueries({ queryKey: keys.invites });
  };
  return (
    <SettingsSection
      id="users.invites"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" leadingIcon={Ticket} onClick={dialog.show}>
          Create invite code
        </Button>
      }
    >
      {open?.length === 0 && <p className="pb-3 text-body text-fg-muted">No open invite codes.</p>}
      {!!open?.length && (
        <DataTable
          label="Open invite codes"
          columns={[
            { label: 'Code' },
            { label: 'Role', className: 'w-24' },
            { label: 'Created', className: 'w-36' },
            { label: 'Expires', className: 'w-36' },
            { label: 'Actions', hidden: true, className: 'w-20' },
          ]}
        >
          {open.map((i) => (
            <TableRow key={i.id}>
              <Cell className={i.hint ? 'font-mono text-fg' : 'text-fg'}>{maskedCode(i)}</Cell>
              <Cell>{i.role === 'admin' ? 'Admin' : 'User'}</Cell>
              <Cell>{shortDate(i.createdAt)}</Cell>
              <Cell>{relativeTime(i.expiresAt)}</Cell>
              <Cell className="text-right">
                <Button size="sm" variant="ghost" aria-label={`Revoke ${maskedCode(i)}`} onClick={() => void revoke(i.id)}>
                  Revoke
                </Button>
              </Cell>
            </TableRow>
          ))}
        </DataTable>
      )}
      <InviteDialog key={dialog.key} open={dialog.open} onOpenChange={dialog.onOpenChange} />
    </SettingsSection>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const [role, setRole] = useState<Role>('user');
  const [code, setCode] = useState<string | null>(null);
  const { data: connection } = useQuery({ queryKey: ['connection'], queryFn: () => desktop!.connection.get(), enabled: !!desktop });
  const form = useFormSubmit(z.object({ role: z.enum(['admin', 'user']) }), {}, async (v) => {
    setCode((await rpc().call('invites.create', v)).code);
    void qc.invalidateQueries({ queryKey: keys.invites });
  });
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Invite code">
        {connection?.mode === 'local' ? (
          <>
            <p className="text-body text-fg-secondary">
              Invite codes need an Atelier server. This app runs its own backend, which nobody else can reach. Connect the app to a server
              to invite people, or add them with Add user to share this computer.
            </p>
            <DialogFooter>
              <Button variant="primary" onClick={close}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : code ? (
          <>
            <p className="text-body text-fg-secondary">
              Give this code to the person you invite. On the sign-in screen of{' '}
              <span className="font-mono text-fg">{serverAddress(connection?.serverUrl ?? null)}</span> they choose I have a code and create
              one {role === 'admin' ? 'admin' : 'user'} account. It works once, for 7 days, and is shown only now.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <TextField readOnly aria-label="Invite code" value={code} className="font-mono" onFocus={(e) => e.target.select()} />
              <CopyButton text={code} size="md" label="Copy code" />
            </div>
            <DialogFooter>
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form noValidate onSubmit={form.onSubmit({ role })} className="flex flex-col gap-4">
            <Field label="Role" description="The account the code creates gets this role.">
              <Select variant="field" options={ROLES} value={role} onValueChange={setRole} />
            </Field>
            {form.errors.form && (
              <p role="alert" className="text-footnote text-danger-text">
                {form.errors.form}
              </p>
            )}
            <DialogFooter className="mt-2">
              <Button onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" loading={form.pending}>
                Create code
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
