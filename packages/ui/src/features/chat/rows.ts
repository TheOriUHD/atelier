/**
 * Vertical rhythm of the column. Rows that are one muted line (a note, a run's summary, "Thought process") sit close
 * together, 4px apart, so a long run of them reads as a list; text, bubbles and cards keep 16px of air, and the row of
 * reply actions below a reply takes 8 (4 before a line). A row says what it is at each end (`data-first`, `data-last`: `line` or
 * `actions`; anything else is a block), and these selectors turn the pairs into margins.
 */
export const ROW_GAPS = [
  '[&>*+*]:mt-4',
  '[&>[data-last=line]+[data-first=line]]:mt-1',
  '[&>[data-last=actions]+*]:mt-2',
  '[&>[data-last=actions]+[data-first=line]]:mt-1',
].join(' ');

/** The two ends of a row that is one muted line. */
export const LINE = { 'data-first': 'line', 'data-last': 'line' } as const;

/** Within an assistant turn: lines of the run close together, the rest 16px apart. */
export const ITEM_GAPS = '[&>*+*]:mt-4 [&>[data-line]+[data-line]]:mt-1';
