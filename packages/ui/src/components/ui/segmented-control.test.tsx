import { act, fireEvent, render, screen } from '@testing-library/react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl, type SegmentedControlItem } from './segmented-control.tsx';

const WIDTHS: SegmentedControlItem<'narrow' | 'medium' | 'wide'>[] = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'medium', label: 'Medium' },
  { value: 'wide', label: 'Wide' },
];

describe('SegmentedControl', () => {
  it('renders a labelled radio group on the segmented track', () => {
    render(<SegmentedControl aria-label="Transcript width" items={WIDTHS} defaultValue="medium" />);
    const group = screen.getByRole('radiogroup', { name: 'Transcript width' });
    expect(group.className).toEqual(expect.stringContaining('bg-segmented-track'));
    expect(group.className.split(' ')).toEqual(expect.arrayContaining(['h-8', 'rounded-lg', 'p-px']));

    const medium = screen.getByRole('radio', { name: 'Medium' });
    expect(medium.getAttribute('aria-checked')).toBe('true');
    expect(medium.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-[30px]',
        'px-3',
        'rounded-sm',
        'text-body',
        'text-fg-secondary',
        'data-checked:text-fg',
      ]),
    );
    expect(screen.getByRole('radio', { name: 'Narrow' }).getAttribute('aria-checked')).toBe('false');
  });

  it('has a thumb that slides with the selection', () => {
    const { container } = render(<SegmentedControl aria-label="Width" items={WIDTHS} />);
    const thumb = container.querySelector('[aria-hidden="true"]');
    expect(thumb?.className).toContain('bg-segmented-thumb');
    expect(thumb?.className).toContain('shadow-field-drop');
    expect(thumb?.className).toContain('data-ready:duration-(--at-duration-base)');
    expect(thumb?.className).toContain('data-ready:ease-out');
    expect(thumb?.hasAttribute('data-ready')).toBe(true);
  });

  it('moves the selection with the arrow keys', async () => {
    const onValueChange = vi.fn();
    render(<SegmentedControl aria-label="Width" items={WIDTHS} defaultValue="narrow" onValueChange={onValueChange} />);
    const narrow = screen.getByRole('radio', { name: 'Narrow' });

    act(() => narrow.focus());
    // Base UI moves focus in a microtask; focusing a radio after an arrow key checks it.
    await act(async () => {
      fireEvent.keyDown(narrow, { key: 'ArrowRight' });
    });

    const medium = screen.getByRole('radio', { name: 'Medium' });
    expect(document.activeElement).toBe(medium);
    expect(medium.getAttribute('aria-checked')).toBe('true');
    expect(narrow.getAttribute('aria-checked')).toBe('false');
    expect(onValueChange).toHaveBeenLastCalledWith('medium');

    await act(async () => {
      fireEvent.keyDown(medium, { key: 'ArrowLeft' });
    });
    expect(screen.getByRole('radio', { name: 'Narrow' }).getAttribute('aria-checked')).toBe('true');
    expect(onValueChange).toHaveBeenLastCalledWith('narrow');
  });

  it('selects on click and follows a controlled value', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl aria-label="Width" items={WIDTHS} value="wide" onValueChange={onValueChange} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Narrow' }));
    expect(onValueChange).toHaveBeenCalledWith('narrow');
    // Controlled: nothing changes until the parent updates the value.
    expect(screen.getByRole('radio', { name: 'Wide' }).getAttribute('aria-checked')).toBe('true');

    rerender(<SegmentedControl aria-label="Width" items={WIDTHS} value="narrow" onValueChange={onValueChange} />);
    expect(screen.getByRole('radio', { name: 'Narrow' }).getAttribute('aria-checked')).toBe('true');
  });

  it('renders 30×30 icon segments named by their labels', () => {
    render(
      <SegmentedControl
        aria-label="Theme"
        variant="icon"
        items={[
          { value: 'light', label: 'Light', icon: Sun },
          { value: 'dark', label: 'Dark', icon: Moon },
          { value: 'system', label: 'System', icon: Monitor },
        ]}
        defaultValue="system"
      />,
    );
    const system = screen.getByRole('radio', { name: 'System' });
    expect(system.getAttribute('aria-checked')).toBe('true');
    expect(system.className.split(' ')).toEqual(expect.arrayContaining(['h-[30px]', 'w-[30px]']));
    expect(system.textContent).toBe('');
    expect(system.querySelector('svg')).not.toBeNull();
  });
});
