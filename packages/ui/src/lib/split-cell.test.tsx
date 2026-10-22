import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SplitCell, useIsActiveCell, useSplitCell } from './split-cell.tsx';

function Probe({ name }: { name: string }) {
  const active = useIsActiveCell();
  const cell = useSplitCell();
  return (
    <button type="button" onClick={cell?.close}>
      {name}: {active ? 'active' : 'inactive'}
    </button>
  );
}

describe('split view cells', () => {
  it('is always the active one outside a split', () => {
    render(<Probe name="alone" />);
    expect(screen.getByRole('button').textContent).toBe('alone: active');
  });

  it('makes the cell the person pointed at or focused the active one, and closes from either', () => {
    const closed = vi.fn();
    function Two() {
      const [active, setActive] = useState<'a' | 'b'>('a');
      return (
        <>
          <SplitCell first last={false} active={active === 'a'} onActivate={() => setActive('a')} onClose={() => closed('a')} onOpenSession={() => {}}>
            <Probe name="a" />
          </SplitCell>
          <SplitCell first={false} last active={active === 'b'} onActivate={() => setActive('b')} onClose={() => closed('b')} onOpenSession={() => {}}>
            <Probe name="b" />
          </SplitCell>
        </>
      );
    }
    render(<Two />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['a: active', 'b: inactive']);
    fireEvent.pointerDown(screen.getByText('b: inactive'));
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['a: inactive', 'b: active']);
    // The one you are not in is dimmed, the active one is not.
    const cells = [...document.querySelectorAll('[data-split-cell]')];
    expect(cells.map((c) => c.getAttribute('data-split-cell'))).toEqual(['inactive', 'active']);
    expect(cells[0]!.querySelector('[data-split-dim]')).toBeTruthy();
    expect(cells[1]!.querySelector('[data-split-dim]')).toBeNull();
    fireEvent.click(screen.getByText('a: inactive'));
    expect(closed).toHaveBeenCalledWith('a');
  });
});
