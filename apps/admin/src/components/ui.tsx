/**
 * The panel's controls, after Atelier's (design/components.md): 28/32 px controls, ghost hover, the focus ring only
 * from the keyboard, primary in ink, secondary on a hairline ring. Everything shows report content as text.
 */
import { Check, ChevronDown, Copy, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { statusLabel } from '../lib/format';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet-danger' | 'overlay';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-fill-primary text-on-primary hover:bg-fill-primary-hover',
  secondary: 'bg-surface text-fg shadow-card-ring hover:bg-fill-ghost-hover',
  ghost: 'text-fg-secondary hover:bg-fill-ghost-hover hover:text-fg',
  danger: 'bg-danger text-on-accent hover:bg-danger-hover',
  'quiet-danger': 'text-danger-text hover:bg-danger-subtle',
  /** On the lightbox's dark backdrop, in either theme. */
  overlay: 'text-[#fff] hover:bg-[rgba(255,255,255,0.12)]',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background-color,box-shadow] duration-100 disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' ? 'h-7 rounded-md px-2.5 text-control-sm' : 'h-8 rounded-lg px-3 text-body',
        !children && (size === 'sm' ? 'w-7 px-0' : 'w-8 px-0'),
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx('relative inline-flex', className)}>
      <select
        className="h-8 w-full min-w-0 appearance-none truncate rounded-lg bg-surface pr-7 pl-2.5 text-body text-fg shadow-card-ring hover:bg-fill-ghost-hover"
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-fg-muted"
        aria-hidden
      />
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'clay';
  className?: string;
  title?: string;
}) {
  const tones = {
    neutral: 'bg-badge-bg text-fg-secondary',
    blue: 'bg-interactive-subtle text-interactive-text',
    green: 'bg-success-subtle text-success-text',
    amber: 'bg-warning-subtle text-warning-text',
    red: 'bg-danger-subtle text-danger-text',
    clay: 'bg-[color-mix(in_srgb,var(--at-color-accent)_14%,transparent)] text-accent',
  };
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-[18px] shrink-0 items-center gap-1 rounded-xs px-1.5 text-badge whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'clay'> = {
  new: 'blue',
  triaged: 'amber',
  planned: 'amber',
  'in-progress': 'clay',
  fixed: 'green',
  done: 'green',
  'wont-fix': 'neutral',
  declined: 'neutral',
  duplicate: 'neutral',
};
export const StatusBadge = ({ status }: { status: string }) => (
  <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{statusLabel(status)}</Badge>
);

export function Card({
  title,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cx('min-w-0 rounded-xl bg-surface shadow-card-ring', className)}>
      {(title || actions) && (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line-subtle px-4 py-2">
          <h2 className="truncate text-section-heading">{title}</h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('@container', padded && 'p-4')}>{children}</div>
    </section>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-segmented-track p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-control-sm',
            value === o.value ? 'bg-segmented-thumb text-fg shadow-sm' : 'text-fg-secondary hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="size-4 accent-[var(--at-color-fill-primary)]"
    />
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: { id: T; label: string; count?: number | null; disabled?: boolean }[];
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="-mx-1 flex gap-0.5 overflow-x-auto border-b border-line px-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-body disabled:opacity-40',
            value === t.id ? 'border-fg font-medium text-fg' : 'border-transparent text-fg-secondary hover:text-fg',
          )}
        >
          {t.label}
          {t.count != null && <span className="text-caption text-fg-muted tabular">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <div className="flex items-center gap-2 py-10 text-footnote text-fg-muted" role="status">
    <LoaderCircle size={16} className="animate-spin" aria-hidden />
    {label}…
  </div>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="py-10 text-center text-footnote text-fg-muted">{children}</div>
);

export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <div
    role="alert"
    className="flex items-start gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-footnote text-danger-text"
  >
    <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
    <div className="min-w-0">{children}</div>
  </div>
);

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      title={label}
      aria-label={label}
      icon={done ? <Check size={14} /> : <Copy size={14} />}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    />
  );
}

/** A modal that asks before something that can't be undone. */
export function Confirm({
  open,
  title,
  children,
  action,
  onConfirm,
  onClose,
  busy,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(420px,calc(100vw-32px))] rounded-2xl bg-popover p-0 text-fg shadow-popover backdrop:bg-backdrop"
    >
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-section-heading">{title}</h2>
          <Button size="sm" variant="ghost" aria-label="Close" icon={<X size={14} />} onClick={onClose} />
        </div>
        <div className="mt-2 text-body text-fg-secondary">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : action}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

/** A bar that fills to `value / max`, amber past 75 %, red past 90 %. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  const tone = share > 0.9 ? 'bg-danger' : share > 0.75 ? 'bg-warning' : 'bg-fg-secondary';
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className="h-1.5 w-full overflow-hidden rounded-full bg-fill-control"
    >
      <div
        className={cx('h-full rounded-full', tone)}
        style={{ width: `${Math.max(share * 100, share > 0 ? 1.5 : 0)}%` }}
      />
    </div>
  );
}

/** A figure with its label: the overview's tiles. */
export function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-surface p-4 shadow-card-ring">
      <div className="flex items-center gap-1.5 text-footnote text-fg-muted">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 truncate text-title tabular">{value}</div>
      {sub && <div className="mt-0.5 truncate text-caption text-fg-muted">{sub}</div>}
    </div>
  );
}

/** Label/value rows, for the system cards. Values are text. */
export function Facts({ rows, columns = 1 }: { rows: [string, ReactNode][]; columns?: 1 | 2 }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  if (!shown.length) return <div className="text-footnote text-fg-muted">Nothing reported.</div>;
  return (
    <dl
      className={cx(
        'grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 gap-y-1.5 text-footnote',
        // Two label/value pairs per line where the card is wide enough.
        columns === 2 && '@xl:grid-cols-[minmax(96px,max-content)_1fr_minmax(96px,max-content)_1fr]',
      )}
    >
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
