import { Suspense, lazy, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Pencil, Plus, X } from 'lucide-react';
import { z } from 'zod';
import type { Settings, UsageRow } from '@atelier/protocol';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  SegmentedControl,
  Select,
  TextField,
  formatCount,
} from '../../components/ui/index.ts';
import { keys, useAccount, useModels, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useFormSubmit } from '../auth/form.ts';
import { Cell, DataTable, TableRow } from './data-table.tsx';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';
import { useSetting, type Setting } from './use-setting.ts';
import { MODES, MODE_LABELS, byModel, formatTokens, formatUsd, modeShares, tokensByDay, totals, type ModeKey } from './usage-data.ts';

const UsageChart = lazy(() => import('./usage-chart.tsx'));

const PERIODS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
const SCOPES = [
  { value: 'me', label: 'Only me' },
  { value: 'everyone', label: 'Everyone' },
] as const;

/**
 * Mode colors for the chart and its legend, set on the page: the first three slots of the dataviz reference palette (they stay
 * apart with color blindness, in both themes), gray for anything else.
 */
const SERIES =
  '[--series-chat:#2a78d6] [--series-work:#eb6834] [--series-code:#1baf7a] [--series-other:#898781] dark:[--series-chat:#3987e5] dark:[--series-work:#d95926] dark:[--series-code:#199e70]';
const SWATCH: Record<ModeKey, string> = { chat: 'bg-(--series-chat)', work: 'bg-(--series-work)', code: 'bg-(--series-code)', other: 'bg-(--series-other)' };

type Price = Settings['pricing'][string];

/** A model's display name and its provider's name, for usage rows and prices. */
function useModelNames() {
  const { data: models } = useModels();
  const { settings } = useSettings();
  return (providerId: string, modelId: string) => ({
    model: models?.find((m) => m.providerId === providerId && m.modelId === modelId)?.displayName ?? modelId,
    provider: settings?.providers.find((p) => p.id === providerId)?.name ?? providerId,
  });
}

const splitRef = (ref: string) => [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)] as const;

