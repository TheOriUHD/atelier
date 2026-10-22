import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from './progress-bar.tsx';
import { ProgressRing, progressRingTone } from './progress-ring.tsx';

describe('ProgressRing', () => {
  it.each([
    [0, 'muted'],
    [0.6, 'muted'],
    [0.749, 'muted'],
    [0.75, 'warning'],
    [0.9, 'warning'],
    [0.901, 'danger'],
    [1, 'danger'],
    [1.4, 'danger'],
    [-1, 'muted'],
  ] as const)('maps %s to the %s tone', (value, tone) => {
    expect(progressRingTone(value)).toBe(tone);
  });

  it.each([
    [0.3, 'text-fg-muted', '30'],
    [0.8, 'text-warning', '80'],
    [0.93, 'text-danger', '93'],
  ] as const)('renders %s with %s and aria-valuenow %s', (value, colorClass, now) => {
    render(<ProgressRing value={value} aria-label="Context used" />);
    const ring = screen.getByRole('progressbar', { name: 'Context used' });
    expect(ring.getAttribute('class')).toContain(colorClass);
    expect(ring.getAttribute('aria-valuenow')).toBe(now);
    expect(ring.getAttribute('aria-valuemin')).toBe('0');
    expect(ring.getAttribute('aria-valuemax')).toBe('100');
    expect(ring.getAttribute('width')).toBe('16');
  });

  it('draws the arc in proportion to the value', () => {
    const { container } = render(<ProgressRing value={0.25} aria-label="Context used" />);
    const arc = container.querySelectorAll('circle')[1]!;
    const circumference = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.75);
  });
});

describe('ProgressBar', () => {
  it('is a 4px rounded track with an interactive fill', () => {
    render(<ProgressBar value={0.42} aria-label="Weekly usage" />);
    const bar = screen.getByRole('progressbar', { name: 'Weekly usage' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.className.split(' ')).toEqual(expect.arrayContaining(['h-1', 'rounded-full', 'bg-progress-track']));
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-interactive');
    expect(fill.style.width).toBe('42%');
  });

  it('clamps out-of-range values', () => {
    render(<ProgressBar value={3} aria-label="Usage" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });
});
