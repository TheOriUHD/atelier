/**
 * Which of a Code session's panes are open, how they tile beside the transcript and how big each is
 * (design/components.md › Code panes). Pure, so the dock, its splitters and the tests share one set of rules.
 *
 * Tiling: panes fill columns from left to right, two stacked to a column. A pane opens under the last column's
 * single pane, else in a new column on the right while one more column fits beside the transcript, else in the
 * column with the fewest panes (the rightmost of those). Closing a pane gives its room to the rest of its column,
 * and an empty column's room to the other columns. When the window gets too narrow for the columns, they are tiled
 * again into fewer (`fitColumns`) without changing what is stored, so widening the window brings them back.
 */
import type { CSSProperties } from 'react';

export type PaneId = 'terminal' | 'diff' | 'browser' | 'files' | 'tasks' | 'plan' | 'artifact' | 'side';

export const PANES: readonly PaneId[] = ['terminal', 'diff', 'browser', 'files', 'tasks', 'plan', 'artifact', 'side'];

export interface PaneLayout {
  /** Columns left to right, each with its panes top to bottom. */
  columns: PaneId[][];
  /** The dock's share of the session's width, beside the transcript. */
  dock: number;
  /** Each column's share of the dock's width (they add up to 1). */
  widths: number[];
  /** Per column, each pane's share of its height (they add up to 1). */
  heights: number[][];
  /** A pane filling the whole dock, the others hidden behind it. */
  maximized: PaneId | null;
  /** The pane opened or used last: the one a narrow window shows as a sheet. */
  active: PaneId | null;
}

export const EMPTY_LAYOUT: PaneLayout = { columns: [], dock: 0, widths: [], heights: [], maximized: null, active: null };

/** Panes stacked in a column before a new column is started (while one fits). */
export const STACK = 2;
/** Room the transcript keeps beside the dock. */
export const MIN_TRANSCRIPT_PX = 400;
export const MIN_COLUMN_PX = 320;
export const MIN_PANE_HEIGHT_PX = 120;
/** Between panes, and between the dock and the window's edges. */
export const GAP_PX = 8;

const DOCK_SHARES = [0.5, 0.64, 0.74];

/** The dock's share of the width for `columns` columns, before anyone resizes it. */
export function defaultDock(columns: number): number {
  return columns === 0 ? 0 : DOCK_SHARES[Math.min(columns, DOCK_SHARES.length) - 1]!;
}

/** Below the comfortable sizes one column still tiles, squeezed to half, down to this width (a split view's smallest half is 360). */
export const MIN_TILED_PX = 340;

/**
 * How many columns fit beside the transcript in `width` px: as many as keep the transcript and the columns at their
 * minimums, else one squeezed column, down to `MIN_TILED_PX` (0: not even that; panes then open as a sheet).
 */
export function columnsFor(width: number): number {
  const comfortable = Math.max(0, Math.floor((width - MIN_TRANSCRIPT_PX - GAP_PX) / (MIN_COLUMN_PX + GAP_PX)));
  if (comfortable > 0) return comfortable;
  return width >= MIN_TILED_PX ? 1 : 0;
}

const even = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

export const isOpen = (layout: PaneLayout, pane: PaneId): boolean => layout.columns.some((c) => c.includes(pane));

export const openPanes = (layout: PaneLayout): PaneId[] => layout.columns.flat();

/** Where `pane` goes among `columns` (see the module comment); returns new columns. */
function place(columns: PaneId[][], pane: PaneId, maxColumns: number): PaneId[][] {
  const last = columns.at(-1);
  if (!last) return [[pane]];
  if (last.length < STACK) return [...columns.slice(0, -1), [...last, pane]];
  if (columns.length < Math.max(1, maxColumns)) return [...columns, [pane]];
  let target = 0;
  columns.forEach((c, i) => {
    if (c.length <= columns[target]!.length) target = i;
  });
  return columns.map((c, i) => (i === target ? [...c, pane] : c));
}

/** `panes` tiled from scratch into at most `maxColumns` columns, at even sizes. */
export function tile(panes: readonly PaneId[], maxColumns: number, base: Pick<PaneLayout, 'maximized' | 'active'> = { maximized: null, active: null }): PaneLayout {
  let columns: PaneId[][] = [];
  for (const pane of panes) columns = place(columns, pane, maxColumns);
  return { columns, dock: defaultDock(columns.length), widths: even(columns.length), heights: columns.map((c) => even(c.length)), maximized: base.maximized, active: base.active };
}

/** The layout as a window `maxColumns` wide can show it: tiled again into fewer columns when it has too many. */
export function fitColumns(layout: PaneLayout, maxColumns: number): PaneLayout {
  if (layout.columns.length <= Math.max(1, maxColumns)) return layout;
  return tile(openPanes(layout), maxColumns, layout);
}

