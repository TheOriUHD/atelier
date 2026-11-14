/** A collapsible view of a JSON value (the redacted settings and preferences): keys and values as text. */
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="text-fg-muted">null</span>;
  if (typeof value === 'string') return <span className="break-words text-code-string">&ldquo;{value}&rdquo;</span>;
  if (typeof value === 'number') return <span className="text-code-type tabular">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-code-keyword">{String(value)}</span>;
  return <span className="text-fg-muted">{String(value)}</span>;
}

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const branch = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 2);
  const label = name !== null && <span className="text-fg-secondary">{name}: </span>;
  if (!branch)
    return (
      <div className="py-px pl-5">
        {label}
        <Leaf value={value} />
      </div>
    );
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-sm py-px text-left hover:bg-fill-ghost-hover"
      >
        <ChevronRight
          size={14}
          className={open ? 'rotate-90 text-fg-muted transition-transform' : 'text-fg-muted transition-transform'}
          aria-hidden
        />
        {label}
        <span className="text-fg-muted">{summary}</span>
      </button>
      {open && (
        <div className="ml-[7px] border-l border-line-subtle pl-2">
          {entries.length ? (
            entries.map(([k, v]) => <Node key={k} name={k} value={v} depth={depth + 1} />)
          ) : (
            <div className="pl-5 text-fg-muted">empty</div>
          )}
        </div>
      )}
    </div>
  );
}

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="overflow-x-auto font-mono text-[12.5px] leading-[19px] select-text">
      <Node name={null} value={value} depth={0} />
    </div>
  );
}
