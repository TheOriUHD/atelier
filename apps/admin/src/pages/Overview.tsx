/** The first page: downloads, reports and the collector's state, at a glance. */
import { Bug, Download, Lightbulb, Rocket } from 'lucide-react';
import { useState } from 'react';
import { BarList, StackedColumns, type Column, type Series } from '../components/charts';
import { Card, ErrorNote, Facts, Meter, Segmented, Spinner, Stat } from '../components/ui';
import { useApi } from '../lib/api';
import { bytes, dayLabel, daysBetween, num, pct } from '../lib/format';
import { GROUPS, groupOf } from '../lib/platforms';
import { Link } from '../lib/router';
import type { DayCount, Limits, Overview as OverviewData } from '../types';

/** Day columns from `from` to `to`, summed into the platform groups. */
export function byGroup(rows: DayCount[], from: string, to: string): Column[] {
  const columns = new Map(daysBetween(from, to).map((day) => [day, { day, values: {} as Record<string, number> }]));
  for (const r of rows) {
    const col = columns.get(r.day);
    if (!col) continue;
    const g = groupOf(r.platform);
    col.values[g] = (col.values[g] ?? 0) + r.count;
  }
  return [...columns.values()];
}
export const GROUP_SERIES: Series[] = GROUPS.map((g) => ({ id: g.id, label: g.label, color: g.color }));

function change(now: number, before: number): string {
  if (!before) return now ? 'none the week before' : 'none the week before either';
  const d = (now - before) / before;
  return `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 100))}% on the week before`;
}

export function Collector({ limits }: { limits: Limits }) {
  const nextStep = limits.bitsSteps.find((s) => s.below !== null && limits.today < s.below);
  const stepAfter = nextStep ? limits.bitsSteps[limits.bitsSteps.indexOf(nextStep) + 1] : undefined;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex justify-between text-footnote">
          <span className="text-fg-muted">Reports today</span>
          <span className="tabular">
            {num(limits.today)} <span className="text-fg-muted">of {num(limits.perDay)}</span>
          </span>
        </div>
        <Meter value={limits.today} max={limits.perDay} label="Reports today against the daily cap" />
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-footnote">
          <span className="text-fg-muted">Storage</span>
          <span className="tabular">
            {bytes(limits.storedBytes)} <span className="text-fg-muted">of {bytes(limits.storageBytes)}</span>
          </span>
        </div>
        <Meter value={limits.storedBytes} max={limits.storageBytes} label="Stored bytes against the storage cap" />
      </div>
      <Facts
        rows={[
          [
            'Proof of work',
            `${limits.bits} bits${nextStep && stepAfter ? `, ${stepAfter.bits} from ${num(nextStep.below)} reports a day` : ''}`,
          ],
          [
            'Addresses today',
            limits.addressesToday
              ? `${num(limits.addressesToday)}, the busiest sent ${num(limits.busiestAddressToday)} of ${limits.perAddressPerDay}`
              : 'none yet',
          ],
          [
            'Rate limits',
            `${limits.rate.reports.limit} reports and ${limits.rate.challenges.limit} challenges a minute per address`,
          ],
          ['Kept for', `${limits.retentionDays} days`],
        ]}
      />
    </div>
  );
}

export function Overview() {
  const [days, setDays] = useState<'30' | '90'>('30');
  const { data, error, loading } = useApi<OverviewData>(`/api/overview?days=${days}`);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title">Overview</h1>
        <Segmented
          label="Range"
          value={days}
          onChange={setDays}
          options={[
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && loading && <Spinner />}
      {data && <Body data={data} />}
    </div>
  );
}

function Body({ data }: { data: OverviewData }) {
  const d = data.downloads;
  const updates30 = d.kinds.update?.d30 ?? 0;
  const reportSeries: Series[] = [
    { id: 'issue', label: 'Issues', color: 'var(--viz-1)' },
    { id: 'feature', label: 'Feature requests', color: 'var(--viz-2)' },
  ];
  const reportColumns: Column[] = daysBetween(data.from, data.today).map((day) => ({
    day,
    values: Object.fromEntries(data.reports.daily.filter((r) => r.day === day).map((r) => [r.kind, r.count])),
  }));
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <Stat
          label="Downloads today"
          icon={<Download size={14} aria-hidden />}
          value={num(d.today)}
          sub={dayLabel(data.today, true)}
        />
        <Stat label="Downloads, 7 days" value={num(d.d7)} sub={change(d.d7, d.prev7)} />
        <Stat label="Downloads, 30 days" value={num(d.d30)} sub={`and ${num(updates30)} app updates`} />
        <Stat
          label="New issues"
          icon={<Bug size={14} aria-hidden />}
          value={
            <Link href="/issues" className="hover:underline">
              {num(data.reports.issue.new)}
            </Link>
          }
          sub={`${num(data.reports.issue.unseen)} unread, ${num(data.reports.issue.total)} in all`}
        />
        <Stat
          label="New feature requests"
          icon={<Lightbulb size={14} aria-hidden />}
          value={
            <Link href="/features" className="hover:underline">
              {num(data.reports.feature.new)}
            </Link>
          }
          sub={`${num(data.reports.feature.unseen)} unread, ${num(data.reports.feature.total)} in all`}
        />
        <Stat
          label={data.latest ? `Latest version, ${data.latest.version}` : 'Latest version'}
          icon={<Rocket size={14} aria-hidden />}
          value={data.latest ? pct(data.latest.share7) : '–'}
          sub={
            data.latest
              ? `of package fetches in 7 days; ${num(data.latest.updates)} updates since ${dayLabel(data.latest.since)}`
              : 'No packages counted yet'
          }
        />
      </div>

      <Card
        title="Downloads per day"
        actions={<span className="text-caption text-fg-muted">Packages people downloaded, by platform</span>}
      >
        <StackedColumns
          label="Downloads per day by platform"
          columns={byGroup(d.daily, data.from, data.today)}
          series={GROUP_SERIES}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Versions" actions={<span className="text-caption text-fg-muted">Package fetches, 30 days</span>}>
          <BarList
            rows={data.versions.map((v) => ({
              key: v.version,
              label: v.version,
              value: v.downloads + v.updates,
              note: `${num(v.downloads)} downloads, ${num(v.updates)} updates`,
            }))}
            empty="No packages counted yet."
          />
        </Card>
        <Card
          title="Update checks per day"
          actions={<span className="text-caption text-fg-muted">{num(data.checks.today)} today</span>}
        >
          <StackedColumns
            label="Update checks per day by platform"
            height={170}
            columns={byGroup(data.checks.daily, data.from, data.today)}
            series={GROUP_SERIES}
          />
          <p className="mt-3 text-caption text-fg-muted">
            Running versions are unavailable: the app&rsquo;s update check doesn&rsquo;t say which version it is. Apps
            check every five minutes while they run, so this follows how much Atelier is in use. For which versions
            people have, see Versions.
          </p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Reports per day">
          <StackedColumns
            label="Reports per day by kind"
            height={170}
            columns={reportColumns}
            series={reportSeries}
            empty="No reports in this range."
          />
        </Card>
        <Card title="Collector" actions={<span className="text-caption text-fg-muted">reports.atelierhq.dev</span>}>
          <Collector limits={data.collector} />
        </Card>
      </div>
    </>
  );
}
