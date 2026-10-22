import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { NEW_CELL, activeOf, addNextTo, cellsOf, openIn, routeOf, without, type Cells } from '../lib/split-view.ts';
import { useUi } from '../lib/ui-store.ts';
import { useMode } from './navigation.ts';

/**
 * The Code page's split view as the rest of the app uses it: which sessions are in the cells (from the route), which
 * cell is the active one, and the ways to change them. `open` and `openNew` answer whether a split took the request;
 * when none is up the caller navigates as it always did.
 */
export function useCodeSplit() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const { split } = useSearch({ strict: false }) as { split?: string };
  const mode = useMode();
  const remembered = useUi((s) => s.activeCell);
  const setActive = useUi((s) => s.setActiveCell);
  const inSession = mode === 'code' && !!params.sessionId;
  const cells = inSession ? cellsOf(params.sessionId!, split) : [];
  const active = cells.length ? activeOf(cells, remembered) : null;

  const show = (next: Cells) => {
    setActive(next.active);
    const route = routeOf(next.cells);
    void navigate({ to: '/code/$sessionId', params: { sessionId: route.sessionId }, search: route.split ? { split: route.split } : {} });
  };

  return {
    cells,
    active,
    isSplit: cells.length > 1,
    show,
    /** A session picked in the sidebar: it replaces the active cell (true), or nothing is split (false). */
    open(id: string): boolean {
      if (cells.length < 2 || !active) return false;
      show(openIn(cells, active, id));
      return true;
    },
    /** "New" in the sidebar: the new session's place takes the active cell. */
    openNew(): boolean {
      if (cells.length < 2 || !active) return false;
      show(openIn(cells, active, NEW_CELL));
      return true;
    },
    /** "Split view" in a session's menu: beside the active cell, whether or not a split is up. */
    addNextTo(id: string): boolean {
      if (!inSession || !active) return false;
      show(addNextTo(cells, active, id));
      return true;
    },
    close: (id: string) => active && show(without(cells, active, id)),
    activate: setActive,
  };
}
