import { describe, expect, it } from 'vitest';
import type { Message } from '@atelier/protocol';
import { HANDOFF_HEADING, handoffOf, renderForSummary, renderHandoff, splitHandoff } from './compaction.ts';

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

describe('the handoff', () => {
  it('is taken out of the summary, the last block counting, with its headings below the one it is stored under', () => {
    const written = '## Requests\nShip it.\n\n<handoff>\n## Goal\nold\n</handoff>\n\n<handoff>\n## Goal\nA release on Friday.\n## Limits\n- don\'t touch `migrations/`\n</handoff>\n';
    expect(splitHandoff(written)).toEqual({ summary: '## Requests\nShip it.', handoff: '#### Goal\nA release on Friday.\n#### Limits\n- don\'t touch `migrations/`' });
  });

  it('is none when the summarizer wrote none, or was cut off inside it, and the half block is not kept in the summary', () => {
    expect(splitHandoff('## Requests\nShip it.')).toEqual({ summary: '## Requests\nShip it.', handoff: null });
    expect(splitHandoff('## Requests\nShip it.\n\n<handoff>\n## Goal\nA rel')).toEqual({ summary: '## Requests\nShip it.', handoff: null });
    expect(splitHandoff('Text\n<handoff>\n</handoff>')).toEqual({ summary: 'Text', handoff: null });
  });

  it('is read back from a stored summary, everything after its heading', () => {
    const summary = (text: string) => ({ kind: 'compaction_summary', role: 'user', parts: [{ type: 'text', text }] }) as Message;
    const handoff = '#### Goal\nA release on Friday.';
    expect(handoffOf(summary(`Summary\n\n## Carried over verbatim\n\n### Todo list\n- [ ] x\n\n${renderHandoff(handoff)}`))).toBe(handoff);
    expect(handoffOf(summary('Summary without one'))).toBeNull();
    expect(handoffOf({ kind: 'normal', role: 'user', parts: [{ type: 'text', text: `${HANDOFF_HEADING}\n\nx` }] } as Message)).toBeNull();
    expect(handoffOf(undefined)).toBeNull();
  });
});
