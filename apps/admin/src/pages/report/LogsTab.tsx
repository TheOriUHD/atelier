/** The end of the desktop's log, with a filter and the last error highlighted. */
import { Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Card } from '../../components/ui';
import { dateTime } from '../../lib/format';

/** The line that holds the last error: the one naming `lastError`'s message, else the last that says error. */
export function lastErrorLine(log: string[], message?: string): number {
  const needle = message?.split('\n')[0]?.slice(0, 80).trim();
  if (needle) {
    for (let i = log.length - 1; i >= 0; i--) if (log[i]!.includes(needle)) return i;
  }
  for (let i = log.length - 1; i >= 0; i--)
    if (/(?:error|exception)\b|\b(?:fatal|uncaught|unhandled)\b/i.test(log[i]!)) return i;
  return -1;
}

export function LogsTab({
  log,
  lastError,
}: {
  log: string[];
  lastError?: { message: string; at: number } | undefined;
}) {
  const [filter, setFilter] = useState('');
  const marked = useMemo(() => lastErrorLine(log, lastError?.message), [log, lastError]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return log.map((text, i) => ({ text, i })).filter((l) => !f || l.text.toLowerCase().includes(f));
  }, [log, filter]);
  return (
    <div className="space-y-4">
      {lastError && (
        <div className="rounded-xl bg-danger-subtle p-4 text-danger-text">
          <div className="flex items-center gap-1.5 text-footnote font-medium">
            <TriangleAlert size={14} aria-hidden />
            Last error, {dateTime(lastError.at)}
          </div>
          <pre className="mt-2 font-mono text-[12.5px] leading-[19px] break-words whitespace-pre-wrap select-text">
            {lastError.message}
          </pre>
        </div>
      )}
      <Card
        title={`Log, last ${log.length} lines`}
        padded={false}
        actions={
          <label className="relative">
            <span className="sr-only">Filter the log</span>
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-muted"
              aria-hidden
            />
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter"
              className="h-7 w-44 rounded-md bg-fill-field pr-2 pl-7 text-control-sm shadow-card-ring placeholder:text-fg-muted"
            />
          </label>
        }
      >
        {log.length === 0 ? (
          <div className="p-4 text-footnote text-fg-muted">No log lines came with this report.</div>
        ) : (
          <div className="max-h-[70vh] overflow-auto py-2 font-mono text-[12px] leading-[18px] select-text">
            {shown.map(({ text, i }) => (
              <div
                key={i}
                className={i === marked ? 'flex bg-danger-subtle text-danger-text' : 'flex hover:bg-fill-ghost-hover'}
              >
                <span className="w-12 shrink-0 pr-3 text-right text-fg-muted tabular select-none">{i + 1}</span>
                <span className="min-w-0 flex-1 pr-4 break-words whitespace-pre-wrap">{text}</span>
              </div>
            ))}
            {shown.length === 0 && <div className="px-4 py-2 text-fg-muted">No line has &ldquo;{filter}&rdquo;.</div>}
          </div>
        )}
      </Card>
    </div>
  );
}
