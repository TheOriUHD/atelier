import { useRef, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRowFlash } from './row-flash.ts';

function Rows({ initialRow, onDone }: { initialRow?: string; onDone: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState(initialRow);
  useRowFlash(container, row, () => {
    onDone();
    setRow(undefined);
  });
  return (
    <div ref={container}>
      <div data-setting-row="appearance.theme">Theme</div>
      <div data-setting-row="appearance.motion">Motion</div>
      <button type="button" onClick={() => setRow('appearance.motion')}>
        Go to motion
      </button>
    </div>
  );
}

describe('useRowFlash', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    scrollIntoView.mockReset();
  });

  it('scrolls the target row into view, flashes it and clears the target', async () => {
    const onDone = vi.fn();
    render(<Rows initialRow="appearance.motion" onDone={onDone} />);
    const motion = screen.getByText('Motion');

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(motion);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(motion.hasAttribute('data-flash')).toBe(true);
    expect(screen.getByText('Theme').hasAttribute('data-flash')).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);

    // The highlight is painted for a frame, then removed so the row's transition fades it out.
    await waitFor(() => expect(motion.hasAttribute('data-flash')).toBe(false));
  });

  it('flashes the same row again when it is targeted again', async () => {
    const onDone = vi.fn();
    render(<Rows initialRow="appearance.motion" onDone={onDone} />);
    const motion = screen.getByText('Motion');
    await waitFor(() => expect(motion.hasAttribute('data-flash')).toBe(false));

    act(() => screen.getByRole('button', { name: 'Go to motion' }).click());

    expect(motion.hasAttribute('data-flash')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it('holds the highlight for 1.2s without a fade when motion is reduced', () => {
    vi.useFakeTimers();
    document.documentElement.dataset.motion = 'reduced';
    try {
      render(<Rows initialRow="appearance.motion" onDone={vi.fn()} />);
      const motion = screen.getByText('Motion');
      act(() => vi.advanceTimersByTime(1100));
      expect(motion.hasAttribute('data-flash')).toBe(true);
      act(() => vi.advanceTimersByTime(100));
      expect(motion.hasAttribute('data-flash')).toBe(false);
    } finally {
      delete document.documentElement.dataset.motion;
      vi.useRealTimers();
    }
  });

  it('clears an unknown target without scrolling', () => {
    const onDone = vi.fn();
    render(<Rows initialRow="nope" onDone={onDone} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
