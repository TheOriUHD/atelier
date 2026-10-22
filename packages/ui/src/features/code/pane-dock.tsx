/**
 * The dock beside a Code session's transcript (design/components.md › Code panes): its open panes as cards tiled in
 * columns (pane-layout.ts), the splitters between them, and each pane's frame with its header. Panes keep their
 * place in the DOM whatever the layout, so a terminal or a browser tab never restarts when the others move.
 * Splitter drags write the new geometry straight to the elements every frame and keep it in the layout at the end.
 */
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSize } from '../../lib/use-size.ts';
import { EllipsisVertical, Maximize2, Minimize2, X } from 'lucide-react';
import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Splitter,
  cn,
} from '../../components/ui/index.ts';
import {
  GAP_PX,
  MIN_COLUMN_PX,
  MIN_PANE_HEIGHT_PX,
  MIN_TRANSCRIPT_PX,
  PANES,
  clamp,
  columnSplitStyle,
  columnsFor,
  isOpen,
  moveSplit,
  openPanes,
  paneStyle,
  rowSplitStyle,
  splitOf,
  type LayoutAction,
  type PaneId,
  type PaneLayout,
} from './pane-layout.ts';

/** What a pane needs to draw its frame: where it sits and what its header buttons do. */
export interface PaneFrameState {
  pane: PaneId;
  style: CSSProperties;
  /** Behind a maximized pane, or not the one a sheet shows: kept alive but out of sight and out of reach. */
  hidden: boolean;
  maximized: boolean;
  /** Maximize is offered when other panes share the dock. */
  canMaximize: boolean;
  /** Other open panes, for "Close other panes". */
  others: number;
  /** Shown as a sheet over the transcript (a narrow window). */
  sheet: boolean;
  dispatch: Dispatch<LayoutAction>;
  /** Closes the pane and moves focus somewhere sensible (its toggle in the header, or the composer). */
  close(): void;
}

const FULL: CSSProperties = { left: 0, top: 0, width: '100%', height: '100%' };

/** Where an element of the dock sits for `layout`, by its id: `pane-<pane>`, `dock-col-<i>` or `dock-row-<column>-<i>`. */
function styleFor(layout: PaneLayout, id: string): CSSProperties {
  const [kind, a, b] = id.split('-');
  if (kind === 'pane') return paneStyle(layout, a as PaneId);
  if (a === 'col') return columnSplitStyle(layout, Number(b));
  return rowSplitStyle(layout, Number(b), Number(id.split('-')[3]));
}

export function PaneDock({
  layout,
  sheet,
  dispatch,
  onClose,
  renderPane,
}: {
  layout: PaneLayout;
  /** Too narrow for a dock: the panes open as a sheet over the transcript, one at a time. */
  sheet: boolean;
  dispatch: Dispatch<LayoutAction>;
  onClose(pane: PaneId): void;
  renderPane(frame: PaneFrameState): ReactNode;
}) {
  const dock = useRef<HTMLDivElement>(null);
  // A drag moves the panes and the lines between them without a render.
  const preview = useCallback((next: PaneLayout) => {
    const elements = dock.current?.querySelectorAll<HTMLElement>(':scope > [id^="pane-"], :scope > [id^="dock-"]') ?? [];
    for (const el of elements) Object.assign(el.style, styleFor(next, el.id));
  }, []);

  const open = openPanes(layout);
  return (
    <div ref={dock} className="relative size-full">
      {PANES.filter((pane) => isOpen(layout, pane)).map((pane) => (
        <Fragment key={pane}>
          {renderPane({
            pane,
            style: sheet ? FULL : paneStyle(layout, pane),
            hidden: sheet ? layout.active !== pane : layout.maximized !== null && layout.maximized !== pane,
            maximized: !sheet && layout.maximized === pane,
            canMaximize: !sheet,
            others: open.length - 1,
            sheet,
            dispatch,
            close: () => onClose(pane),
          })}
        </Fragment>
      ))}
      {!sheet && !layout.maximized && (
        <DockSplitters layout={layout} dock={dock} preview={preview} dispatch={dispatch} />
      )}
    </div>
  );
}

