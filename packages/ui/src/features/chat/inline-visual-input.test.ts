import { describe, expect, it } from 'vitest';
import { visualField } from './inline-visual-input.ts';

describe('streamed inline visual input', () => {
  it('reads partial HTML and escaped strings without field spoofing', () => {
    expect(visualField('{"title":"Waves","html":"<div>Hel', 'html')).toBe('<div>Hel');
    expect(visualField(JSON.stringify({ description: 'the "html":"wrong" field', html: '<button title="Hi">Run</button>\n' }), 'html')).toBe('<button title="Hi">Run</button>\n');
    expect(visualField('{"nested":{"html":"wrong"},"html":"right"}', 'html')).toBe('right');
  });
  it('waits through incomplete escapes and refuses non-string values', () => {
    expect(visualField('{"html":"hello\\', 'html')).toBe('hello');
    expect(visualField('{"html":"hello\\u00', 'html')).toBe('hello');
    expect(visualField('{"html":42}', 'html')).toBeUndefined();
    expect(visualField(undefined, 'html')).toBeUndefined();
  });
});
