import { describe, expect, it } from 'vitest';
import { cn } from './cn.ts';

describe('cn', () => {
  it('keeps named text sizes and text colors apart', () => {
    expect(cn('text-body text-fg', 'text-fg-muted')).toBe('text-body text-fg-muted');
    expect(cn('text-body text-fg', 'text-footnote')).toBe('text-fg text-footnote');
  });
  it('lets later utilities override earlier ones', () => {
    expect(cn('px-0.5 rounded-lg', 'px-2 rounded-composer')).toBe('px-2 rounded-composer');
    expect(cn('shadow-sm', 'shadow-popover')).toBe('shadow-popover');
  });
});