/** Between columns, and between the panes stacked in each column. Measures the dock itself so the panes don't re-render. */
function DockSplitters({
  layout,
  dock,
  preview,
  dispatch,
}: {
  layout: PaneLayout;
  dock: RefObject<HTMLDivElement | null>;
  preview(next: PaneLayout): void;
  dispatch: Dispatch<LayoutAction>;
}) {
  const { width, height } = useSize(dock);
  const { columns, widths, heights } = layout;
  const roomX = width - (columns.length - 1) * GAP_PX;
  return (
    <>
      {columns.slice(1).map((_, i) => {
        const pair = roomX * (widths[i]! + widths[i + 1]!);
        const min = Math.min(0.5, MIN_COLUMN_PX / Math.max(pair, 1));
        return (
          <Splitter
            key={`col:${i}`}
            id={`dock-col-${i}`}
            orientation="vertical"
            label="Resize columns"
            controls={`pane-${columns[i]![0]}`}
            value={splitOf(widths, i)}
            min={min}
            max={1 - min}
            className="absolute"
            style={columnSplitStyle(layout, i)}
            measure={() => (dock.current!.clientWidth - (columns.length - 1) * GAP_PX) * (widths[i]! + widths[i + 1]!)}
            onPreview={(v) => preview({ ...layout, widths: moveSplit(widths, i, v) })}
            onCommit={(v) => dispatch({ type: 'resizeColumns', widths: moveSplit(widths, i, v) })}
            onReset={() => dispatch({ type: 'resetColumns' })}
          />
        );
      })}
      {columns.flatMap((column, c) =>
        column.slice(1).map((_, i) => {
          const shares = heights[c]!;
          const pair = (height - (column.length - 1) * GAP_PX) * (shares[i]! + shares[i + 1]!);
          const min = Math.min(0.5, MIN_PANE_HEIGHT_PX / Math.max(pair, 1));
          return (
            <Splitter
              key={`row:${c}:${i}`}
              id={`dock-row-${c}-${i}`}
              orientation="horizontal"
              label="Resize panes"
              controls={`pane-${column[i]}`}
              value={splitOf(shares, i)}
              min={min}
              max={1 - min}
              className="absolute"
              style={rowSplitStyle(layout, c, i)}
              measure={() =>
                (dock.current!.clientHeight - (column.length - 1) * GAP_PX) * (shares[i]! + shares[i + 1]!)
              }
              onPreview={(v) =>
                preview({ ...layout, heights: heights.map((h, j) => (j === c ? moveSplit(h, i, v) : h)) })
              }
              onCommit={(v) => dispatch({ type: 'resizeRows', column: c, heights: moveSplit(shares, i, v) })}
              onReset={() => dispatch({ type: 'resetRows', column: c })}
            />
          );
        }),
      )}
    </>
  );
}

/**
 * The dock's width beside the transcript: its share, but never squeezing the transcript or its columns. Where one
 * column can't have its minimum and leave the transcript its own (a small half of a split view), the two share the
 * width instead.
 */
export function dockWidth(layout: Pick<PaneLayout, 'dock' | 'columns'>, columns = layout.columns.length): string {
  const least = columns * MIN_COLUMN_PX + columns * GAP_PX;
  const share = `${layout.dock * 100}%`;
  if (columns !== 1) return `clamp(${least}px, ${share}, calc(100% - ${MIN_TRANSCRIPT_PX + GAP_PX}px))`;
  const lower = `min(${least}px, 50%)`;
  return `clamp(${lower}, ${share}, max(calc(100% - ${MIN_TRANSCRIPT_PX + GAP_PX}px), ${lower}))`;
}

