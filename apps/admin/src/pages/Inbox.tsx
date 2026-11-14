/**
 * An inbox: issues or feature requests (they land in separate places). A dense table with search and filters (kept in
 * the address, so Back returns to them), selection, status changes and deletion for many at once, and zips.
 */
import { Activity, FileArchive, Image, MessageSquare, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Confirm, Empty, ErrorNote, Select, Spinner, StatusBadge, cx } from '../components/ui';
import { api, useApi } from '../lib/api';
import { dateTime, num, osLabel, relative, statusLabel } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { saveFile, zipReports } from '../lib/zip';
import type { Kind, ListResponse, Row } from '../types';

const TITLES: Record<Kind, string> = { issue: 'Issues', feature: 'Feature requests' };

function setParam(key: string, value: string) {
  const s = new URLSearchParams(location.search);
  if (value) s.set(key, value);
  else s.delete(key);
  const q = s.toString();
  navigate(`${location.pathname}${q ? `?${q}` : ''}`, { replace: true });
}

/** The API's query for the filters in the address: the default status is "open". */
function queryOf(kind: Kind, search: URLSearchParams): string {
  const s = new URLSearchParams({ kind });
  const status = search.get('status') ?? 'open';
  if (status !== 'all') s.set('status', status);
  for (const key of ['q', 'version', 'os']) {
    const v = search.get(key);
    if (v) s.set(key, v);
  }
  return s.toString();
}

