import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Splitter, splitterKey } from './splitter.tsx';
import { TooltipProvider } from './tooltip.tsx';

beforeAll(() => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
});

describe('splitterKey', () => {
  const at = (value: number, orientation: 'vertical' | 'horizontal' = 'vertical') => ({ value, min: 0.2, max: 0.8, orientation });

  it('moves a vertical line with ← and →, a horizontal one with ↑ and ↓, further with Shift', () => {
    expect(splitterKey('ArrowRight', false, at(0.5))).toBeCloseTo(0.52);
    expect(splitterKey('ArrowLeft', true, at(0.5))).toBeCloseTo(0.4);
    expect(splitterKey('ArrowDown', false, at(0.5, 'horizontal'))).toBeCloseTo(0.52);
    expect(splitterKey('ArrowUp', false, at(0.5, 'horizontal'))).toBeCloseTo(0.48);
    expect(splitterKey('ArrowUp', false, at(0.5))).toBeNull();
    expect(splitterKey('ArrowRight', false, at(0.5, 'horizontal'))).toBeNull();
  });

  it('stays between the limits and jumps to them with Home and End', () => {
    expect(splitterKey('ArrowRight', true, at(0.75))).toBe(0.8);
    expect(splitterKey('ArrowLeft', true, at(0.25))).toBe(0.2);
    expect(splitterKey('Home', false, at(0.5))).toBe(0.2);
    expect(splitterKey('End', false, at(0.5))).toBe(0.8);
    expect(splitterKey('Enter', false, at(0.5))).toBeNull();
  });
});

describe('Splitter', () => {
  const setup = (value = 0.5) => {
    const props = { onPreview: vi.fn(), onCommit: vi.fn(), onReset: vi.fn(), measure: () => 400 };
    render(
      <TooltipProvider>
        <Splitter orientation="vertical" label="Resize the panes" value={value} min={0.25} max={0.75} controls="left" {...props} />
      </TooltipProvider>,
    );
    return { ...props, separator: screen.getByRole('separator', { name: 'Resize the panes' }) };
  };

  it('is a focusable separator that tells where it is', () => {
    const { separator } = setup(0.4);
    expect(separator.tabIndex).toBe(0);
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-valuenow')).toBe('40');
    expect(separator.getAttribute('aria-valuemin')).toBe('25');
    expect(separator.getAttribute('aria-valuemax')).toBe('75');
    expect(separator.getAttribute('aria-controls')).toBe('left');
  });

  it('keeps each arrow key press and resets on double-click', () => {
    const { separator, onCommit, onReset } = setup();
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenLastCalledWith(0.48);
    fireEvent.keyDown(separator, { key: 'End' });
    expect(onCommit).toHaveBeenLastCalledWith(0.75);
    fireEvent.keyDown(separator, { key: 'a' });
    expect(onCommit).toHaveBeenCalledTimes(2);
    fireEvent.doubleClick(separator);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('previews a drag frame by frame and keeps where it ends, within the limits', async () => {
    const { separator, onPreview, onCommit } = setup();
    fireEvent.pointerDown(separator, { button: 0, clientX: 200, pointerId: 1 });
    expect(document.documentElement.dataset.resizing).toBe('vertical');
    fireEvent.pointerMove(separator, { clientX: 240, pointerId: 1 });
    await new Promise((r) => requestAnimationFrame(r));
    expect(onPreview).toHaveBeenLastCalledWith(0.6);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerMove(separator, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(separator, { clientX: 600, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(0.75);
    expect(document.documentElement.dataset.resizing).toBeUndefined();
  });

  it('puts the panes back when a drag is cancelled', () => {
    const { separator, onPreview, onCommit } = setup();
    fireEvent.pointerDown(separator, { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 220, pointerId: 1 });
    fireEvent.pointerCancel(separator, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(0.5);
  });
});
