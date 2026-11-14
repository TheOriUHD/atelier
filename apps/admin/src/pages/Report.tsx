/**
 * One report: its header, the owner's status, labels and private note (saved as typed), and tabs for what it carries.
 * Opening it marks it seen. Everything from the report is shown as text; the chat's assistant markdown goes through
 * lib/markdown.ts.
 */
import { ArrowLeft, FileArchive, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Confirm, CopyButton, ErrorNote, Facts, Select, Spinner, Tabs } from '../components/ui';
import { api, useApi } from '../lib/api';
import { bytes, dateTime, num, osLabel, relative, statusLabel } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { saveFile, zipReports } from '../lib/zip';
import type { DetailResponse, FullRow, ReportChat } from '../types';
import { ChatTab } from './report/ChatTab';
import { JsonTree } from './report/JsonTree';
import { LogsTab } from './report/LogsTab';
import { Screenshots } from './report/Screenshots';
import { SystemTab } from './report/SystemTab';

type Tab = 'description' | 'system' | 'settings' | 'logs' | 'chat' | 'screenshots' | 'raw';

export function ReportPage({ id }: { id: string }) {
  const detail = useApi<DetailResponse>(`/api/reports/${id}`);
  const [tab, setTab] = useState<Tab>('description');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const row = detail.data?.row;
  const chat = useApi<ReportChat>(row?.hasChat && (tab === 'chat' || tab === 'raw') ? `/api/reports/${id}/chat` : null);

  const update = (next: FullRow) => detail.setData((d) => (d ? { ...d, row: next } : d));
  const patch = async (body: Record<string, unknown>) => {
    setProblem(null);
    try {
      const res = await api<{ row: FullRow }>(`/api/reports/${id}`, { method: 'PATCH', body });
      update(res.row);
      return true;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  // Opening a report marks it seen, once.
  const marked = useRef(false);
  useEffect(() => {
    if (!row || row.seenAt || marked.current) return;
    marked.current = true;
    void patch({ seen: true });
  });

  if (detail.error) return <ErrorNote>{detail.error}</ErrorNote>;
  if (!detail.data || !row) return <Spinner />;
  const { report, files, statuses } = detail.data;
  const d = report?.diagnostics;
  const back =
    row.kind === 'issue' ? { href: '/issues', label: 'Issues' } : { href: '/features', label: 'Feature requests' };

  const download = async () => {
    setBusy('zip');
    try {
      saveFile(`${row.id}.zip`, await zipReports([row.id]));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await api(`/api/reports/${row.id}`, { method: 'DELETE' });
      navigate(back.href);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(null);
      setConfirming(false);
    }
  };

  const tabs: { id: Tab; label: string; count?: number | null; disabled?: boolean }[] = [
    { id: 'description', label: 'Description' },
    { id: 'system', label: 'System', disabled: !d },
    { id: 'settings', label: 'Settings', disabled: d?.settings === undefined && d?.prefs === undefined },
    { id: 'logs', label: 'Logs', count: d?.log?.length ?? null, disabled: !d?.log?.length && !d?.lastError },
    { id: 'chat', label: 'Chat', disabled: !row.hasChat },
    { id: 'screenshots', label: 'Screenshots', count: files.length || null, disabled: files.length === 0 },
    { id: 'raw', label: 'Raw' },
  ];

  return (
    <div className="space-y-5">
      <Link href={back.href} className="inline-flex items-center gap-1 text-footnote text-fg-secondary hover:text-fg">
        <ArrowLeft size={14} aria-hidden />
        {back.label}
      </Link>

      <header className="space-y-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <h1 className="min-w-0 flex-1 text-title break-words" data-selectable>
            {row.title}
          </h1>
          <div className="flex shrink-0 gap-2">
            <Button
              icon={<FileArchive size={15} aria-hidden />}
              onClick={() => void download()}
              disabled={Boolean(busy)}
            >
              {busy === 'zip' ? 'Zipping…' : 'Download zip'}
            </Button>
            <Button variant="quiet-danger" icon={<Trash2 size={15} aria-hidden />} onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-fg-secondary">
          <span className="inline-flex items-center gap-0.5">
            <span className="font-mono text-fg">{row.id}</span>
            <CopyButton text={row.id} label="Copy the id" />
          </span>
          <Badge tone={row.kind === 'issue' ? 'neutral' : 'clay'}>
            {row.kind === 'issue' ? 'Issue' : 'Feature request'}
          </Badge>
          <span title={dateTime(row.receivedAt)}>
            Received {dateTime(row.receivedAt)} <span className="text-fg-muted">({relative(row.receivedAt)})</span>
          </span>
          <span>
            Atelier {row.version}
            {report?.app.channel && report.app.channel !== 'stable' ? ` (${report.app.channel})` : ''}
          </span>
          {row.os && <span>{[row.osName ?? osLabel(row.os), row.arch].filter(Boolean).join(', ')}</span>}
          {row.contact && (
            <span className="inline-flex items-center gap-1">
              <span className="text-fg-muted">Contact</span>
              <span className="text-fg select-text">{row.contact}</span>
              <CopyButton text={row.contact} label="Copy the contact" />
            </span>
          )}
        </div>
      </header>

      {problem && <ErrorNote>{problem}</ErrorNote>}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Tabs value={tab} tabs={tabs} onChange={setTab} />
          {tab === 'description' && (
            <div className="rounded-xl bg-surface p-5 shadow-card-ring">
              <p className="font-serif text-prose break-words whitespace-pre-wrap select-text">{row.description}</p>
            </div>
          )}
          {tab === 'system' && report && <SystemTab report={report} />}
          {tab === 'settings' && d && (
            <div className="space-y-4">
              {d.settings !== undefined && (
                <Card
                  title="Settings"
                  actions={<span className="text-caption text-fg-muted">Redacted before sending</span>}
                >
                  <JsonTree value={d.settings} />
                </Card>
              )}
              {d.prefs !== undefined && (
                <Card title="Preferences">
                  <JsonTree value={d.prefs} />
                </Card>
              )}
            </div>
          )}
          {tab === 'logs' && d && <LogsTab log={d.log ?? []} lastError={d.lastError} />}
          {tab === 'chat' &&
            (chat.error ? (
              <ErrorNote>{chat.error}</ErrorNote>
            ) : chat.data ? (
              <ChatTab chat={chat.data} />
            ) : (
              <Spinner label="Loading the chat" />
            ))}
          {tab === 'screenshots' && (
            <Screenshots id={row.id} files={files} info={report?.attachments.screenshots ?? []} />
          )}
          {tab === 'raw' && <Raw report={report} chat={chat.data} hasChat={row.hasChat} />}
        </div>
        <Side row={row} statuses={statuses} patch={patch} />
      </div>

      <Confirm
        open={confirming}
        title={`Delete ${row.id}?`}
        action="Delete"
        busy={busy === 'delete'}
        onClose={() => setConfirming(false)}
        onConfirm={() => void remove()}
      >
        The report, its diagnostics, chat and screenshots are deleted. This can&rsquo;t be undone.
      </Confirm>
    </div>
  );
}

/** Status, labels and the private note: what the owner keeps about a report. */
function Side({
  row,
  statuses,
  patch,
}: {
  row: FullRow;
  statuses: string[];
  patch: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [label, setLabel] = useState('');
  const [note, setNote] = useState(row.note);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const latest = useRef(note);
  useEffect(() => {
    latest.current = note;
  });

  // The note saves itself a moment after typing stops, and on leaving the page.
  useEffect(() => {
    if (note === row.note) return;
    const t = setTimeout(() => {
      void patch({ note }).then((ok) => setSaved(ok ? 'saved' : 'failed'));
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);
  useEffect(
    () => () => {
      if (latest.current !== row.note) void patch({ note: latest.current });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const addLabel = () => {
    const l = label.trim();
    if (!l) return;
    setLabel('');
    if (!row.labels.some((x) => x.toLowerCase() === l.toLowerCase())) void patch({ labels: [...row.labels, l] });
  };

  return (
    <aside className="space-y-4 rounded-xl bg-surface p-4 shadow-card-ring xl:sticky xl:top-4">
      <label className="block space-y-1.5">
        <span className="text-footnote text-fg-muted">Status</span>
        <Select className="w-full" value={row.status} onChange={(e) => void patch({ status: e.target.value })}>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </Select>
      </label>
      <div className="space-y-1.5">
        <span className="text-footnote text-fg-muted">Labels</span>
        <div className="flex flex-wrap gap-1.5">
          {row.labels.map((l) => (
            <span
              key={l}
              className="inline-flex h-6 items-center gap-1 rounded-md bg-badge-bg pr-1 pl-2 text-caption text-fg-secondary"
            >
              {l}
              <button
                type="button"
                aria-label={`Remove ${l}`}
                className="rounded-sm p-0.5 hover:bg-fill-ghost-hover"
                onClick={() => void patch({ labels: row.labels.filter((x) => x !== l) })}
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addLabel();
              }
            }}
            onBlur={addLabel}
            maxLength={40}
            placeholder={row.labels.length ? 'Add…' : 'Add a label…'}
            aria-label="Add a label"
            className="h-6 min-w-24 flex-1 rounded-md bg-transparent px-1 text-caption placeholder:text-fg-muted"
          />
        </div>
      </div>
      <label className="block space-y-1.5">
        <span className="flex items-center justify-between text-footnote text-fg-muted">
          Private note
          <span className="text-caption" aria-live="polite">
            {saved === 'saving' ? (
              'Saving…'
            ) : saved === 'saved' ? (
              'Saved'
            ) : saved === 'failed' ? (
              <span className="text-danger-text">Not saved</span>
            ) : (
              ''
            )}
          </span>
        </span>
        <textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setSaved('saving');
          }}
          rows={6}
          maxLength={20_000}
          placeholder="Only you see this."
          className="w-full resize-y rounded-lg bg-fill-field px-2.5 py-2 text-footnote shadow-card-ring placeholder:text-fg-muted"
        />
      </label>
      <div className="border-t border-line-subtle pt-3">
        <Facts
          rows={[
            ['Mode', row.mode],
            ['Surface', row.surface],
            ['Size', bytes(row.bytes)],
            [
              'Scrubbed',
              row.scrubbed ? `${num(row.scrubbed)} secret${row.scrubbed === 1 ? '' : 's'} the app left in` : null,
            ],
            ['Changed', row.updatedAt !== row.receivedAt ? relative(row.updatedAt) : null],
            ['Opened', row.seenAt ? relative(row.seenAt) : null],
          ]}
        />
      </div>
    </aside>
  );
}

function Raw({ report, chat, hasChat }: { report: unknown; chat: ReportChat | null; hasChat: boolean }) {
  const [which, setWhich] = useState<'report' | 'chat'>('report');
  const value = which === 'report' ? report : chat;
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return (
    <Card
      title={which === 'report' ? 'report.json' : 'chat.json'}
      padded={false}
      actions={
        <>
          {hasChat && (
            <Select aria-label="File" value={which} onChange={(e) => setWhich(e.target.value as 'report' | 'chat')}>
              <option value="report">report.json</option>
              <option value="chat">chat.json</option>
            </Select>
          )}
          <CopyButton text={text} label="Copy the JSON" />
        </>
      }
    >
      <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-[12.5px] leading-[19px] break-words whitespace-pre-wrap select-text">
        {which === 'chat' && !chat ? 'Loading…' : text}
      </pre>
    </Card>
  );
}