/** The line between the transcript and the dock. `value` is the transcript's share of the width. */
export function DockSplitter({
  sessionId,
  layout,
  columns,
  body,
  onPreview,
  dispatch,
}: {
  /** The session whose transcript it resizes against (two can share a page in a split view). */
  sessionId: string;
  layout: PaneLayout;
  /** Columns shown (after fitting the window). */
  columns: number;
  body: RefObject<HTMLDivElement | null>;
  /** Shows the dock at a share of the width while the line is dragged. */
  onPreview(dock: number): void;
  dispatch: Dispatch<LayoutAction>;
}) {
  const { width } = useSize(body);
  const least = columns * (MIN_COLUMN_PX + GAP_PX) + GAP_PX;
  const min = Math.min(0.9, MIN_TRANSCRIPT_PX / Math.max(width, 1));
  const max = Math.max(min, 1 - least / Math.max(width, 1));
  // The share the dock really has, after the clamp in `dockWidth`.
  const shown = clamp(1 - layout.dock, min, max);
  return (
    <Splitter
      orientation="vertical"
      label="Resize the panes"
      controls={`code-transcript-${sessionId}`}
      value={shown}
      min={min}
      max={max}
      className="relative w-2 shrink-0 self-stretch"
      measure={() => body.current!.clientWidth}
      onPreview={(v) => onPreview(1 - v)}
      onCommit={(v) => dispatch({ type: 'resizeDock', dock: 1 - v })}
      onReset={() => dispatch({ type: 'resetDock' })}
    />
  );
}

/** A pane as a card: a 40px header (`start` on the left; its menu, maximize and close on the right) over its body. */
export function PaneFrame({
  frame,
  title,
  start,
  menu,
  actions,
  children,
  className,
}: {
  frame: PaneFrameState;
  title: string;
  /** The header's left side; the title when there is nothing else. */
  start?: ReactNode;
  /** The pane's own menu items, above the ones every pane has. */
  menu?: ReactNode;
  /** Buttons in place of the menu, for a pane whose header says it all (Background tasks). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { pane, hidden, maximized, dispatch } = frame;
  return (
    <section
      id={`pane-${pane}`}
      aria-label={title}
      inert={hidden}
      style={frame.style}
      onFocusCapture={() => dispatch({ type: 'activate', pane })}
      onPointerDownCapture={() => dispatch({ type: 'activate', pane })}
      className={cn(
        'absolute flex flex-col overflow-hidden rounded-xl border border-line bg-bg',
        'transition-[opacity,scale] duration-(--at-duration-base) ease-out starting:scale-[.98] starting:opacity-0',
        // A sheet is the session's whole body, not a card over the transcript.
        frame.sheet && 'rounded-none border-0',
        'max-md:rounded-none max-md:border-0',
        hidden && 'invisible',
        className,
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-1">{start ?? <PaneTitle>{title}</PaneTitle>}</div>
        {actions ?? (
          <Menu>
            <MenuTrigger
              render={
                <IconButton
                  icon={EllipsisVertical}
                  label={`${title} options`}
                  size="xs"
                  className="text-fg-secondary"
                />
              }
            />
            <MenuContent align="end" className="w-52">
              {menu}
              {menu && <MenuSeparator />}
              {frame.canMaximize && (
                <MenuItem
                  icon={maximized ? Minimize2 : Maximize2}
                  onClick={() => dispatch({ type: 'toggleMaximize', pane })}
                >
                  {maximized ? 'Exit fullscreen' : 'Fullscreen'}
                </MenuItem>
              )}
              <MenuItem disabled={frame.others === 0} onClick={() => dispatch({ type: 'closeOthers', pane })}>
                Close other panes
              </MenuItem>
              <MenuItem icon={X} onClick={frame.close}>
                Close
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        {frame.canMaximize && (
          <IconButton
            icon={maximized ? Minimize2 : Maximize2}
            label={maximized ? `Exit fullscreen: ${title}` : `Fullscreen ${title}`}
            size="xs"
            className="text-fg-secondary max-md:hidden"
            onClick={() => dispatch({ type: 'toggleMaximize', pane })}
          />
        )}
        <IconButton icon={X} label={`Close ${title}`} size="xs" className="text-fg-secondary" onClick={frame.close} />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

export function PaneTitle({ children }: { children: ReactNode }) {
  return <h2 className="truncate px-0.5 text-control-sm font-medium text-fg">{children}</h2>;
}

/** How many columns the session's width has room for (0: none, so panes open as a sheet). */
export function useDockRoom(body: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const read = () => setColumns(columnsFor(el.clientWidth));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body]);
  return columns;
}
