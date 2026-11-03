import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { LIMIT_INFO, LIMIT_KEYS, type LimitKey, type LimitsSettings, type PersonLimits, type UserLimits } from '@atelier/protocol';
import { Badge, Button, Dialog, DialogContent, DialogFooter, IconButton, ProgressBar, Select, Switch, TextField, toast } from '../../components/ui/index.ts';
import { keys, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { closestLimit, LimitMeter, limitAmounts, limitTone } from './limits-view.tsx';
import { settingEntry, type SettingId } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { useDraftText, useSetting } from './use-setting.ts';

/** Admin › Limits: what each person may use of the text models on this server, and where everyone stands. */
export function LimitsPage() {
  return (
    <>
      <SettingsSection
        title="Limits for everyone"
        description="Off until you set one. They apply to each person separately, to all their conversations together. A person who reaches one is told which, when it resets and to ask an admin."
      >
        {LIMIT_KEYS.map((key) => (
          <LimitRow key={key} limit={key} />
        ))}
      </SettingsSection>
      <PeopleLimits id="limits.people" />
    </>
  );
}

const WHOLE = /^\d+$/;
const DOLLARS = /^(\d+\.?\d*|\.\d+)$/;

/** "500000", "500,000", "500k" and "2M" for tokens and counts; "5" and "0.50" for dollars. Null when it isn't a positive amount. */
export function parseLimit(key: LimitKey, text: string): number | null {
  const clean = text.trim().replace(/[,\s_]/g, '').toLowerCase();
  if (LIMIT_INFO[key].unit === 'usd') {
    const n = Number(clean.replace(/^\$/, ''));
    return DOLLARS.test(clean.replace(/^\$/, '')) && n > 0 ? n : null;
  }
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(clean);
  if (!match) return null;
  const n = Math.round(Number(match[1]) * (match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : 1));
  return WHOLE.test(String(n)) && n >= 1 ? n : null;
}

const PROBLEM: Record<'tokens' | 'usd' | 'requests', string> = {
  tokens: 'Enter a whole number like 500000, or 500k or 2M. Leave it empty for no limit.',
  usd: 'Enter dollars like 5 or 0.50, or leave it empty for no limit.',
  requests: 'Enter a whole number, or leave it empty for no limit.',
};
const UNIT = { tokens: 'tokens', usd: 'dollars', requests: 'requests' } as const;

/** A number that saves as it's typed; left empty it is no limit. */
function LimitRow({ limit }: { limit: LimitKey }) {
  const setting = useSetting<number | undefined>(['limits', limit]);
  const [invalid, setInvalid] = useState(false);
  const { unit } = LIMIT_INFO[limit];
  const draft = useDraftText({
    value: setting.value?.toString() ?? '',
    set: async (text) => {
      if (!text.trim()) {
        setInvalid(false);
        return setting.clear();
      }
      const value = parseLimit(limit, text);
      setInvalid(value === null);
      return value !== null && setting.set(value);
    },
  });
  return (
    <SettingRow id={`limits.${limit}` as SettingId} setting={setting} error={invalid ? PROBLEM[unit] : null}>
      {(label) => (
        <div className="flex items-center gap-2">
          <TextField {...label} {...draft} inputMode="decimal" placeholder="No limit" invalid={invalid} className="w-28 text-right" />
          <span className="w-14 text-body text-fg-muted">{UNIT[unit]}</span>
        </div>
      )}
    </SettingRow>
  );
}

/** Everyone's usage against their limits, closest limit first, with a marker for who is near or at one. */
export function PeopleLimits({ id }: { id: SettingId }) {
  const entry = settingEntry(id);
  const { data: people, error } = useQuery({ queryKey: keys.limitsEveryone, queryFn: () => rpc().call('limits.everyone', {}), staleTime: 0 });
  const { settings } = useSettings();
  const dialog = useDialog();
  const [editing, setEditing] = useState<PersonLimits | null>(null);
  const system = settings?.limits ?? {};
  // Who is near or over a limit depends on the limits for everyone, which this very page edits.
  const qc = useQueryClient();
  const limitsKey = JSON.stringify(settings?.limits ?? {});
  useEffect(() => void qc.invalidateQueries({ queryKey: keys.limitsEveryone }), [limitsKey, qc]);
  const edit = (person: PersonLimits) => {
    setEditing(person);
    dialog.show();
  };
  return (
    <SettingsSection id={id} title={entry.label} description={entry.description}>
      {error ? (
        <p role="alert" className="text-body text-danger-text">
          {describeError(error).message}
        </p>
      ) : (
        <DataTable
          label={entry.label}
          columns={[
            { label: 'Person' },
            { label: 'Closest limit', className: 'w-72' },
            { label: 'Actions', hidden: true, className: 'w-10' },
          ]}
        >
          {people
            ?.filter((p) => !p.disabled)
            .sort((a, b) => Number(!!closestLimit(b.status)?.reached) - Number(!!closestLimit(a.status)?.reached) || Number(!!closestLimit(b.status)?.near) - Number(!!closestLimit(a.status)?.near) || a.name.localeCompare(b.name))
            .map((p) => <PersonRow key={p.id} person={p} onEdit={() => edit(p)} />)}
        </DataTable>
      )}
      {editing && <PersonDialog key={`${dialog.key}:${editing.id}`} open={dialog.open} onOpenChange={dialog.onOpenChange} person={editing} system={system} />}
    </SettingsSection>
  );
}

function PersonRow({ person, onEdit }: { person: PersonLimits; onEdit(): void }) {
  const closest = closestLimit(person.status);
  const custom = Object.values(person.own).some((v) => v !== undefined && v !== false);
  return (
    <TableRow>
      <Cell>
        <span className="flex items-center gap-2">
          <span className="truncate text-fg">{person.name}</span>
          {person.status.exempt && <Badge tone="accent">Exempt</Badge>}
          {!person.status.exempt && custom && <Badge>Own limits</Badge>}
        </span>
        <span className="block truncate text-footnote text-fg-muted">{person.username}</span>
      </Cell>
      <Cell>
        {closest ? (
          <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2 text-footnote">
              <span className="truncate">
                {LIMIT_KEYSHORT[closest.key]} · {limitAmounts(closest)}
              </span>
              {closest.reached ? <Badge tone="danger">At limit</Badge> : closest.near && <Badge tone="warning">Near limit</Badge>}
            </span>
            <ProgressBar value={closest.used / closest.max} tone={limitTone(closest)} aria-label={`${person.name}: ${LIMIT_INFO[closest.key].label}`} />
          </div>
        ) : (
          <span className="text-fg-muted">{person.status.exempt ? 'No limits' : 'No limit set'}</span>
        )}
      </Cell>
      <Cell className="text-right">
        <IconButton icon={Pencil} size="sm" label={`Edit the limits of ${person.name}`} onClick={onEdit} />
      </Cell>
    </TableRow>
  );
}

const LIMIT_KEYSHORT: Record<LimitKey, string> = {
  tokensPerDay: 'Tokens/day',
  tokensPer30Days: 'Tokens/30 days',
  costUsdPerDay: 'Cost/day',
  costUsdPer30Days: 'Cost/30 days',
  requestsPerHour: 'Requests/hour',
};

type Choice = 'inherit' | 'custom' | 'off';
const CHOICES = [
  { value: 'inherit', label: 'Like everyone' },
  { value: 'custom', label: 'Own limit' },
  { value: 'off', label: 'No limit' },
] satisfies { value: Choice; label: string }[];

interface Draft {
  exempt: boolean;
  choice: Record<LimitKey, Choice>;
  amount: Record<LimitKey, string>;
}

function draftOf(own: UserLimits): Draft {
  const choice = {} as Record<LimitKey, Choice>;
  const amount = {} as Record<LimitKey, string>;
  for (const key of LIMIT_KEYS) {
    const value = own[key];
    choice[key] = value === undefined ? 'inherit' : value === null ? 'off' : 'custom';
    amount[key] = typeof value === 'number' ? String(value) : '';
  }
  return { exempt: own.exempt === true, choice, amount };
}

/** What to store for a draft, or the first field that isn't a number. */
function limitsOf(draft: Draft): { limits: UserLimits } | { problem: LimitKey } {
  const limits: UserLimits = {};
  if (draft.exempt) limits.exempt = true;
  for (const key of LIMIT_KEYS) {
    if (draft.choice[key] === 'off') limits[key] = null;
    if (draft.choice[key] === 'custom') {
      const value = parseLimit(key, draft.amount[key]);
      if (value === null) return { problem: key };
      limits[key] = value;
    }
  }
  return { limits };
}

const systemText = (key: LimitKey, system: LimitsSettings) => {
  const value = system[key];
  return value === undefined ? 'none set' : limitAmounts({ key, used: 0, max: value }).replace(/^\S+ of /, '');
};

function PersonDialog({ open, onOpenChange, person, system }: { open: boolean; onOpenChange(open: boolean): void; person: PersonLimits; system: LimitsSettings }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => draftOf(person.own));
  const [problem, setProblem] = useState<LimitKey | null>(null);
  const [pending, setPending] = useState(false);
  const save = async () => {
    const result = limitsOf(draft);
    if ('problem' in result) return setProblem(result.problem);
    setProblem(null);
    setPending(true);
    try {
      await rpc().call('users.update', { id: person.id, limits: result.limits });
      void qc.invalidateQueries({ queryKey: keys.limitsEveryone });
      void qc.invalidateQueries({ queryKey: keys.users });
      onOpenChange(false);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Limits for ${person.name}`} description="Change what applies to this person alone. Everything else follows the limits for everyone.">
        <div className="flex flex-col gap-4">
          {person.status.rows.length > 0 && (
            <div className="divide-y divide-line-subtle">
              {person.status.rows.map((row) => (
                <LimitMeter key={row.key} row={row} />
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-4 text-body text-fg">
            <span>
              No limits for this person
              <span className="block text-footnote text-fg-muted">For an account that must not be stopped, such as a shared service account.</span>
            </span>
            <Switch checked={draft.exempt} onCheckedChange={(exempt) => setDraft((d) => ({ ...d, exempt }))} aria-label="No limits for this person" />
          </div>
          {!draft.exempt &&
            LIMIT_KEYS.map((key) => (
              <div key={key} className="flex flex-col gap-2">
                <span className="text-[14px]/[14px] font-medium text-fg">{LIMIT_INFO[key].label}</span>
                <div className="flex items-center gap-2">
                  <Select
                    variant="field"
                    className="w-40"
                    aria-label={`${LIMIT_INFO[key].label} for ${person.name}`}
                    options={CHOICES}
                    value={draft.choice[key]}
                    onValueChange={(choice) => setDraft((d) => ({ ...d, choice: { ...d.choice, [key]: choice } }))}
                  />
                  {draft.choice[key] === 'custom' && (
                    <TextField
                      aria-label={`${LIMIT_INFO[key].label} amount`}
                      value={draft.amount[key]}
                      inputMode="decimal"
                      invalid={problem === key}
                      className="w-28 text-right"
                      onChange={(e) => setDraft((d) => ({ ...d, amount: { ...d.amount, [key]: e.target.value } }))}
                    />
                  )}
                  {draft.choice[key] === 'inherit' && <span className="text-footnote text-fg-muted">{systemText(key, system)}</span>}
                </div>
                {problem === key && (
                  <p role="alert" className="text-footnote text-danger-text">
                    Enter a positive number, like 500k for tokens or 5 for dollars.
                  </p>
                )}
              </div>
            ))}
        </div>
        <DialogFooter className="mt-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={() => void save()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