/** Requests, tokens and cost over a period, by day and by model; admins also see everyone's and set prices. */
export function UsagePage() {
  const { account } = useAccount();
  const admin = account?.role === 'admin';
  const [period, setPeriod] = useState('30');
  const [scope, setScope] = useState<'me' | 'everyone'>('me');
  const everyone = admin && scope === 'everyone';
  const days = Number(period);
  const { data: rows, error } = useQuery({
    queryKey: [...keys.usage, days, everyone],
    queryFn: () => rpc().call('usage.summary', { days, timezoneOffset: new Date().getTimezoneOffset(), ...(everyone && { everyone }) }),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  const used = !!rows?.length;

  return (
    <div className={SERIES}>
      <SettingsSection
        id="usage.overview"
        title={everyone ? 'Everyone’s usage' : settingEntry('usage.overview').label}
        action={
          <div className="flex items-center gap-2">
            {admin && <SegmentedControl aria-label="Whose usage" items={SCOPES} value={scope} onValueChange={setScope} />}
            <Select aria-label="Period" options={PERIODS} value={period} onValueChange={setPeriod} />
          </div>
        }
      >
        {error ? (
          <p role="alert" className="text-body text-danger-text">
            {describeError(error).message}
          </p>
        ) : (
          rows && <Summary rows={rows} days={days} admin={admin} />
        )}
      </SettingsSection>
      {used && <DaysSection rows={rows} days={days} />}
      {used && <ModelsSection rows={rows} />}
      {admin && <PricesSection />}
    </div>
  );
}

const conjunction = new Intl.ListFormat('en-US', { type: 'conjunction' });
const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** One statement line (serif), then where the tokens went and what has no price. */
function Summary({ rows, days, admin }: { rows: UsageRow[]; days: number; admin: boolean }) {
  const t = totals(rows);
  const statement =
    t.requests === 0
      ? `No usage in the last ${days} days.`
      : `${conjunction.format([
          plural(t.requests, 'request', 'requests'),
          `${formatTokens(t.tokens)} tokens`,
          ...(t.unpriced < t.requests ? [formatUsd(t.cost)] : []),
        ])} in the last ${days} days.`;
  const parts = [
    `${formatTokens(t.input)} input`,
    ...(t.cacheRead ? [`${formatTokens(t.cacheRead)} cache read`] : []),
    ...(t.cacheWrite ? [`${formatTokens(t.cacheWrite)} cache write`] : []),
    `${formatTokens(t.output)} output`,
  ];
  return (
    <div className="flex flex-col gap-1">
      <p className="font-serif text-[20px] leading-7 text-fg">{statement}</p>
      {t.requests > 0 && <p className="text-body text-fg-muted">{parts.join(' · ')}</p>}
      {t.unpriced > 0 && (
        <p className="text-body text-fg-muted">
          {plural(t.unpriced, 'request', 'requests')} without a price.{admin && ' Add prices below to count their cost.'}
        </p>
      )}
    </div>
  );
}

function DaysSection({ rows, days }: { rows: UsageRow[]; days: number }) {
  const data = useMemo(() => tokensByDay(rows, days), [rows, days]);
  const shares = modeShares(rows);
  // Stacked in a fixed order, so a mode keeps its place and color whatever the period.
  const modes = MODES.filter((m) => shares.some((s) => s.mode === m));
  return (
    <SettingsSection
      id="usage.byDay"
      title={settingEntry('usage.byDay').label}
      action={
        <ul aria-label="Share of tokens by mode" className="flex gap-4 text-footnote text-fg-secondary">
          {shares.map(({ mode, share }) => (
            <li key={mode} className="flex items-center gap-1.5">
              <span aria-hidden className={`size-2 rounded-full ${SWATCH[mode]}`} />
              {MODE_LABELS[mode]}
              <span className="text-fg-muted tabular-nums">{Math.round(share * 100)}%</span>
            </li>
          ))}
        </ul>
      }
    >
      <Suspense fallback={<div className="h-[200px]" />}>
        <UsageChart data={data} modes={modes} />
      </Suspense>
    </SettingsSection>
  );
}

function ModelsSection({ rows }: { rows: UsageRow[] }) {
  const entry = settingEntry('usage.byModel');
  const names = useModelNames();
  return (
    <SettingsSection id="usage.byModel" title={entry.label} description={entry.description}>
      <DataTable
        label={entry.label}
        columns={[
          { label: 'Model' },
          { label: 'Requests', className: 'w-24 text-right' },
          { label: 'Tokens', className: 'w-24 text-right' },
          { label: 'Cost', className: 'w-24 text-right' },
          { label: 'Speed', className: 'w-28 text-right' },
        ]}
      >
        {byModel(rows).map((m) => {
          const name = names(m.providerId, m.modelId);
          return (
            <TableRow key={m.ref}>
              <Cell title={m.ref}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-fg">{name.model}</span>
                  <span className="shrink-0 text-footnote text-fg-muted">{name.provider}</span>
                </span>
              </Cell>
              <Cell className="text-right tabular-nums">{formatCount(m.requests)}</Cell>
              <Cell className="text-right tabular-nums">{formatTokens(m.tokens)}</Cell>
              <Cell className="text-right tabular-nums" title={m.unpriced ? `${plural(m.unpriced, 'request', 'requests')} without a price` : undefined}>
                {m.cost === null ? '—' : formatUsd(m.cost)}
              </Cell>
              <Cell className="text-right tabular-nums">{m.tokensPerSecond === null ? '—' : `${Math.round(m.tokensPerSecond)} tokens/s`}</Cell>
            </TableRow>
          );
        })}
      </DataTable>
    </SettingsSection>
  );
}

/** Admins: $ per million tokens for each model, kept in the system settings' price table. */
function PricesSection() {
  const entry = settingEntry('usage.prices');
  const pricing = useSetting<Record<string, Price>>(['pricing']);
  const names = useModelNames();
  const dialog = useDialog();
  const [editing, setEditing] = useState<string | null>(null);
  const prices = Object.entries(pricing.value).sort(([a], [b]) => a.localeCompare(b));
  const edit = (ref: string | null) => {
    setEditing(ref);
    dialog.show();
  };
  const usd = (n: number | undefined) => (n === undefined ? <span className="text-fg-muted">as input</span> : formatUsd(n));

  return (
    <SettingsSection
      id="usage.prices"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" leadingIcon={Plus} onClick={() => edit(null)}>
          Add price
        </Button>
      }
    >
      {pricing.error && !dialog.open && (
        <p role="alert" className="pb-3 text-body text-danger-text">
          {pricing.error}
        </p>
      )}
      {prices.length === 0 ? (
        <p className="pb-3 text-body text-fg-muted">No prices yet. Requests count their tokens, without a cost.</p>
      ) : (
        <DataTable
          label={entry.label}
          columns={[
            { label: 'Model' },
            { label: 'Input', className: 'w-24 text-right' },
            { label: 'Output', className: 'w-24 text-right' },
            { label: 'Cache read', className: 'w-24 text-right' },
            { label: 'Cache write', className: 'w-24 text-right' },
            { label: 'Actions', hidden: true, className: 'w-20' },
          ]}
        >
          {prices.map(([ref, price]) => {
            const name = names(...splitRef(ref));
            return (
              <TableRow key={ref}>
                <Cell title={ref}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-fg">{name.model}</span>
                    <span className="shrink-0 text-footnote text-fg-muted">{name.provider}</span>
                  </span>
                </Cell>
                <Cell className="text-right tabular-nums">{usd(price.input)}</Cell>
                <Cell className="text-right tabular-nums">{usd(price.output)}</Cell>
                <Cell className="text-right tabular-nums">{usd(price.cacheRead)}</Cell>
                <Cell className="text-right tabular-nums">{usd(price.cacheWrite)}</Cell>
                <Cell className="text-right">
                  <IconButton icon={Pencil} size="sm" label={`Edit the price of ${name.model}`} onClick={() => edit(ref)} />
                  <IconButton
                    icon={X}
                    size="sm"
                    label={`Remove the price of ${name.model}`}
                    onClick={() => void pricing.set(Object.fromEntries(prices.filter(([r]) => r !== ref)))}
                  />
                </Cell>
              </TableRow>
            );
          })}
        </DataTable>
      )}
      <PriceDialog key={dialog.key} open={dialog.open} onOpenChange={dialog.onOpenChange} editing={editing} pricing={pricing} />
    </SettingsSection>
  );
}

const DOLLARS = /^(\d+\.?\d*|\.\d+)$/;
const dollars = (required: boolean) =>
  z
    .string()
    .trim()
    .refine((s) => (required ? DOLLARS.test(s) : !s || DOLLARS.test(s)), 'Enter dollars per million tokens, like 3 or 0.25.');
const PriceForm = z.object({ model: z.string().min(1, 'Choose a model.'), input: dollars(true), output: dollars(true), cacheRead: dollars(false), cacheWrite: dollars(false) });
type PriceFields = z.infer<typeof PriceForm>;

function PriceDialog({
  open,
  onOpenChange,
  editing,
  pricing,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  editing: string | null;
  pricing: Setting<Record<string, Price>>;
}) {
  const { data: models } = useModels();
  const names = useModelNames();
  const current = editing ? pricing.value[editing] : undefined;
  const text = (n: number | undefined) => (n === undefined ? '' : String(n));
  const [values, setValues] = useState<PriceFields>({
    model: editing ?? '',
    input: text(current?.input),
    output: text(current?.output),
    cacheRead: text(current?.cacheRead),
    cacheWrite: text(current?.cacheWrite),
  });
  const form = useFormSubmit(PriceForm, {}, async (v) => {
    const price: Price = {
      input: Number(v.input),
      output: Number(v.output),
      ...(v.cacheRead && { cacheRead: Number(v.cacheRead) }),
      ...(v.cacheWrite && { cacheWrite: Number(v.cacheWrite) }),
    };
    if (await pricing.set({ ...pricing.value, [v.model]: price })) onOpenChange(false);
  });
  const label = (ref: string) => {
    const name = names(...splitRef(ref));
    return `${name.model} · ${name.provider}`;
  };
  const options = editing
    ? [{ value: editing, label: label(editing) }]
    : (models ?? []).filter((m) => !pricing.value[m.ref]).map((m) => ({ value: m.ref, label: label(m.ref) }));
  const field = (key: Exclude<keyof PriceFields, 'model'>) => ({
    value: values[key],
    onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value })),
    inputMode: 'decimal' as const,
    placeholder: key.startsWith('cache') ? 'As input' : '0.00',
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={editing ? 'Edit price' : 'Add price'} description="Dollars per million tokens. Requests made from now on use it.">
        <form noValidate onSubmit={form.onSubmit(values)} className="flex flex-col gap-4">
          <Field label="Model" error={form.errors.model}>
            <Select
              variant="field"
              options={options}
              value={values.model}
              placeholder="Choose a model"
              disabled={!!editing}
              onValueChange={(model) => setValues((v) => ({ ...v, model }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Input" error={form.errors.input}>
              <TextField {...field('input')} />
            </Field>
            <Field label="Output" error={form.errors.output}>
              <TextField {...field('output')} />
            </Field>
            <Field label="Cache read" error={form.errors.cacheRead}>
              <TextField {...field('cacheRead')} />
            </Field>
            <Field label="Cache write" error={form.errors.cacheWrite}>
              <TextField {...field('cacheWrite')} />
            </Field>
          </div>
          {pricing.error && (
            <p role="alert" className="text-footnote text-danger-text">
              {pricing.error}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={form.pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
