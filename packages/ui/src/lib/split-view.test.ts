import { describe, expect, it } from 'vitest';
import { MAX_CELLS, NEW_CELL, activeOf, addNextTo, cellsOf, openIn, routeOf, without } from './split-view.ts';

describe('split view cells', () => {
  it('reads them from the route and writes them back', () => {
    expect(cellsOf('a', undefined)).toEqual(['a']);
    expect(cellsOf('a', 'b,c')).toEqual(['a', 'b', 'c']);
    expect(cellsOf('a', 'a,b,,b')).toEqual(['a', 'b']);
    expect(cellsOf('a', 'b,c,d,e,f')).toHaveLength(MAX_CELLS);
    expect(routeOf(['a'])).toEqual({ sessionId: 'a' });
    expect(routeOf(['a', 'b', NEW_CELL])).toEqual({ sessionId: 'a', split: 'b,new' });
  });

  it('keeps the remembered active cell while it is shown, else the first', () => {
    expect(activeOf(['a', 'b'], 'b')).toBe('b');
    expect(activeOf(['a', 'b'], 'gone')).toBe('a');
    expect(activeOf(['a', 'b'], null)).toBe('a');
  });

  it('puts a picked session where the person works, or moves to it where it already is', () => {
    expect(openIn(['a', 'b', 'c'], 'b', 'x')).toEqual({ cells: ['a', 'x', 'c'], active: 'x' });
    expect(openIn(['a', 'b'], 'a', 'b')).toEqual({ cells: ['a', 'b'], active: 'b' });
    // The new session's place takes one, too.
    expect(openIn(['a', 'b'], 'b', NEW_CELL)).toEqual({ cells: ['a', NEW_CELL], active: NEW_CELL });
    expect(openIn(['a', NEW_CELL], NEW_CELL, 's1')).toEqual({ cells: ['a', 's1'], active: 's1' });
  });

  it('adds a session beside the active one while there is room, and replaces it at the limit', () => {
    expect(addNextTo(['a', 'b'], 'a', 'x')).toEqual({ cells: ['a', 'x', 'b'], active: 'x' });
    expect(addNextTo(['a'], 'a', 'x')).toEqual({ cells: ['a', 'x'], active: 'x' });
    expect(addNextTo(['a', 'b', 'c', 'd'], 'c', 'x')).toEqual({ cells: ['a', 'b', 'x', 'd'], active: 'x' });
    expect(addNextTo(['a', 'b'], 'a', 'b')).toEqual({ cells: ['a', 'b'], active: 'b' });
  });

  it('closes a cell, handing the active mark to its neighbour', () => {
    expect(without(['a', 'b', 'c'], 'b', 'b')).toEqual({ cells: ['a', 'c'], active: 'a' });
    expect(without(['a', 'b', 'c'], 'a', 'a')).toEqual({ cells: ['b', 'c'], active: 'b' });
    expect(without(['a', 'b', 'c'], 'c', 'a')).toEqual({ cells: ['b', 'c'], active: 'c' });
    expect(without(['a'], 'a', 'a')).toEqual({ cells: ['a'], active: 'a' });
  });
});
