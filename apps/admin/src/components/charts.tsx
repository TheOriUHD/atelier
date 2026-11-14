/**
 * Small hand-drawn SVG charts: stacked columns per day (with a tooltip per day and a table view) and bar lists. Thin
 * marks, a 2 px surface gap between stacked segments, 4 px rounded tops, a hairline grid, clean tick values, a legend
 * whenever there are two series or more, and text in the text colors (the marks carry the series colors).
 */
import { Table2, ChartColumn } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { compact, dayLabel, num } from '../lib/format';
import { cx } from './ui';

export interface Series {
  id: string;
  label: string;
  color: string;
}
export interface Column {
  day: string;
  values: Record<string, number>;
}

/** Tick values from 0 to past `max`: steps of 1, 2 or 5 times a power of ten. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
  const ticks = [0];
  while (ticks.at(-1)! < max) ticks.push(ticks.at(-1)! + step);
  return ticks;
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-fg-secondary">
      {series.map((s) => (
        <li key={s.id} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** A path for a column segment with rounded top corners. */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function StackedColumns({
  columns,
  series,
  height = 200,
  label,
  empty = 'Nothing counted in this range yet.',
}: {
  columns: Column[];
  series: Series[];
  height?: number;
  label: string;
  empty?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const used = useMemo(() => series.filter((s) => columns.some((c) => (c.values[s.id] ?? 0) > 0)), [series, columns]);
  const totals = columns.map((c) => used.reduce((n, s) => n + (c.values[s.id] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const m = { left: 40, right: 6, top: 8, bottom: 22 };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;
  const band = columns.length ? innerW / columns.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const labelEvery = Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor(innerW / 64))));
  const y = (v: number) => m.top + innerH - (v / top) * innerH;

  const toggle = (
    <button
      type="button"
      onClick={() => setTable((t) => !t)}
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-caption text-fg-muted hover:bg-fill-ghost-hover hover:text-fg"
      aria-pressed={table}
    >
      {table ? <ChartColumn size={13} aria-hidden /> : <Table2 size={13} aria-hidden />}
      {table ? 'Chart' : 'Table'}
    </button>
  );

  return (
    <div className="space-y-3" ref={ref}>
      {max === 0 ? (
        <div className="flex h-[120px] items-center justify-center text-footnote text-fg-muted">{empty}</div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <Legend series={used} />
            <div className="ml-auto">{toggle}</div>
          </div>
          {table ? (
            <div className="max-h-[320px] overflow-auto rounded-lg shadow-card-ring">
              <table className="w-full text-footnote tabular">
                <thead className="sticky top-0 bg-surface text-fg-muted">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-normal">Day</th>
                    {used.map((s) => (
                      <th key={s.id} className="px-3 py-1.5 text-right font-normal">
                        {s.label}
                      </th>
                    ))}
                    <th className="px-3 py-1.5 text-right font-normal">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c, i) => (
                    <tr key={c.day} className="border-t border-line-subtle">
                      <td className="px-3 py-1">{dayLabel(c.day, true)}</td>
                      {used.map((s) => (
                        <td key={s.id} className="px-3 py-1 text-right">
                          {num(c.values[s.id] ?? 0)}
                        </td>
                      ))}
                      <td className="px-3 py-1 text-right font-medium">{num(totals[i])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="relative" onMouseLeave={() => setHover(null)}>
              {width > 0 && (
                <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
                  {ticks.map((t) => (
                    <g key={t}>
                      <line
                        x1={m.left}
                        x2={width - m.right}
                        y1={y(t)}
                        y2={y(t)}
                        stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'}
                        strokeWidth={1}
                        shapeRendering="crispEdges"
                      />
                      <text
                        x={m.left - 8}
                        y={y(t)}
                        dy="0.32em"
                        textAnchor="end"
                        className="fill-fg-muted text-[11px] tabular"
                      >
                        {compact(t)}
                      </text>
                    </g>
                  ))}
                  {columns.map((c, i) => {
                    const x = m.left + i * band + (band - barW) / 2;
                    let acc = 0;
                    const segments = used.filter((s) => (c.values[s.id] ?? 0) > 0);
                    return (
                      <g key={c.day} opacity={hover === null || hover === i ? 1 : 0.55}>
                        {segments.map((s, j) => {
                          const v = c.values[s.id] ?? 0;
                          const y0 = y(acc);
                          const y1 = y(acc + v);
                          acc += v;
                          const last = j === segments.length - 1;
                          // The surface gap: each segment above another gives up 2 px at its bottom.
                          const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                          if (h <= 0) return null;
                          return last ? (
                            <path key={s.id} d={roundedTop(x, y1, barW, h, 4)} fill={s.color} />
                          ) : (
                            <rect key={s.id} x={x} y={y1} width={barW} height={h} fill={s.color} />
                          );
                        })}
                      </g>
                    );
                  })}
                  {columns.map((c, i) =>
                    i % labelEvery === 0 ? (
                      <text
                        key={c.day}
                        x={m.left + i * band + band / 2}
                        y={height - 6}
                        textAnchor="middle"
                        className="fill-fg-muted text-[11px]"
                      >
                        {dayLabel(c.day)}
                      </text>
                    ) : null,
                  )}
                  {columns.map((c, i) => (
                    <rect
                      key={c.day}
                      x={m.left + i * band}
                      y={m.top}
                      width={band}
                      height={innerH}
                      fill="transparent"
                      onMouseEnter={() => setHover(i)}
                      onMouseMove={() => setHover(i)}
                    />
                  ))}
                </svg>
              )}
              {hover !== null && columns[hover] && (
                <div
                  className="pointer-events-none absolute z-10 w-44 rounded-lg bg-popover px-3 py-2 text-caption shadow-popover"
                  // Beside the hovered column, never over it: to its right, or to its left near the right edge.
                  style={
                    m.left + (hover + 1) * band + 8 + 176 <= width
                      ? { left: m.left + (hover + 1) * band + 8, top: 4 }
                      : { left: Math.max(0, m.left + hover * band - 8 - 176), top: 4 }
                  }
                >
                  <div className="mb-1 font-medium text-fg">{dayLabel(columns[hover].day, true)}</div>
                  {used
                    .filter((s) => (columns[hover]!.values[s.id] ?? 0) > 0)
                    .map((s) => (
                      <div key={s.id} className="flex items-center justify-between gap-4 text-fg-secondary">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="size-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
                          {s.label}
                        </span>
                        <span className="text-fg tabular">{num(columns[hover]!.values[s.id])}</span>
                      </div>
                    ))}
                  {used.length > 1 && (
                    <div className="mt-1 flex justify-between border-t border-line-subtle pt-1 text-fg">
                      <span>Total</span>
                      <span className="font-medium tabular">{num(totals[hover])}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Labelled horizontal bars: top versions, countries, files. */
export function BarList({
  rows,
  color = 'var(--viz-1)',
  empty = 'Nothing yet.',
  format = num,
}: {
  rows: { label: ReactNode; value: number; key: string; note?: ReactNode }[];
  color?: string;
  empty?: ReactNode;
  format?: (n: number) => string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) return <div className="py-6 text-center text-footnote text-fg-muted">{empty}</div>;
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-footnote">
          <div className="relative h-6 min-w-0">
            <div
              className="absolute inset-y-0.5 left-0 rounded-r-[4px] opacity-25"
              style={{ width: `${(r.value / max) * 100}%`, background: color }}
              aria-hidden
            />
            <div className="relative flex h-full items-center gap-2 truncate px-2">
              <span className="truncate text-fg">{r.label}</span>
              {r.note && <span className="truncate text-fg-muted">{r.note}</span>}
            </div>
          </div>
          <span className={cx('text-right text-fg tabular')}>{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
