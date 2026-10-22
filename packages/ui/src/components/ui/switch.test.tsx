import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './switch.tsx';

describe('Switch', () => {
  it('toggles between off and on', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Web search" onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Web search' });

    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.hasAttribute('data-unchecked')).toBe(true);

    fireEvent.click(control);

    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.hasAttribute('data-checked')).toBe(true);
  });

  it('styles the off, hover and on tracks with the switch tokens', () => {
    render(<Switch aria-label="Memory" defaultChecked />);
    const control = screen.getByRole('switch');
    expect(control.className).toContain('bg-switch-track');
    expect(control.className).toContain('data-unchecked:hover:bg-switch-track-hover');
    expect(control.className).toContain('data-checked:bg-interactive');
    const thumb = control.querySelector('span');
    expect(thumb?.className).toContain('ease-overshoot');
    expect(thumb?.hasAttribute('data-checked')).toBe(true);
  });

  it.each([
    ['md', ['h-5', 'w-9'], ['size-4', 'data-checked:translate-x-4']],
    ['sm', ['h-[18px]', 'w-8'], ['size-3.5', 'data-checked:translate-x-3.5']],
  ] as const)('sizes %s track and knob', (size, track, knob) => {
    render(<Switch aria-label="Toggle" size={size} />);
    const control = screen.getByRole('switch');
    const classes = control.className.split(' ');
    track.forEach((name) => expect(classes).toContain(name));
    const knobClasses = control.querySelector('span')?.className.split(' ') ?? [];
    knob.forEach((name) => expect(knobClasses).toContain(name));
  });

  it('ignores clicks when disabled', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Toggle" disabled onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch');
    fireEvent.click(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(control.hasAttribute('data-disabled')).toBe(true);
    expect(control.className).toContain('data-disabled:opacity-40');
  });
});
