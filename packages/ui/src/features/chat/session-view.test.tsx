import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollToBottom, useFollowScroll } from './session-view.tsx';

function Page({ content }: { content: number }) {
  const { ref, atBottom, followSmooth, onScroll } = useFollowScroll(content);
  return (
    <div>
      <div ref={ref} data-testid="scroller" onScroll={onScroll} />
      <span data-testid="at-bottom">{String(atBottom)}</span>
      <button type="button" onClick={followSmooth}>
        send
      </button>
    </div>
  );
}

/** A scroll container with room to scroll: jsdom has no layout, so its geometry is stated. */
function geometry(el: HTMLElement, scrollTop: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 });
  el.scrollTop = scrollTop;
}

describe('ScrollToBottom', () => {
  it('says the model is still working while it is', () => {
    const { rerender } = render(<ScrollToBottom onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy();
    rerender(<ScrollToBottom onClick={() => {}} working />);
    expect(screen.getByRole('button', { name: 'Scroll to bottom, still working' })).toBeTruthy();
  });
});

describe('useFollowScroll', () => {
  afterEach(() => vi.restoreAllMocks());

  it('brings a reader who scrolled up down with a smooth scroll when a message is sent, and keeps following', () => {
    const { rerender } = render(<Page content={1} />);
    const scroller = screen.getByTestId('scroller');
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
    geometry(scroller, 100);
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('at-bottom').textContent).toBe('false');

    fireEvent.click(screen.getByText('send'));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');

    // The scroll animation's own events don't count as the reader scrolling away.
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('at-bottom').textContent).toBe('true');

    // New content in the same moment is followed, still smoothly.
    scrollTo.mockClear();
    act(() => rerender(<Page content={2} />));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
  });

  it('stays where the reader is when they scroll up on their own', () => {
    render(<Page content={1} />);
    const scroller = screen.getByTestId('scroller');
    geometry(scroller, 100);
    fireEvent.scroll(scroller);
    expect(screen.getByTestId('at-bottom').textContent).toBe('false');
  });
});