export function Inbox({ kind }: { kind: Kind }) {
  const { search } = useLocation();
  const query = queryOf(kind, search);
  const status = search.get('status') ?? 'open';
  const list = useApi<ListResponse>(`/api/reports?${query}&limit=100`);
  const [more, setMore] = useState<{ rows: Row[]; next: string | null } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState(search.get('q') ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // A new query starts over: no extra pages, nothing selected.
  const [shownQuery, setShownQuery] = useState(query);
  if (shownQuery !== query) {
    setShownQuery(query);
    setMore(null);
    setSelected(new Set());
  }
  // The search box writes to the address after a pause in typing.
  useEffect(() => {
    if (text === (search.get('q') ?? '')) return;
    const t = setTimeout(() => setParam('q', text.trim()), 250);
    return () => clearTimeout(t);
  }, [text, search]);

  const rows = useMemo(() => [...(list.data?.rows ?? []), ...(more?.rows ?? [])], [list.data, more]);
  const next = more ? more.next : (list.data?.next ?? null);
  const facets = list.data?.facets;
  const statuses = list.data?.statuses ?? [];
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const loadMore = async () => {
    if (!next) return;
    const page = await api<ListResponse>(`/api/reports?${query}&limit=100&before=${encodeURIComponent(next)}`);
    setMore((m) => ({ rows: [...(m?.rows ?? []), ...page.rows], next: page.next }));
  };

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const ids = [...selected];
  const zipName = (what: string) =>
    `atelier-${kind === 'issue' ? 'issues' : 'feature-requests'}-${what}-${new Date().toISOString().slice(0, 10)}.zip`;
  const zip = (which: string[], what: string) =>
    run('zip', async () => {
      setBusy(`Collecting 0 of ${which.length}…`);
      const data = await zipReports(which, (done, total) => setBusy(`Collecting ${done} of ${total}…`));
      saveFile(zipName(what), data);
    });
  const zipAll = () =>
    run('zip', async () => {
      setBusy('Listing…');
      const all: string[] = [];
      let cursor: string | null = '';
      while (cursor !== null) {
        const page: ListResponse = await api<ListResponse>(
          `/api/reports?${query}&limit=500${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
        );
        all.push(...page.rows.map((r) => r.id));
        cursor = page.next;
      }
      if (!all.length) throw new Error('No reports match.');
      const data = await zipReports(all, (done, total) => setBusy(`Collecting ${done} of ${total}…`));
      saveFile(zipName('all'), data);
    });
  const setStatus = (value: string) =>
    run('status', async () => {
      await api('/api/reports/bulk', { method: 'POST', body: { ids, action: 'status', status: value } });
      list.reload();
    });
  const remove = () =>
    run('delete', async () => {
      await api('/api/reports/bulk', { method: 'POST', body: { ids, action: 'delete' } });
      setConfirming(false);
      setSelected(new Set());
      list.reload();
    });

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title">
          {TITLES[kind]}
          {list.data && <span className="ml-2 text-body text-fg-muted tabular">{num(list.data.total)}</span>}
        </h1>
        <Button
          icon={<FileArchive size={15} aria-hidden />}
          onClick={zipAll}
          disabled={Boolean(busy) || !list.data?.total}
        >
          Download all matching
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[200px] flex-1">
          <span className="sr-only">Search</span>
          <Search
            size={15}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted"
            aria-hidden
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search titles, descriptions and ids"
            className="h-8 w-full rounded-lg bg-surface pr-2.5 pl-8 text-body shadow-card-ring placeholder:text-fg-muted"
          />
        </label>
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setParam('status', e.target.value === 'open' ? '' : e.target.value)}
        >
          <option value="open">Open</option>
          <option value="all">All</option>
          <option value="unseen">Unread{facets?.unseen ? ` (${facets.unseen})` : ''}</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
              {facets?.statuses[s] ? ` (${facets.statuses[s]})` : ''}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Version"
          value={search.get('version') ?? ''}
          onChange={(e) => setParam('version', e.target.value)}
        >
          <option value="">All versions</option>
          {facets?.versions.map((v) => (
            <option key={v.value} value={v.value}>
              {v.value} ({v.count})
            </option>
          ))}
        </Select>
        <Select aria-label="System" value={search.get('os') ?? ''} onChange={(e) => setParam('os', e.target.value)}>
          <option value="">All systems</option>
          {facets?.os.map((o) => (
            <option key={o.value} value={o.value}>
              {osLabel(o.value)} ({o.count})
            </option>
          ))}
        </Select>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-raised px-3 py-2 shadow-panel">
          <span className="mr-1 text-body-strong tabular">{selected.size} selected</span>
          <Select
            aria-label="Set status"
            value=""
            onChange={(e) => e.target.value && setStatus(e.target.value)}
            disabled={Boolean(busy)}
          >
            <option value="">Set status…</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
          <Button
            icon={<FileArchive size={15} aria-hidden />}
            onClick={() => zip(ids, 'selected')}
            disabled={Boolean(busy)}
          >
            Download zip
          </Button>
          <Button
            variant="quiet-danger"
            icon={<Trash2 size={15} aria-hidden />}
            onClick={() => setConfirming(true)}
            disabled={Boolean(busy)}
          >
            Delete
          </Button>
          <Button variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {busy && busy.includes('…') && <div className="text-footnote text-fg-muted">{busy}</div>}
      {problem && <ErrorNote>{problem}</ErrorNote>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}

      <div className="overflow-hidden rounded-xl bg-surface shadow-card-ring">
        {!list.data && list.loading ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty>
            {search.toString() && search.toString() !== 'status=all'
              ? 'Nothing matches these filters.'
              : kind === 'issue'
                ? 'No issues. Nice.'
                : 'No feature requests yet.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-body">
              <thead className="border-b border-line text-left text-caption text-fg-muted">
                <tr className="h-9">
                  <th className="w-10 pl-3">
                    <Checkbox
                      label="Select all shown"
                      checked={allSelected}
                      indeterminate={!allSelected && selected.size > 0}
                      onChange={(on) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set())}
                    />
                  </th>
                  <th className="hidden w-[92px] font-normal md:table-cell">Id</th>
                  <th className="font-normal">Title</th>
                  <th className="hidden w-[84px] font-normal md:table-cell">Version</th>
                  <th className="hidden w-[150px] font-normal lg:table-cell">System</th>
                  <th className="hidden w-[96px] font-normal md:table-cell">Received</th>
                  <th className="w-[104px] font-normal">Status</th>
                  <th className="hidden w-[76px] pr-3 font-normal md:table-cell">
                    <span className="sr-only">Attachments</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/r/${r.id}`)}
                    className={cx(
                      'border-b border-line-subtle last:border-b-0 hover:bg-fill-ghost-hover md:h-9',
                      selected.has(r.id) && 'bg-fill-ghost-hover',
                    )}
                  >
                    <td className="pl-3">
                      <Checkbox
                        label={`Select ${r.id}`}
                        checked={selected.has(r.id)}
                        onChange={(on) => toggle(r.id, on)}
                      />
                    </td>
                    <td className="hidden font-mono text-caption text-fg-secondary md:table-cell">{r.id}</td>
                    <td className="truncate py-1.5 pr-3 md:py-0">
                      <span className="flex min-w-0 items-center gap-2">
                        {!r.seenAt && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                        <Link
                          href={`/r/${r.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className={cx('truncate', r.seenAt ? 'text-fg' : 'font-semibold text-fg')}
                        >
                          {r.title}
                        </Link>
                        {r.labels.length > 0 && (
                          <span className="hidden shrink-0 gap-1 xl:flex">
                            {r.labels.slice(0, 3).map((l) => (
                              <Badge key={l}>{l}</Badge>
                            ))}
                          </span>
                        )}
                      </span>
                      {/* On a phone, the columns that don't fit go under the title. */}
                      <span className="mt-0.5 block truncate text-caption text-fg-muted md:hidden">
                        <span className="font-mono">{r.id}</span> · {relative(r.receivedAt)} · {r.version}
                        {r.os ? ` · ${osLabel(r.os)}` : ''}
                      </span>
                    </td>
                    <td className="hidden truncate text-footnote text-fg-secondary tabular md:table-cell">
                      {r.version}
                    </td>
                    <td
                      className="hidden truncate pr-2 text-footnote text-fg-secondary lg:table-cell"
                      title={[r.osName, r.arch].filter(Boolean).join(', ')}
                    >
                      {r.os ? `${osLabel(r.os)}${r.arch ? ` ${r.arch}` : ''}` : '–'}
                    </td>
                    <td
                      className="hidden truncate text-footnote text-fg-secondary md:table-cell"
                      title={dateTime(r.receivedAt)}
                    >
                      {relative(r.receivedAt)}
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="hidden pr-3 md:table-cell">
                      <span className="flex items-center justify-end gap-1.5 text-fg-muted">
                        {r.hasDiagnostics && <Activity size={14} aria-label="Diagnostics" />}
                        {r.hasChat && <MessageSquare size={14} aria-label="Chat" />}
                        {r.screenshots > 0 && (
                          <span
                            className="inline-flex items-center gap-0.5"
                            aria-label={`${r.screenshots} screenshots`}
                          >
                            <Image size={14} aria-hidden />
                            <span className="text-caption tabular">{r.screenshots}</span>
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {next && (
        <div className="flex justify-center">
          <Button onClick={() => void loadMore()}>Load more</Button>
        </div>
      )}

      <Confirm
        open={confirming}
        title={`Delete ${selected.size} ${selected.size === 1 ? 'report' : 'reports'}?`}
        action="Delete"
        busy={busy === 'delete'}
        onClose={() => setConfirming(false)}
        onConfirm={remove}
      >
        Their diagnostics, chats and screenshots are deleted too. This can&rsquo;t be undone.
      </Confirm>
    </div>
  );
}
