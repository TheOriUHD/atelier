/**
 * The Co-op button in every session header and its popover (design/components.md › Co-op). Off, it starts co-op: an
 * invite link on a desktop (through the relay), teammates on a server. On, the host decides who is in, what they may do
 * and whether guests may use the host's models; a guest sees who is in, chooses whose models answer them and may leave.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, Link2, MoreHorizontal, UserPlus, Users } from 'lucide-react';
import { participantUserId, type CoopSettings, type CoopState, type ModelsChoice, type Participant, type SessionSummary } from '@atelier/protocol';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  Switch,
  cn,
  toast,
} from '../../components/ui/index.ts';
import { popupScrollClass } from '../../components/ui/styles.ts';
import { MODE_HOME } from '../../app/navigation.ts';
import { useAppInfo, useModels } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { ModelMenu } from '../chat/model-picker.tsx';
import { Avatar, AvatarStack } from './avatar.tsx';
import { Tracks } from './coop-tracks.tsx';
import { expiresIn, possessive, reportError, sharedUseLine, useCoopActions, useCoopView, useNow, type CoopView } from './coop.ts';

const fail = (e: unknown): void => void toast.error(describeError(e).message);

const ROLE_LABEL = { host: 'Host', editor: 'Can chat', viewer: 'Can watch' } as const;
const ROLE_OPTIONS = [
  { value: 'editor' as const, label: ROLE_LABEL.editor },
  { value: 'viewer' as const, label: ROLE_LABEL.viewer },
];

/** Room for four people in all: the host and three others. */
const MAX_OTHERS = 3;

/** The header's Co-op button: two people while it's off, the people's avatars with their online dots while it's on. */
export function CoopButton({ session, className }: { session: SessionSummary; className?: string }) {
  const coop = useCoopView();
  const [open, setOpen] = useState(false);
  const knocking = coop.isHost ? (coop.state?.knocking ?? []) : [];
  useKnockToasts(knocking, setOpen);
  if (session.temporary) return null;

  const on = coop.shared && coop.people.length > 0;
  const label = knocking[0]
    ? `Co-op: ${knocking[0].name} wants to join`
    : on
      ? `Co-op: ${coop.people.map((p) => (p.id === coop.me ? 'you' : p.name)).join(', ')}`
      : 'Co-op';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {on ? (
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={label}
              className={cn(
                'app-no-drag relative flex h-7 shrink-0 items-center rounded-md px-1.5 outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover',
                className,
              )}
            />
          }
        >
          <AvatarStack people={coop.people} />
          {knocking.length > 0 && <span aria-hidden className="absolute top-0.5 right-0.5 size-2 rounded-full bg-warning ring-2 ring-bg" />}
        </PopoverTrigger>
      ) : (
        <PopoverTrigger render={<IconButton icon={Users} label={label} size="sm" className={cn('app-no-drag text-fg-secondary', className)} />} />
      )}
      <PopoverContent align="end" aria-label="Co-op" className={cn('flex w-[min(344px,calc(100vw-32px))] flex-col gap-4 p-3.5', popupScrollClass)}>
        {!coop.shared ? <StartPanel session={session} /> : coop.isHost ? <HostPanel session={session} coop={coop} /> : <GuestPanel session={session} coop={coop} />}
      </PopoverContent>
    </Popover>
  );
}

/** A knock is easy to miss with the popover closed: a toast says who, with the fingerprint, and opens it. */
function useKnockToasts(knocking: CoopState['knocking'], open: (open: boolean) => void) {
  const told = useRef(new Set<string>());
  useEffect(() => {
    for (const knock of knocking) {
      if (told.current.has(knock.id)) continue;
      told.current.add(knock.id);
      toast(`${knock.name} wants to join`, {
        id: `coop-knock:${knock.id}`,
        description: knock.fingerprint.join(' '),
        duration: 15_000,
        action: { label: 'Review', onClick: () => open(true) },
      });
    }
  }, [knocking, open]);
}

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-body-strong text-fg">{children}</h2>
      {meta && <span className="min-w-0 truncate text-footnote text-fg-muted">{meta}</span>}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-footnote text-fg-muted">{children}</h3>;
}

