import { describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { renderForSummary } from './compaction.ts';

describe('inline visual summaries', () => {
  it('keeps the title and explanation, not HTML, without changing stored input', () => {
    const input = { title: 'Orbit', description: 'A planet follows an elliptical orbit.', html: '<script>secretAnimationCode()</script>'.repeat(2000) };
    const message = { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'inline_visual', input }] } as Message;
    const summary = renderForSummary(message);
    expect(summary).toContain('Orbit');
    expect(summary).toContain(input.description);
    expect(summary).not.toContain('secretAnimationCode');
    expect(summary.length).toBeLessThan(250);
    expect(message.parts[0]).toMatchObject({ input });
  });
});
