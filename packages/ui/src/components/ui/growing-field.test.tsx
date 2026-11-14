import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GrowingField } from './text-field.tsx';

describe('GrowingField', () => {
  it('sends its form with Enter, starts a new line with Shift+Enter, and is a plain field outside a form', () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <GrowingField aria-label="What should change" value="Make it shorter" onChange={() => {}} />
      </form>,
    );
    const field = screen.getByRole('textbox', { name: 'What should change' });
    expect(field.tagName).toBe('TEXTAREA');
    expect(field.getAttribute('rows')).toBe('1');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('grows with its text up to its last row, then scrolls', () => {
    const tall = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    try {
      render(<GrowingField aria-label="Answer" value={'a\n'.repeat(20)} onChange={() => {}} maxRows={4} />);
      const field = screen.getByRole('textbox', { name: 'Answer' });
      // Four rows of 20 and the padding, then it scrolls.
      expect(field.style.height).toBe('92px');
      expect(field.className).toContain('overflow-y-auto');
    } finally {
      tall.mockRestore();
    }
  });
});