/** Co-op is off: start it. A desktop opens a room on the relay; a server adds teammates. */
function StartPanel({ session }: { session: SessionSummary }) {
  const { data: info } = useAppInfo();
  const server = info?.surface === 'web';
  const actions = useCoopActions(session.id);
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Heading>Co-op</Heading>
      {/* Whether co-op goes through teammates or a link depends on this backend: wait for it to say which. */}
      <p className="text-body text-fg-secondary">
        {!info
          ? 'Work on this session with up to three others.'
          : server
            ? 'Work on this session with up to three teammates on this server. It stays yours, and anything risky asks you.'
            : 'Work on this session with up to three friends. It keeps running on this computer, and anything risky asks you.'}
      </p>
      {picking ? (
        <TeammatePicker sessionId={session.id} taken={[]} room={MAX_OTHERS} onDone={() => setPicking(false)} />
      ) : (
        <Button
          variant="primary"
          leadingIcon={Users}
          loading={starting}
          disabled={!info}
          className="self-start"
          onClick={() => {
            if (server) return setPicking(true);
            setStarting(true);
            actions
              .start()
              .catch(fail)
              .finally(() => setStarting(false));
          }}
        >
          Start co-op
        </Button>
      )}
    </>
  );
}

/** Teammates on this server, to add with one part for all of them. */
function TeammatePicker({ sessionId, taken, room, onDone }: { sessionId: string; taken: readonly string[]; room: number; onDone(): void }) {
  const actions = useCoopActions(sessionId);
  const directory = useQuery({ queryKey: ['coop', 'directory'], queryFn: () => rpc().call('coop.directory', {}) });
  const [picked, setPicked] = useState<string[]>([]);
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [adding, setAdding] = useState(false);
  const people = (directory.data ?? []).filter((p) => !taken.includes(p.userId));
  const full = picked.length >= room;
  return (
    <div className="flex flex-col gap-3">
      {directory.isLoading ? (
        <p className="text-body text-fg-muted">Loading teammates…</p>
      ) : people.length === 0 ? (
        <p className="text-body text-fg-muted">Nobody else on this server can join yet.</p>
      ) : (
        <ul aria-label="Teammates" className="-mx-1.5 flex max-h-56 flex-col overflow-y-auto">
          {people.map((p) => {
            const checked = picked.includes(p.userId);
            return (
              <li key={p.userId} className={cn('flex h-9 items-center gap-2.5 rounded-lg px-1.5', !checked && full && 'opacity-40')}>
                <Checkbox
                  checked={checked}
                  disabled={!checked && full}
                  onCheckedChange={(on) => setPicked((list) => (on ? [...list, p.userId] : list.filter((id) => id !== p.userId)))}
                  aria-label={p.name}
                />
                <Avatar name={p.name} avatar={p.avatar} />
                <span aria-hidden className="min-w-0 flex-1 truncate text-body text-fg">
                  {p.name}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {full && <p className="text-footnote text-fg-muted">A co-op session has room for four people in all.</p>}
      <div className="flex items-center justify-between gap-2">
        <Select aria-label="What they can do" options={ROLE_OPTIONS} value={role} onValueChange={setRole} />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={picked.length === 0}
            loading={adding}
            onClick={() => {
              setAdding(true);
              actions
                .add(picked, role)
                .then(onDone)
                .catch(fail)
                .finally(() => setAdding(false));
            }}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Where the session runs, as the popover's heading says it. */
function whereItRuns(coop: CoopView): string {
  const relay = coop.state?.via !== 'server';
  if (coop.isHost) return relay ? 'Runs on this computer' : 'On this server';
  return relay ? `Runs on ${possessive(coop.hostName)} computer` : `Hosted by ${coop.hostName}`;
}

function HostPanel({ session, coop }: { session: SessionSummary; coop: CoopView }) {
  const actions = useCoopActions(session.id);
  const state = coop.state;
  const [picking, setPicking] = useState(false);
  const [ending, setEnding] = useState(false);
  const relay = state?.via !== 'server';
  const others = coop.people.filter((p) => p.role !== 'host');
  const room = MAX_OTHERS - others.length;
  return (
    <>
      <Heading meta={whereItRuns(coop)}>Co-op</Heading>
      {state?.knocking.map((knock) => <Knock key={knock.id} knock={knock} onAnswer={(allow) => actions.admit(knock.id, allow).catch(fail)} />)}
      {relay ? (
        <Invite sessionId={session.id} invite={state?.invite ?? null} full={room <= 0} />
      ) : picking ? (
        <TeammatePicker sessionId={session.id} taken={others.flatMap((p) => participantUserId(p.id) ?? [])} room={room} onDone={() => setPicking(false)} />
      ) : (
        <Button leadingIcon={UserPlus} className="self-start" disabled={room <= 0} onClick={() => setPicking(true)}>
          Invite a teammate
        </Button>
      )}
      <section aria-label="People" className="flex flex-col gap-1.5">
        <SectionLabel>People</SectionLabel>
        <ul className="flex flex-col">
          {coop.people.map((p) => (
            <PersonRow key={p.id} person={p} me={p.id === coop.me} hostControls={p.role !== 'host' ? { sessionId: session.id } : undefined} />
          ))}
        </ul>
        {others.length === 0 && <p className="text-footnote text-fg-muted">{relay ? 'Nobody has joined yet. Send the link to whoever you want to work with.' : 'Nobody else is here yet.'}</p>}
      </section>
      {state && <HostSettings settings={state.settings} onChange={(patch) => actions.settings(patch).catch(fail)} />}
      {state && <Navigator sessionId={session.id} coop={coop} />}
      {state && session.mode === 'code' && <Tracks sessionId={session.id} coop={coop} />}
      <div className="flex justify-end border-t border-line pt-3">
        <Button size="sm" variant="ghost" className="text-danger-text" onClick={() => setEnding(true)}>
          End co-op
        </Button>
      </div>
      <ConfirmDialog
        open={ending}
        onOpenChange={setEnding}
        title="End co-op?"
        description={
          others.length === 0
            ? 'The invite link stops working and the session is yours alone again.'
            : `Everyone else leaves this session${state?.settings.guestsKeepCopy ? ' and keeps a copy of the conversation' : ''}. It stays yours.`
        }
        confirmLabel="End co-op"
        onConfirm={() => actions.end().then(() => undefined, fail)}
      />
    </>
  );
}

/**
 * The invite link: anyone who has it can ask to join for 24 hours, and the host lets each one in. Copying makes one when
 * none is open; a new one replaces it (the old one stops working).
 */
function Invite({ sessionId, invite, full }: { sessionId: string; invite: { url: string; expiresAt: number } | null; full: boolean }) {
  const actions = useCoopActions(sessionId);
  const [made, setMade] = useState<{ url: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const now = useNow(60_000);
  // The backend's open link wins: it is the one still valid (a used one is gone).
  const link = invite ?? (made && made.expiresAt > now ? made : null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (fresh: boolean) => {
    setBusy(true);
    try {
      const next = !fresh && link ? link : await actions.invite();
      setMade(next);
      await navigator.clipboard.writeText(next.url);
      setCopied(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  if (full) return <p className="text-footnote text-fg-muted">The session is full: four people at most.</p>;
  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="primary" leadingIcon={copied ? Check : Link2} loading={busy} className="self-start" onClick={() => void copy(false)}>
        {copied ? 'Copied' : 'Copy invite link'}
      </Button>
      <p className="flex flex-wrap items-center gap-x-1.5 text-footnote text-fg-muted">
        <span>{link ? expiresIn(link.expiresAt, now) : 'Anyone with the link can ask to join for 24 h. You let each one in.'}</span>
        {link && (
          <>
            <span aria-hidden>·</span>
            <button type="button" disabled={busy} title="The old link stops working" onClick={() => void copy(true)} className="rounded-xs text-interactive-text outline-none focus-ring hover:underline disabled:opacity-40">
              Make a new link
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** "Ben wants to join" with the fingerprint both sides see, and Let in / Decline. */
function Knock({ knock, onAnswer }: { knock: CoopState['knocking'][number]; onAnswer(allow: boolean): Promise<unknown> }) {
  const [busy, setBusy] = useState<boolean | null>(null);
  const answer = (allow: boolean) => {
    setBusy(allow);
    void onAnswer(allow).finally(() => setBusy(null));
  };
  return (
    <section aria-label={`${knock.name} wants to join`} className="flex flex-col gap-2 rounded-xl bg-fill-ghost-hover p-3">
      <p className="text-body text-fg">
        <span className="font-medium">{knock.name}</span> wants to join
      </p>
      <p aria-label={`Fingerprint: ${knock.fingerprint.join(' ')}`} className="text-[24px]/[32px] tracking-[0.2em]">
        {knock.fingerprint.join(' ')}
      </p>
      <p className="text-footnote text-fg-muted">The same three emoji show on {possessive(knock.name)} screen. Compare them, over a call or a chat, before you let them in.</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" loading={busy === false} disabled={busy !== null} onClick={() => answer(false)}>
          Decline
        </Button>
        <Button size="sm" variant="primary" loading={busy === true} disabled={busy !== null} onClick={() => answer(true)}>
          Let in
        </Button>
      </div>
    </section>
  );
}

/** One person: avatar with online dot, name, their part. The host can change a guest's part, trust or remove them. */
function PersonRow({ person, me, hostControls }: { person: Participant; me: boolean; hostControls?: { sessionId: string } }) {
  const guest = person.role !== 'host';
  const note = !person.online ? 'Away' : guest && person.trusted ? 'Trusted with approvals' : guest && person.models === 'own' ? 'Answers with their own models' : null;
  return (
    <li className="flex min-h-9 items-center gap-2.5 py-1">
      <Avatar name={person.name} avatar={person.avatar} online={person.online} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-fg">
          {person.name}
          {me && <span className="text-fg-muted"> (you)</span>}
        </span>
        {note && <span className="truncate text-footnote text-fg-muted">{note}</span>}
      </span>
      {hostControls ? <GuestControls sessionId={hostControls.sessionId} person={person} /> : <span className="shrink-0 text-footnote text-fg-muted">{ROLE_LABEL[person.role]}</span>}
    </li>
  );
}

/** The host's say over a guest: Can chat or Can watch, Trust with approvals, Remove. */
function GuestControls({ sessionId, person }: { sessionId: string; person: Participant }) {
  const actions = useCoopActions(sessionId);
  const [removing, setRemoving] = useState(false);
  const role = person.role === 'viewer' ? 'viewer' : 'editor';
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <Select aria-label={`What ${person.name} can do`} options={ROLE_OPTIONS} value={role} onValueChange={(next) => void actions.participant(person.id, { role: next }).catch(fail)} />
      <Menu>
        <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`More for ${person.name}`} size="sm" className="text-fg-secondary" />} />
        <MenuContent align="end" className="w-72">
          <MenuCheckboxItem
            checked={person.trusted}
            disabled={person.role === 'viewer'}
            description={`${person.name} can approve commands on your computer.`}
            onCheckedChange={(trusted) => void actions.participant(person.id, { trusted }).catch(fail)}
          >
            Trust with approvals
          </MenuCheckboxItem>
          <MenuSeparator />
          <MenuItem danger onClick={() => setRemoving(true)}>
            Remove
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${person.name}?`}
        description={`${person.name} leaves this session. Their running turn stops and their waiting messages go.`}
        confirmLabel="Remove"
        onConfirm={() => actions.remove(person.id).then(() => undefined, fail)}
      />
    </span>
  );
}

/** The host's settings for the session: sharing their models (with caps), copies, and guests' own models. */
function HostSettings({ settings, onChange }: { settings: CoopSettings; onChange(patch: Partial<CoopSettings>): void }) {
  return (
    <section aria-label="Settings" className="flex flex-col gap-3 border-t border-line pt-3">
      <SettingSwitch label="Guests can use my models" checked={settings.shareModels} onChange={(shareModels) => onChange({ shareModels })}>
        {settings.shareModels && (
          <div className="flex flex-col gap-1.5 pt-1">
            <CapField
              label="Requests a day per guest"
              before="Up to"
              after="requests a day each"
              value={settings.sharedRequestsPerDay}
              integer
              onChange={(sharedRequestsPerDay) => onChange({ sharedRequestsPerDay })}
            />
            <CapField label="Dollars a day per guest" before="Up to $" after="a day each" value={settings.sharedSpendPerDayUsd} onChange={(sharedSpendPerDayUsd) => onChange({ sharedSpendPerDayUsd })} />
            <p className="text-footnote text-fg-muted">Leave a field empty for no cap.</p>
          </div>
        )}
      </SettingSwitch>
      <SettingSwitch label="Guests keep a copy when co-op ends" checked={settings.guestsKeepCopy} onChange={(guestsKeepCopy) => onChange({ guestsKeepCopy })} />
      <SettingSwitch
        label="Guests’ own models read what the session reads"
        description="A guest who answers with their own model sends it the conversation and the files Atelier reads here."
        checked={settings.allowGuestModels}
        onChange={(allowGuestModels) => onChange({ allowGuestModels })}
      />
    </section>
  );
}

function SettingSwitch({ label, description, checked, disabled, onChange, children }: { label: string; description?: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void; children?: ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body text-fg">{label}</span>
          {description && <span className="text-footnote text-fg-muted">{description}</span>}
        </span>
        <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-px" />
      </div>
      {children}
    </div>
  );
}

/** "Up to [50] requests a day each": empty is no cap. Saved when it loses focus or on Enter. */
function CapField({ label, before, after, value, integer = false, onChange }: { label: string; before: string; after: string; value: number | null; integer?: boolean; onChange(value: number | null): void }) {
  const shown = value === null ? '' : integer ? String(value) : value.toFixed(2).replace(/\.00$/, '');
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const field = editing ? text : shown;
  const commit = () => {
    setEditing(false);
    const trimmed = text.trim();
    if (trimmed === shown) return;
    if (trimmed === '') return onChange(null);
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
      toast.error(integer ? 'Enter a whole number of requests, or leave it empty.' : 'Enter an amount in dollars, or leave it empty.');
      return;
    }
    onChange(integer ? n : Math.round(n * 100) / 100);
  };
  return (
    <label className="flex items-center gap-1.5 text-body text-fg-secondary">
      <span>{before}</span>
      <input
        aria-label={label}
        inputMode={integer ? 'numeric' : 'decimal'}
        value={field}
        placeholder="No cap"
        onFocus={() => {
          setText(shown);
          setEditing(true);
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(shown);
            setEditing(false);
          }
        }}
        className="h-7 w-16 rounded-md bg-fill-field px-2 text-body text-fg tabular-nums inset-ring inset-ring-fill-field-ring outline-none placeholder:text-fg-muted focus-ring"
      />
      <span>{after}</span>
    </label>
  );
}

function GuestPanel({ session, coop }: { session: SessionSummary; coop: CoopView }) {
  const actions = useCoopActions(session.id);
  const navigate = useNavigate();
  const [leaving, setLeaving] = useState(false);
  const state = coop.state;
  return (
    <>
      <Heading meta={coop.ended ? undefined : whereItRuns(coop)}>Co-op</Heading>
      {coop.ended ? (
        <p className="text-body text-fg-secondary">Co-op ended. {state?.settings.guestsKeepCopy ? 'Your copy of the conversation is in your sidebar.' : ''}</p>
      ) : (
        <>
          {coop.hostAway && <p className="text-body text-fg-secondary">{possessive(coop.hostName)} computer is asleep or offline. The session continues when it’s back.</p>}
          <section aria-label="People" className="flex flex-col gap-1.5">
            <SectionLabel>People</SectionLabel>
            <ul className="flex flex-col">
              {coop.people.map((p) => (
                <PersonRow key={p.id} person={p} me={p.id === coop.me} />
              ))}
            </ul>
          </section>
          {coop.role === 'viewer' ? (
            <p className="text-footnote text-fg-muted">You’re watching. {coop.hostName} decides who can chat.</p>
          ) : (
            state && (
              <>
                <GuestModels sessionId={session.id} state={state} hostName={coop.hostName} me={coop.people.find((p) => p.id === coop.me)} />
                <Navigator sessionId={session.id} coop={coop} />
                {session.mode === 'code' && <Tracks sessionId={session.id} coop={coop} />}
                {/* On a server a guest's own connectors come with their account; across computers they lend them. */}
                {state.via === 'relay' && <LendConnectors sessionId={session.id} lending={state.lending ?? false} />}
              </>
            )
          )}
          <div className="flex justify-end border-t border-line pt-3">
            <Button size="sm" variant="ghost" className="text-danger-text" onClick={() => setLeaving(true)}>
              Leave
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${possessive(coop.hostName)} session?`}
        description={state?.settings.guestsKeepCopy ? 'You keep a copy of the conversation in your sidebar.' : 'The session goes from your sidebar. You need a new invite to come back.'}
        confirmLabel="Leave"
        onConfirm={() => actions.leave().then(() => void navigate({ to: MODE_HOME[session.mode] }), fail)}
      />
    </>
  );
}

/**
 * The navigator: someone's model looks over each edit in the others' turns and notes what seems off. One person at a
 * time, who turns it on for themselves; the host can turn anyone's off.
 */
function Navigator({ sessionId, coop }: { sessionId: string; coop: CoopView }) {
  const actions = useCoopActions(sessionId);
  const navigator = coop.state?.settings.navigator ?? null;
  const mine = !!navigator && navigator === coop.me;
  const other = navigator && !mine ? coop.person(navigator).name : null;
  return (
    <div className="flex flex-col gap-1.5">
      <SettingSwitch
        label="Review edits with my model (navigator)"
        description={other ? `${other} reviews the edits now.` : 'Your model looks over each edit in the others’ turns and notes what seems off. It counts as your use.'}
        checked={mine}
        disabled={!!other}
        onChange={(on) => void actions.navigate(on).catch((e: unknown) => reportError(sessionId, e))}
      />
      {other && coop.isHost && (
        <button type="button" onClick={() => void actions.settings({ navigator: null }).catch(fail)} className="self-start rounded-xs text-footnote text-interactive-text outline-none focus-ring hover:underline">
          Turn off {possessive(other)} reviews
        </button>
      )}
    </div>
  );
}

/**
 * The guest's own connectors in their own turns: off until they say so, and each call still asks them. Their own
 * backend says whether they lend them (`lending`); a change shows at once and settles with the next read.
 */
function LendConnectors({ sessionId, lending }: { sessionId: string; lending: boolean }) {
  const actions = useCoopActions(sessionId);
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? lending;
  return (
    <SettingSwitch
      label="Use my connectors in my turns"
      description="Each call asks you first. They run on this computer."
      checked={on}
      onChange={(next) => {
        setPending(next);
        actions
          .lend(next)
          .then(() => actions.refresh())
          .catch((e: unknown) => reportError(sessionId, e))
          .finally(() => setPending(null));
      }}
    />
  );
}

/**
 * "Answer my messages with": the host's models (while the host shares them; the turn uses the session's model) or the
 * guest's own, with the model from their own list.
 */
function GuestModels({ sessionId, state, hostName, me }: { sessionId: string; state: CoopState; hostName: string; me: Participant | undefined }) {
  const actions = useCoopActions(sessionId);
  const { data: models } = useModels();
  const shared = state.settings.shareModels;
  const choice: ModelsChoice = me?.models === 'host' && shared ? 'host' : 'own';
  const own = choice === 'own' ? models?.find((m) => m.ref === me?.model) : undefined;
  const choose = (models: ModelsChoice, model: string | null) => void actions.models(models, model).catch((e: unknown) => reportError(sessionId, e));
  const items = [
    ...(shared ? [{ value: 'host' as const, label: `${possessive(hostName)} models` }] : []),
    { value: 'own' as const, label: 'My models' },
  ];
  const use = sharedUseLine(state);
  return (
    <section aria-label="Answer my messages with" className="flex flex-col gap-2 border-t border-line pt-3">
      <SectionLabel>Answer my messages with</SectionLabel>
      {items.length > 1 ? (
        <SegmentedControl aria-label="Answer my messages with" size="sm" items={items} value={choice} onValueChange={(next) => choose(next, next === 'own' ? (me?.model ?? null) : null)} className="self-start" />
      ) : (
        <p className="text-footnote text-fg-muted">{hostName} doesn’t share their models in this session.</p>
      )}
      {choice === 'host' ? (
        <p className="text-footnote text-fg-muted">{use ? `${hostName} pays for these: ${use}.` : `The session’s model answers. ${hostName} pays for it.`}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {/* Greyed out while the host hasn't agreed: such a turn would end in an error. */}
          <ModelMenu value={own?.ref ?? null} label={own?.displayName ?? 'Choose a model'} aria-label="My model" align="start" disabled={!state.settings.allowGuestModels} onChange={(ref) => ref && choose('own', ref)} />
          {state.settings.allowGuestModels ? (
            !own && <p className="text-footnote text-warning-text">Choose a model to answer your messages.</p>
          ) : (
            <p className="text-footnote text-fg-muted">{hostName} hasn’t agreed to send this session to guests’ own models.</p>
          )}
        </div>
      )}
    </section>
  );
}
