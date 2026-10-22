/**
 * Split view's cells (design/components.md › Split view): the sessions shown side by side, as the session route says
 * them (the path's session, then `?split=b,c`), and the ones a click or a menu changes. A cell is a session id, or
 * `NEW_CELL`: a new session being set up in it. One cell is the active one; it is the one that is replaced when
 * another session is picked in the sidebar. Pure, so the sidebar, the menus and the page share it.
 */
export const NEW_CELL = 'new';
export const MAX_CELLS = 4;

export interface Cells {
  cells: string[];
  /** The cell the person works in: always one of `cells`. */
  active: string;
}

const clean = (ids: readonly string[]): string[] => [...new Set(ids.filter(Boolean))].slice(0, MAX_CELLS);

/** The cells a route shows: its session first, then the `split` ones, each once. */
export function cellsOf(primary: string, split: string | undefined): string[] {
  return clean([primary, ...(split ? split.split(',') : [])]);
}

/** The route for cells: the first as the path's session, the others as `split`. */
export function routeOf(cells: readonly string[]): { sessionId: string; split?: string } {
  const [first = NEW_CELL, ...rest] = clean(cells);
  return { sessionId: first, ...(rest.length ? { split: rest.join(',') } : {}) };
}

/** The active cell among `cells`, as the person left it, else the first. */
export function activeOf(cells: readonly string[], remembered: string | null | undefined): string {
  return remembered && cells.includes(remembered) ? remembered : (cells[0] ?? NEW_CELL);
}

/**
 * Picking `id` in the sidebar: it takes the active cell's place. When it is shown in another cell already, that one
 * becomes the active cell instead (a session is never shown twice).
 */
export function openIn(cells: readonly string[], active: string, id: string): Cells {
  if (cells.includes(id)) return { cells: [...cells], active: id };
  return { cells: cells.map((c) => (c === active ? id : c)), active: id };
}

/** Adding `id` next to the active cell, while there is room; at the limit it replaces the active cell. */
export function addNextTo(cells: readonly string[], active: string, id: string): Cells {
  if (cells.includes(id)) return { cells: [...cells], active: id };
  if (cells.length >= MAX_CELLS) return openIn(cells, active, id);
  const at = Math.max(0, cells.indexOf(active)) + 1;
  return { cells: [...cells.slice(0, at), id, ...cells.slice(at)], active: id };
}

/** Closing a cell: the one before it (or after, for the first) becomes active when it was. */
export function without(cells: readonly string[], active: string, id: string): Cells {
  const index = cells.indexOf(id);
  const rest = cells.filter((c) => c !== id);
  if (index === -1 || rest.length === 0) return { cells: [...cells], active };
  return { cells: rest, active: active === id ? rest[Math.max(0, index - 1)]! : active };
}
