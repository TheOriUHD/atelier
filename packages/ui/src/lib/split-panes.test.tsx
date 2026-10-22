import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPanes } from './split-cell.tsx';

const width = 1200;
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
});
afterEach(() => {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

const cell = (id: string) => ({ id, node: <p>{id}</p> });
const panes = (ids: string[], active = ids[0]!, handlers: Partial<Parameters<typeof SplitPanes>[0]> = {}) =>
  render(<SplitPanes cells={ids.map(cell)} active={active} onActivate={() => {}} onClose={() => {}} onOpenSession={() => {}} {...handlers} />);
const cellOf = (id: string) => screen.getByText(id).closest('[data-split-cell]') as HTMLElement;

describe('SplitPanes', () => {
  it('starts even, moves with the arrow keys, keeps the shares, and goes back to even on a double-click', () => {
    const { unmount } = panes(['a', 'b']);
    const divider = screen.getByRole('separator', { name: 'Resize the sessions' });
    expect(divider.getAttribute('aria-valuenow')).toBe('50');
    expect(cellOf('a').style.flexBasis).toBe('calc(50% - 4.00px)');

    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(divider.getAttribute('aria-valuenow')).toBe('52');
    expect(cellOf('a').style.flexBasis).toBe('calc(52% - 4.16px)');

    unmount();
    panes(['a', 'b']);
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('52');
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('50');
  });

  it('never leaves either neighbour under 360px', () => {
    panes(['a', 'b']);
    const divider = screen.getByRole('separator');
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(divider.getAttribute('aria-valuenow')).toBe('30');
    fireEvent.keyDown(divider, { key: 'End' });
    expect(divider.getAttribute('aria-valuenow')).toBe('70');
  });

  it('shows any number of cells with a divider between each pair, moving only that pair', () => {
    panes(['a', 'b', 'c']);
    const dividers = screen.getAllByRole('separator');
    expect(dividers.map((d) => d.getAttribute('aria-label'))).toEqual(['Resize sessions 1 and 2', 'Resize sessions 2 and 3']);
    // Even thirds: the first divider's pair is a and b.
    expect(cellOf('a').style.flexBasis).toBe('calc(33.33333333333333% - 5.33px)');
    fireEvent.keyDown(dividers[0]!, { key: 'ArrowRight' });
    const share = (id: string) => parseFloat(cellOf(id).style.flexBasis.replace('calc(', ''));
    expect(share('a')).toBeGreaterThan(33.4);
    expect(share('b')).toBeLessThan(33.3);
    // The last cell takes what is left.
    expect(cellOf('c').style.flexBasis).toBe('');
  });

  it('dims the cells that are not active and reports clicks into them', () => {
    const onActivate = vi.fn();
    panes(['a', 'b', 'c'], 'b', { onActivate });
    expect(['a', 'b', 'c'].map((id) => cellOf(id).getAttribute('data-split-cell'))).toEqual(['inactive', 'active', 'inactive']);
    fireEvent.pointerDown(screen.getByText('c'));
    expect(onActivate).toHaveBeenCalledWith('c');
  });
});