export type LayoutAction =
  | { type: 'open'; pane: PaneId; maxColumns: number }
  | { type: 'close'; pane: PaneId }
  | { type: 'closeOthers'; pane: PaneId }
  | { type: 'toggleMaximize'; pane: PaneId }
  | { type: 'activate'; pane: PaneId }
  | { type: 'resizeDock'; dock: number }
  | { type: 'resizeColumns'; widths: number[] }
  | { type: 'resizeRows'; column: number; heights: number[] }
  | { type: 'resetDock' }
  | { type: 'resetColumns' }
  | { type: 'resetRows'; column: number }
  /** Keeps a layout as it is shown: a window too narrow for the stored columns, resized by hand. */
  | { type: 'adopt'; layout: PaneLayout };

export function layoutReducer(layout: PaneLayout, action: LayoutAction): PaneLayout {
  switch (action.type) {
    case 'open': {
      // Opening another pane shows it: a maximized one steps back.
      if (isOpen(layout, action.pane)) return { ...layout, active: action.pane, maximized: layout.maximized === action.pane ? layout.maximized : null };
      const columns = place(layout.columns, action.pane, action.maxColumns);
      const added = columns.length > layout.columns.length;
      const n = columns.length;
      return {
        columns,
        // A new column takes an even share; the dock grows to make room for it.
        dock: added ? defaultDock(n) : layout.dock,
        widths: added ? [...layout.widths.map((w) => (w * (n - 1)) / n), 1 / n] : layout.widths,
        heights: columns.map((c, i) => (c.length === layout.columns[i]?.length ? layout.heights[i]! : even(c.length))),
        maximized: null,
        active: action.pane,
      };
    }
    case 'close': {
      const at = layout.columns.findIndex((c) => c.includes(action.pane));
      if (at === -1) return layout;
      const rest = layout.columns[at]!.filter((p) => p !== action.pane);
      const remaining = openPanes(layout).filter((p) => p !== action.pane);
      const active = layout.active === action.pane ? (remaining.at(-1) ?? null) : layout.active;
      const maximized = layout.maximized === action.pane ? null : layout.maximized;
      if (rest.length) {
        const columns = layout.columns.map((c, i) => (i === at ? rest : c));
        const heights = layout.heights.map((h, i) => (i === at ? normalize(h.filter((_, j) => layout.columns[at]![j] !== action.pane)) : h));
        return { ...layout, columns, heights, maximized, active };
      }
      const columns = layout.columns.filter((_, i) => i !== at);
      return {
        columns,
        dock: columns.length ? defaultDock(columns.length) : 0,
        widths: normalize(layout.widths.filter((_, i) => i !== at)),
        heights: layout.heights.filter((_, i) => i !== at),
        maximized,
        active,
      };
    }
    case 'closeOthers':
      return isOpen(layout, action.pane) ? { ...tile([action.pane], 1), active: action.pane } : layout;
    case 'toggleMaximize':
      return isOpen(layout, action.pane) ? { ...layout, maximized: layout.maximized === action.pane ? null : action.pane, active: action.pane } : layout;
    case 'activate':
      return isOpen(layout, action.pane) && layout.active !== action.pane ? { ...layout, active: action.pane } : layout;
    case 'resizeDock':
      return { ...layout, dock: clamp(action.dock, 0.1, 0.9) };
    case 'resizeColumns':
      return action.widths.length === layout.columns.length ? { ...layout, widths: normalize(action.widths) } : layout;
    case 'resizeRows':
      return action.heights.length === layout.columns[action.column]?.length
        ? { ...layout, heights: layout.heights.map((h, i) => (i === action.column ? normalize(action.heights) : h)) }
        : layout;
    case 'resetDock':
      return { ...layout, dock: defaultDock(layout.columns.length) };
    case 'resetColumns':
      return { ...layout, widths: even(layout.columns.length) };
    case 'resetRows':
      return { ...layout, heights: layout.heights.map((h, i) => (i === action.column ? even(h.length) : h)) };
    case 'adopt':
      return action.layout;
  }
}

/**
 * What a change made to the layout as shown means for the one stored: when the window shows the stored layout tiled
 * into fewer columns, a resize there keeps the shown layout with the new sizes; anything else applies as it is.
 */
export function shownAction(stored: PaneLayout, shown: PaneLayout, action: LayoutAction): LayoutAction {
  const resize = action.type === 'resizeColumns' || action.type === 'resizeRows' || action.type === 'resetColumns' || action.type === 'resetRows';
  return resize && shown !== stored ? { type: 'adopt', layout: layoutReducer(shown, action) } : action;
}

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

function normalize(shares: number[]): number[] {
  const total = shares.reduce((a, b) => a + b, 0);
  return total > 0 ? shares.map((s) => s / total) : even(shares.length);
}

