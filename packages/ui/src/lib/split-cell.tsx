/**
 * Split view: sessions side by side in the main area, any number up to `MAX_CELLS`. Each lives in a cell that knows
 * whether it is the active one (the last the person clicked or focused): the others are dimmed, page-wide keys such as
 * ⌘U or ⌘⇧E act in the active one only, and it is the one a session picked in the sidebar replaces. A cell can close
 * itself, and one that held a new session turns into the session once its first message is sent. Outside a split
 * there is no cell: everything is always the active one.
 */
import { Fragment, createContext, useContext, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { Splitter, cn } from '../components/ui/index.ts';
import { dividerLimits, evenShares, moveDivider, normalizeShares, recalledShares, rememberShares } from './split-ratio.ts';
import { useSize } from './use-size.ts';

interface Cell {
  /** The cell the person is working in. */
  active: boolean;
  /** The left one: it carries the window's traffic-light inset when the sidebar is hidden. */
  first: boolean;
  /** The right one: it sits under the window buttons of Windows and Linux. */
  last: boolean;
  close(): void;
  /** Makes this cell show the session `id` (a new session that has its first message). */
  openSession(id: string): void;
}

const CellContext = createContext<Cell | null>(null);

export function SplitCell({
  active,
  first,
  last,
  onActivate,
  onClose,
  onOpenSession,
  id,
  style,
  className,
  ref,
  children,
}: {
  active: boolean;
  first: boolean;
  last: boolean;
  onActivate(): void;
  onClose(): void;
  onOpenSession(id: string): void;
  id?: string;
  /** Its width, set by the split's dividers. */
  style?: CSSProperties;
  className?: string;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ active, first, last, close: onClose, openSession: onOpenSession }), [active, first, last, onClose, onOpenSession]);
  return (
    <CellContext.Provider value={value}>
      <div
        ref={ref}
        id={id}
        data-split-cell={active ? 'active' : 'inactive'}
        onPointerDownCapture={onActivate}
        onFocusCapture={onActivate}
        style={style}
        className={cn('relative flex min-w-0 flex-col', className ?? 'flex-1')}
      >
        {children}
        {/* The cells you are not working in are dimmed; a click anywhere in one makes it the active one. */}
        {!active && <div aria-hidden data-split-dim="" className="pointer-events-none absolute inset-0 z-30 bg-bg/60 transition-opacity duration-(--at-duration-base)" />}
      </div>
    </CellContext.Provider>
  );
}

/** The cell this component is in, or null when the page is not split. */
export function useSplitCell(): Cell | null {
  return useContext(CellContext);
}

/** Whether page-wide keys are for this part of the page: always outside a split, the active cell inside one. */
export function useIsActiveCell(): boolean {
  return useContext(CellContext)?.active ?? true;
}

const KEYS_OFF: Cell = { active: false, first: false, last: false, close: () => {}, openSession: () => {} };

/** A second composer on the page (a side chat): page-wide keys such as ⌘U stay with the session's own. */
export function PageKeysOff({ children }: { children: ReactNode }) {
  return <CellContext.Provider value={KEYS_OFF}>{children}</CellContext.Provider>;
}

/** The divider between cells (w-2: a 1px line with room to grab). */
const DIVIDER_PX = 8;

export interface SplitPaneCell {
  id: string;
  node: ReactNode;
}

/**
 * The cells side by side with a divider between each pair to drag (or move with the arrow keys; double-click for even
 * cells). Shares are kept per window or browser for each number of cells; neither neighbour gets under 360px.
 */
export function SplitPanes({
  cells,
  active,
  onActivate,
  onClose,
  onOpenSession,
}: {
  cells: readonly SplitPaneCell[];
  active: string;
  onActivate(id: string): void;
  onClose(id: string): void;
  /** `from` (a cell's id) now shows the session `id`. */
  onOpenSession(from: string, id: string): void;
}) {
  const n = cells.length;
  const [kept, setKept] = useState(() => ({ n, shares: recalledShares(n) }));
  const shares = normalizeShares(kept.n === n ? kept.shares : recalledShares(n), n);
  const body = useRef<HTMLDivElement>(null);
  const halves = useRef<(HTMLDivElement | null)[]>([]);
  const { width } = useSize(body);
  // Beside the dividers, a cell takes its share of the rest.
  const basis = (share: number) => `calc(${share * 100}% - ${(share * (n - 1) * DIVIDER_PX).toFixed(2)}px)`;
  const commit = (next: number[]) => {
    setKept({ n, shares: next });
    rememberShares(next);
  };
  return (
    <div ref={body} className="flex min-h-0 flex-1">
      {cells.map((cell, i) => {
        const last = i === n - 1;
        const pair = last ? 0 : shares[i]! + shares[i + 1]!;
        const limits = dividerLimits(width, pair);
        return (
          <Fragment key={cell.id}>
            <SplitCell
              ref={(el) => void (halves.current[i] = el)}
              id={`split-cell-${cell.id}`}
              first={i === 0}
              last={last}
              active={cell.id === active}
              onActivate={() => onActivate(cell.id)}
              onClose={() => onClose(cell.id)}
              onOpenSession={(id) => onOpenSession(cell.id, id)}
              className={last ? 'flex-1' : 'flex-none'}
              style={last ? undefined : { flexBasis: basis(shares[i]!) }}
            >
              {cell.node}
            </SplitCell>
            {!last && (
              <Splitter
                orientation="vertical"
                label={n > 2 ? `Resize sessions ${i + 1} and ${i + 2}` : 'Resize the sessions'}
                value={shares[i]! / pair}
                min={limits.min}
                max={limits.max}
                controls={`split-cell-${cell.id}`}
                measure={() => (body.current?.clientWidth ?? width) * pair}
                onPreview={(v) => {
                  const left = halves.current[i];
                  const right = halves.current[i + 1];
                  if (left) left.style.flexBasis = basis(v * pair);
                  if (right && i + 1 < n - 1) right.style.flexBasis = basis((1 - v) * pair);
                }}
                onCommit={(v) => commit(moveDivider(shares, i, v))}
                onReset={() => commit(evenShares(n))}
                className="relative w-2 shrink-0 self-stretch border-x-[3.5px] border-transparent bg-line bg-clip-padding"
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
