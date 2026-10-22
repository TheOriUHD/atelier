import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_LAYOUT,
  columnsFor,
  defaultDock,
  fitColumns,
  layoutReducer,
  loadLayout,
  moveSplit,
  paneStyle,
  shownAction,
  saveLayout,
  splitOf,
  validLayout,
  type LayoutAction,
  type PaneId,
  type PaneLayout,
} from './pane-layout.ts';
import { dockWidth } from './pane-dock.tsx';

const open = (layout: PaneLayout, panes: PaneId[], maxColumns = 3) => panes.reduce((l, pane) => layoutReducer(l, { type: 'open', pane, maxColumns }), layout);
const run = (layout: PaneLayout, ...actions: LayoutAction[]) => actions.reduce(layoutReducer, layout);

describe('tiling', () => {
  it('stacks the second pane under the first, then starts a new column for the third', () => {
    const one = open(EMPTY_LAYOUT, ['terminal']);
    expect(one).toMatchObject({ columns: [['terminal']], widths: [1], heights: [[1]], dock: defaultDock(1), active: 'terminal' });

    const two = open(one, ['diff']);
    expect(two.columns).toEqual([['terminal', 'diff']]);
    expect(two.heights).toEqual([[0.5, 0.5]]);

    const three = open(two, ['browser']);
    expect(three.columns).toEqual([['terminal', 'diff'], ['browser']]);
    expect(three.widths).toEqual([0.5, 0.5]);
    expect(three.dock).toBe(defaultDock(2));
    expect(three.dock).toBeGreaterThan(two.dock);

    expect(open(three, ['files']).columns).toEqual([['terminal', 'diff'], ['browser', 'files']]);
  });

  it('stacks in the column with the fewest panes once no more columns fit', () => {
    const full = open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser', 'files'], 2);
    expect(full.columns).toEqual([['terminal', 'diff'], ['browser', 'files']]);
    const five = open(full, ['tasks'], 2);
    expect(five.columns).toEqual([['terminal', 'diff'], ['browser', 'files', 'tasks']]);
    expect(five.heights[1]).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(open(five, ['plan'], 2).columns).toEqual([['terminal', 'diff', 'plan'], ['browser', 'files', 'tasks']]);
    // A window with room for one column only keeps stacking.
    expect(open(EMPTY_LAYOUT, ['terminal', 'diff', 'files'], 1).columns).toEqual([['terminal', 'diff', 'files']]);
  });

  it('keeps a new column at an even share of the dock, the others keeping their proportions', () => {
    const resized = run(open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser', 'files']), { type: 'resizeColumns', widths: [0.75, 0.25] });
    const three = open(resized, ['tasks', 'plan'], 3);
    expect(three.columns).toEqual([['terminal', 'diff'], ['browser', 'files'], ['tasks', 'plan']]);
    expect(three.widths.map((w) => +w.toFixed(4))).toEqual([0.5, 0.1667, 0.3333]);
  });

  it('opening a pane that is open makes it the active one and brings it out from behind a maximized pane', () => {
    const layout = run(open(EMPTY_LAYOUT, ['terminal', 'diff']), { type: 'toggleMaximize', pane: 'terminal' });
    expect(layout.maximized).toBe('terminal');
    const again = run(layout, { type: 'open', pane: 'diff', maxColumns: 3 });
    expect(again).toMatchObject({ maximized: null, active: 'diff', columns: [['terminal', 'diff']] });
    expect(run(layout, { type: 'open', pane: 'terminal', maxColumns: 3 }).maximized).toBe('terminal');
  });
});

describe('closing', () => {
  it('gives a closed pane’s room to the rest of its column', () => {
    const layout = run(open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']), { type: 'resizeRows', column: 0, heights: [0.3, 0.7] });
    const closed = run(layout, { type: 'close', pane: 'terminal' });
    expect(closed.columns).toEqual([['diff'], ['browser']]);
    expect(closed.heights).toEqual([[1], [1]]);
    expect(closed.widths).toEqual(layout.widths);
  });

  it('drops an empty column, shares its width out and shrinks the dock back', () => {
    const layout = open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']);
    const closed = run(layout, { type: 'close', pane: 'browser' });
    expect(closed).toMatchObject({ columns: [['terminal', 'diff']], widths: [1], dock: defaultDock(1), active: 'diff' });
    expect(run(closed, { type: 'close', pane: 'terminal' }, { type: 'close', pane: 'diff' })).toMatchObject({ columns: [], widths: [], dock: 0, active: null });
  });

  it('a later pane reflows into the room left', () => {
    const layout = run(open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']), { type: 'close', pane: 'diff' });
    expect(open(layout, ['files']).columns).toEqual([['terminal'], ['browser', 'files']]);
  });

  it('un-maximizes when the maximized pane closes, and closes all others on request', () => {
    const layout = run(open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']), { type: 'toggleMaximize', pane: 'diff' });
    expect(run(layout, { type: 'close', pane: 'diff' }).maximized).toBeNull();
    expect(run(layout, { type: 'close', pane: 'terminal' }).maximized).toBe('diff');
    expect(run(layout, { type: 'closeOthers', pane: 'browser' })).toMatchObject({ columns: [['browser']], widths: [1], heights: [[1]], maximized: null, active: 'browser' });
  });

  it('ignores panes that are not open', () => {
    const layout = open(EMPTY_LAYOUT, ['terminal']);
    expect(run(layout, { type: 'close', pane: 'files' })).toBe(layout);
    expect(run(layout, { type: 'toggleMaximize', pane: 'files' })).toBe(layout);
  });
});

describe('sizes', () => {
  it('moves the line between two neighbours only', () => {
    expect(moveSplit([0.25, 0.25, 0.5], 0, 0.8).map((s) => +s.toFixed(6))).toEqual([0.4, 0.1, 0.5]);
    expect(splitOf([0.4, 0.1, 0.5], 0)).toBeCloseTo(0.8);
  });

  it('keeps shares adding up to one and resets to even sizes', () => {
    let layout = open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']);
    layout = run(layout, { type: 'resizeColumns', widths: [3, 1] }, { type: 'resizeRows', column: 0, heights: [1, 3] }, { type: 'resizeDock', dock: 0.95 });
    expect(layout).toMatchObject({ widths: [0.75, 0.25], heights: [[0.25, 0.75], [1]], dock: 0.9 });
    expect(run(layout, { type: 'resetColumns' }).widths).toEqual([0.5, 0.5]);
    expect(run(layout, { type: 'resetRows', column: 0 }).heights[0]).toEqual([0.5, 0.5]);
    expect(run(layout, { type: 'resetDock' }).dock).toBe(defaultDock(2));
    // Sizes for a different number of panes are refused.
    expect(run(layout, { type: 'resizeColumns', widths: [1] })).toBe(layout);
  });

  it('places panes with the gaps between them', () => {
    const layout = open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']);
    expect(paneStyle(layout, 'terminal')).toEqual({ left: 'calc((100% - 8px) * 0 + 0px)', width: 'calc((100% - 8px) * 0.5)', top: 'calc((100% - 8px) * 0 + 0px)', height: 'calc((100% - 8px) * 0.5)' });
    expect(paneStyle(layout, 'diff').top).toBe('calc((100% - 8px) * 0.5 + 8px)');
    expect(paneStyle(layout, 'browser')).toMatchObject({ left: 'calc((100% - 8px) * 0.5 + 8px)', height: 'calc((100% - 0px) * 1)' });
    expect(paneStyle(run(layout, { type: 'toggleMaximize', pane: 'diff' }), 'diff')).toEqual({ left: 0, top: 0, width: '100%', height: '100%' });
  });
});

describe('window width', () => {
  it('counts the columns that fit beside the transcript', () => {
    // Too small for the comfortable sizes, one squeezed column still tiles; under 340px there is none.
    expect(columnsFor(339)).toBe(0);
    expect(columnsFor(360)).toBe(1);
    expect(columnsFor(700)).toBe(1);
    expect(columnsFor(800)).toBe(1);
    expect(columnsFor(1152)).toBe(2);
    expect(columnsFor(1440)).toBe(3);
  });

  it('takes half the width for one squeezed column where the transcript would be left under its minimum', () => {
    const layout = { dock: 0.5, columns: [['terminal']] } as Pick<PaneLayout, 'dock' | 'columns'>;
    // Room enough: its share between 328px and what leaves the transcript 400px.
    expect(dockWidth(layout)).toBe('clamp(min(328px, 50%), 50%, max(calc(100% - 408px), min(328px, 50%)))');
    // Two columns keep their comfortable minimum.
    expect(dockWidth({ dock: 0.64, columns: [['terminal'], ['diff']] })).toBe('clamp(656px, 64%, calc(100% - 408px))');
  });

  it('tiles into fewer columns when they no longer fit, without touching what is stored', () => {
    const layout = open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser', 'files', 'tasks']);
    expect(layout.columns).toHaveLength(3);
    expect(fitColumns(layout, 3)).toBe(layout);
    expect(fitColumns(layout, 2).columns).toEqual([['terminal', 'diff'], ['browser', 'files', 'tasks']]);
    expect(fitColumns(layout, 0).columns).toEqual([['terminal', 'diff', 'browser', 'files', 'tasks']]);
    expect(fitColumns(layout, 1).active).toBe('tasks');
  });

  it('keeps a layout tiled for a narrow window once it is resized there', () => {
    const stored = open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser', 'files', 'tasks']);
    const shown = fitColumns(stored, 2);
    const resize: LayoutAction = { type: 'resizeColumns', widths: [0.7, 0.3] };
    const adopted = layoutReducer(stored, shownAction(stored, shown, resize));
    expect(adopted).toMatchObject({ columns: shown.columns, widths: [0.7, 0.3] });
    // Unfitted, or not a resize: as it is.
    expect(shownAction(stored, stored, resize)).toBe(resize);
    const close: LayoutAction = { type: 'close', pane: 'tasks' };
    expect(shownAction(stored, shown, close)).toBe(close);
  });
});

describe('persistence', () => {
  beforeEach(() => localStorage.clear());

  it('keeps each session’s layout on this device', () => {
    const layout = run(open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']), { type: 'resizeColumns', widths: [0.6, 0.4] });
    saveLayout('s1', layout);
    expect(loadLayout('s1')).toEqual(layout);
    expect(loadLayout('s2')).toEqual(EMPTY_LAYOUT);
    saveLayout('s1', EMPTY_LAYOUT);
    expect(localStorage.getItem('atelier.codePanes.s1')).toBeNull();
  });

  it('leaves out panes this surface can’t show and sizes that no longer fit', () => {
    saveLayout('s1', open(EMPTY_LAYOUT, ['terminal', 'diff', 'browser']));
    const web = loadLayout('s1', ['terminal', 'diff', 'files', 'tasks', 'plan']);
    expect(web).toMatchObject({ columns: [['terminal', 'diff']], widths: [1], heights: [[0.5, 0.5]], active: 'diff' });
  });

  it('starts over from anything malformed', () => {
    expect(validLayout(null)).toEqual(EMPTY_LAYOUT);
    expect(validLayout({ columns: 'terminal' })).toEqual(EMPTY_LAYOUT);
    expect(validLayout({ columns: [['nope'], []] })).toEqual(EMPTY_LAYOUT);
    expect(validLayout({ columns: [['terminal', 'terminal'], ['diff']], widths: [0.5, -1], heights: [[2], ['x']], dock: 7, maximized: 'files' })).toEqual({
      columns: [['terminal'], ['diff']],
      dock: defaultDock(2),
      widths: [0.5, 0.5],
      heights: [[1], [1]],
      maximized: null,
      active: 'diff',
    });
    localStorage.setItem('atelier.codePanes.bad', '{');
    expect(loadLayout('bad')).toEqual(EMPTY_LAYOUT);
  });
});
