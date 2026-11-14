/** Everything the update feed counted (deploy/cloudflare/src/stats.js), and GitHub's release counters. */
import { useMemo, useState } from 'react';
import { BarList, StackedColumns, type Column, type Series } from '../components/charts';
import { Card, ErrorNote, Segmented, Spinner, Stat } from '../components/ui';
import { useApi } from '../lib/api';
import { compareVersions, dayLabel, daysBetween, num } from '../lib/format';
import { KINDS, kindLabel, platformLabel } from '../lib/platforms';
import type { Downloads } from '../types';
import { byGroup, GROUP_SERIES } from './Overview';

const regions = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();
export function countryName(code: string): string {
  if (code === 'XX') return 'Unknown';
  if (code === 'T1') return 'Tor';
  try {
    return regions?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function DownloadsPage() {
  const [days, setDays] = useState<'30' | '90' | '365'>('90');
  const { data, error, loading } = useApi<Downloads>(`/api/downloads?days=${days}`);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title">Downloads</h1>
        <Segmented
          label="Range"
          value={days}
          onChange={setDays}
          options={[
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
            { value: '365', label: 'A year' },
          ]}
        />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data && loading && <Spinner />}
      {data && <Body data={data} />}
    </div>
  );
}

function Body({ data }: { data: Downloads }) {
  const [kind, setKind] = useState('download');
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of data.daily) t[r.kind] = (t[r.kind] ?? 0) + r.count;
    return t;
  }, [data]);
  const platforms = useMemo(() => {
    const by = new Map<string, Record<string, number>>();
    for (const r of data.daily) {
      const row = by.get(r.platform) ?? {};
      row[r.kind] = (row[r.kind] ?? 0) + r.count;
      by.set(r.platform, row);
    }
    return [...by]
      .map(([platform, kinds]) => ({ platform, kinds, total: Object.values(kinds).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total);
  }, [data]);
  const versions = useMemo(() => {
    const by = new Map<string, { downloads: number; updates: number }>();
    for (const v of data.versions) {
      if (v.kind !== 'download' && v.kind !== 'update') continue;
      const row = by.get(v.version) ?? { downloads: 0, updates: 0 };
      if (v.kind === 'download') row.downloads += v.count;
      else row.updates += v.count;
      by.set(v.version, row);
    }
    return [...by].sort(([a], [b]) => compareVersions(b, a));
  }, [data]);
  const countries = data.countries.slice(0, 12);
  const otherCountries = data.countries.slice(12).reduce((n, c) => n + c.count, 0);
  const shownKinds = KINDS.filter((k) => totals[k.id]);
  const ghSeries: Series[] = [{ id: 'github', label: 'GitHub downloads', color: 'var(--viz-7)' }];
  const ghColumns: Column[] = daysBetween(data.from, data.today).map((day) => ({
    day,
    values: { github: data.github.daily.find((d) => d.day === day)?.delta ?? 0 },
  }));

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">
        {KINDS.slice(0, 4).map((k) => (
          <Stat key={k.id} label={k.label} value={num(totals[k.id] ?? 0)} sub={k.hint} />
        ))}
        <Stat
          label="GitHub releases"
          value={num(data.github.total)}
          sub={data.github.day ? `all time, read ${dayLabel(data.github.day)}` : 'not read yet (daily cron)'}
        />
      </div>

      <Card
        title="Per day"
        actions={
          shownKinds.length > 1 && (
            <Segmented
              label="What to show"
              value={kind}
              onChange={setKind}
              options={shownKinds.map((k) => ({ value: k.id, label: k.label, title: k.hint }))}
            />
          )
        }
      >
        <StackedColumns
          label={`${kindLabel(kind)} per day by platform`}
          columns={byGroup(
            data.daily.filter((r) => r.kind === kind),
            data.from,
            data.today,
          )}
          series={GROUP_SERIES}
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="By platform" padded={false}>
          {platforms.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-footnote tabular">
                <thead className="text-fg-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-normal">Platform</th>
                    {shownKinds.map((k) => (
                      <th key={k.id} className="px-3 py-2 text-right font-normal whitespace-nowrap">
                        {k.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {platforms.map((p) => (
                    <tr key={p.platform} className="border-t border-line-subtle">
                      <td className="px-4 py-1.5 whitespace-nowrap">{platformLabel(p.platform)}</td>
                      {shownKinds.map((k) => (
                        <td key={k.id} className="px-3 py-1.5 text-right">
                          {p.kinds[k.id] ? num(p.kinds[k.id]) : <span className="text-fg-disabled">–</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-footnote text-fg-muted">Nothing counted yet.</div>
          )}
        </Card>
        <Card title="By version" actions={<span className="text-caption text-fg-muted">Downloads and updates</span>}>
          <BarList
            rows={versions.map(([version, v]) => ({
              key: version,
              label: version,
              value: v.downloads + v.updates,
              note: `${num(v.downloads)} + ${num(v.updates)} updates`,
            }))}
          />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="By country"
          actions={
            <span className="text-caption text-fg-muted">Downloads; Cloudflare&rsquo;s guess, no addresses kept</span>
          }
        >
          <BarList
            color="var(--viz-3)"
            rows={[
              ...countries.map((c) => ({
                key: c.country,
                label: countryName(c.country),
                note: c.country !== 'XX' ? c.country : undefined,
                value: c.count,
              })),
              ...(otherCountries ? [{ key: 'other', label: 'Other countries', value: otherCountries }] : []),
            ]}
          />
        </Card>
        <Card title="Update checks per day">
          <StackedColumns
            label="Update checks per day by platform"
            height={170}
            columns={byGroup(data.checks, data.from, data.today)}
            series={GROUP_SERIES}
          />
          <p className="mt-3 text-caption text-fg-muted">
            The check carries no version (electron-updater asks as &ldquo;electron-builder&rdquo;), so which versions
            are running can&rsquo;t be told from it.
          </p>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="GitHub releases per day"
          actions={<span className="text-caption text-fg-muted">The counters&rsquo; daily growth</span>}
        >
          <StackedColumns
            label="GitHub release downloads per day"
            height={170}
            columns={ghColumns}
            series={ghSeries}
            empty="Two daily readings are needed for a first figure."
          />
        </Card>
        <Card title="GitHub releases" padded={false}>
          {data.github.tags.length ? (
            <div className="max-h-[300px] overflow-auto">
              <table className="w-full text-footnote tabular">
                <thead className="sticky top-0 bg-surface text-fg-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-normal">Release</th>
                    <th className="px-3 py-2 text-right font-normal">Assets</th>
                    <th className="px-3 py-2 text-right font-normal">Downloads</th>
                    <th className="px-4 py-2 text-right font-normal">In range</th>
                  </tr>
                </thead>
                <tbody>
                  {data.github.tags.map((t) => (
                    <tr key={t.tag} className="border-t border-line-subtle">
                      <td className="px-4 py-1.5 font-mono text-code">{t.tag}</td>
                      <td className="px-3 py-1.5 text-right text-fg-muted">{t.assets}</td>
                      <td className="px-3 py-1.5 text-right">{num(t.downloads)}</td>
                      <td className="px-4 py-1.5 text-right">{t.delta ? `+${num(t.delta)}` : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-8 text-center text-footnote text-fg-muted">
              Not read yet: the admin Worker&rsquo;s daily cron reads them.
            </div>
          )}
        </Card>
      </div>

      <Card title="Files" padded={false}>
        {data.files.length ? (
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full text-footnote tabular">
              <thead className="sticky top-0 bg-surface text-fg-muted">
                <tr>
                  <th className="px-4 py-2 text-left font-normal">File</th>
                  <th className="px-3 py-2 text-left font-normal">Kind</th>
                  <th className="px-4 py-2 text-right font-normal">Count</th>
                </tr>
              </thead>
              <tbody>
                {data.files.map((f) => (
                  <tr key={`${f.file}|${f.kind}`} className="border-t border-line-subtle">
                    <td className="max-w-0 truncate px-4 py-1.5 font-mono text-code" title={f.file}>
                      {f.file}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-fg-secondary">{kindLabel(f.kind)}</td>
                    <td className="px-4 py-1.5 text-right">{num(f.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center text-footnote text-fg-muted">Nothing counted yet.</div>
        )}
      </Card>
    </>
  );
}