/**
 * Two neighbours' shares with the line between them moved: `value` is the first one's part of their total (0–1).
 * The other shares stay as they are.
 */
export function moveSplit(shares: readonly number[], index: number, value: number): number[] {
  const total = shares[index]! + shares[index + 1]!;
  return shares.map((s, i) => (i === index ? total * value : i === index + 1 ? total * (1 - value) : s));
}

/** The first of two neighbours' part of their total (where the line between them sits, 0–1). */
export const splitOf = (shares: readonly number[], index: number): number => shares[index]! / (shares[index]! + shares[index + 1]!);

const sum = (shares: readonly number[], end: number) => shares.slice(0, end).reduce((a, b) => a + b, 0);

/** Positions along one axis of the dock: `n` items sharing its length minus the gaps between them. */
function along(shares: readonly number[], index: number): { start: string; size: string } {
  const room = `(100% - ${(shares.length - 1) * GAP_PX}px)`;
  return { start: `calc(${room} * ${sum(shares, index)} + ${index * GAP_PX}px)`, size: `calc(${room} * ${shares[index]})` };
}

/** Where a pane sits in the dock, as CSS for an absolutely positioned card. */
export function paneStyle(layout: PaneLayout, pane: PaneId): CSSProperties {
  if (layout.maximized === pane) return { left: 0, top: 0, width: '100%', height: '100%' };
  const column = layout.columns.findIndex((c) => c.includes(pane));
  if (column === -1) return {};
  const x = along(layout.widths, column);
  const y = along(layout.heights[column]!, layout.columns[column]!.indexOf(pane));
  return { left: x.start, width: x.size, top: y.start, height: y.size };
}

/** The gap between column `index` and the next, where its splitter sits. */
export function columnSplitStyle(layout: PaneLayout, index: number): CSSProperties {
  const next = along(layout.widths, index + 1);
  return { left: `calc(${next.start} - ${GAP_PX}px)`, width: GAP_PX, top: 0, height: '100%' };
}

/** The gap under pane `index` of a column. */
export function rowSplitStyle(layout: PaneLayout, column: number, index: number): CSSProperties {
  const x = along(layout.widths, column);
  const next = along(layout.heights[column]!, index + 1);
  return { left: x.start, width: x.size, top: `calc(${next.start} - ${GAP_PX}px)`, height: GAP_PX };
}

const STORAGE_PREFIX = 'atelier.codePanes.';

/** A session's layout as this device left it; panes this surface can't show (`available`) are left out. */
export function loadLayout(sessionId: string, available: readonly PaneId[] = PANES): PaneLayout {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + sessionId);
    return raw ? validLayout(JSON.parse(raw), available) : EMPTY_LAYOUT;
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function saveLayout(sessionId: string, layout: PaneLayout): void {
  try {
    if (layout.columns.length) localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(layout));
    else localStorage.removeItem(STORAGE_PREFIX + sessionId);
  } catch {
    // Storage unavailable: the layout lasts as long as the page.
  }
}

const isShare = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const shares = (v: unknown, n: number): number[] => (Array.isArray(v) && v.length === n && v.every(isShare) ? normalize(v) : even(n));

/** A stored layout made safe to use: known panes once each, sizes that fit them; anything else starts over. */
export function validLayout(value: unknown, available: readonly PaneId[] = PANES): PaneLayout {
  if (!value || typeof value !== 'object') return EMPTY_LAYOUT;
  const v = value as Partial<Record<keyof PaneLayout, unknown>>;
  if (!Array.isArray(v.columns)) return EMPTY_LAYOUT;
  const seen = new Set<PaneId>();
  const keep = (p: unknown): p is PaneId => {
    if (!available.includes(p as PaneId) || seen.has(p as PaneId)) return false;
    seen.add(p as PaneId);
    return true;
  };
  const columns = v.columns.map((c: unknown) => (Array.isArray(c) ? c.filter(keep) : [])).filter((c) => c.length);
  if (!columns.length) return EMPTY_LAYOUT;
  // Columns lost panes: their stored sizes no longer describe them.
  const same = columns.length === v.columns.length && columns.every((c, i) => c.length === (v.columns as unknown[][])[i]!.length);
  const heights = Array.isArray(v.heights) ? v.heights : [];
  const pick = (p: unknown) => (seen.has(p as PaneId) ? (p as PaneId) : null);
  return {
    columns,
    dock: isShare(v.dock) && v.dock < 1 ? v.dock : defaultDock(columns.length),
    widths: same ? shares(v.widths, columns.length) : even(columns.length),
    heights: columns.map((c, i) => (same ? shares(heights[i], c.length) : even(c.length))),
    maximized: pick(v.maximized),
    active: pick(v.active) ?? columns.at(-1)!.at(-1)!,
  };
}
