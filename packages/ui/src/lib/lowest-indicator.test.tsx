import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { ThinkingDots } from '../components/ui/index.ts';
import { settleIndicators, useLowestIndicatorOnly } from './lowest-indicator.ts';

const flushFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
const superseded = (container: HTMLElement) => [...container.querySelectorAll('[data-thinking-dots]')].map((el) => el.hasAttribute('data-superseded'));

function Column({ rows }: { rows: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLowestIndicatorOnly(ref);
  return (
    <div ref={ref}>
      {Array.from({ length: rows }, (_, i) => (
        <p key={i}>
          <ThinkingDots /> row {i}
        </p>
      ))}
    </div>
  );
}

describe('one running indicator at a time', () => {
  it('hides every indicator above the lowest one', () => {
    const { container } = render(<Column rows={3} />);
    expect(superseded(container)).toEqual([true, true, false]);
  });

  it('shows a single indicator as it is', () => {
    const { container } = render(<Column rows={1} />);
    expect(superseded(container)).toEqual([false]);
  });

  it('follows the transcript as indicators come and go', async () => {
    const { container, rerender } = render(<Column rows={2} />);
    expect(superseded(container)).toEqual([true, false]);
    // A new one appears below: the old lowest steps aside.
    rerender(<Column rows={3} />);
    await flushFrame();
    expect(superseded(container)).toEqual([true, true, false]);
    // The lowest goes away: the one above it comes back.
    rerender(<Column rows={2} />);
    await flushFrame();
    expect(superseded(container)).toEqual([true, false]);
  });

  it('counts what it hid', () => {
    const root = document.createElement('div');
    root.innerHTML = '<i data-thinking-dots></i><i data-thinking-dots></i><i data-thinking-dots></i>';
    expect(settleIndicators(root)).toBe(2);
    expect(settleIndicators(root)).toBe(2);
  });
});
