import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@atelier/protocol';
import { keepRecentScreenshots } from './screenshots.ts';

let n = 0;
/** An assistant step calling `tool` and its result carrying one image. */
function step(tool: string): Message[] {
  const id = `c${++n}`;
  return [
    { id: `a${n}`, role: 'assistant', parts: [{ type: 'tool_call', id, name: tool, input: {} }], createdAt: 0 } as unknown as Message,
    { id: `r${n}`, role: 'user', parts: [{ type: 'tool_result', callId: id, content: [{ type: 'text', text: `shot ${n}` }, { type: 'image', mime: 'image/jpeg', blob: `b${n}` }] }], createdAt: 0 } as unknown as Message,
  ];
}
const images = (messages: Message[]) =>
  messages.flatMap((m) => m.parts.flatMap((p: Part) => (p.type === 'tool_result' ? p.content.filter((c) => c.type === 'image').map((c) => (c as { blob: string }).blob) : [])));

describe('keepRecentScreenshots', () => {
  it('leaves screenshots out in blocks, the oldest first, keeping at least the newest few', () => {
    n = 0;
    const seven = Array.from({ length: 7 }, (_, i) => step(i % 2 ? 'ComputerAction' : 'Screenshot')).flat();
    // 7 with 3 kept: not yet a block of 5 to drop.
    expect(keepRecentScreenshots(seven, 3)).toBe(seven);
    const eight = [...seven, ...step('Screenshot')];
    const kept = keepRecentScreenshots(eight, 3);
    expect(images(kept)).toEqual(['b6', 'b7', 'b8']);
    // What a left-out screenshot becomes, and its text stays.
    const first = kept[1]!.parts[0] as Extract<Part, { type: 'tool_result' }>;
    expect(first.content).toEqual([
      { type: 'text', text: 'shot 1' },
      { type: 'text', text: '[An earlier screenshot, left out]' },
    ]);
    // The stored conversation isn't changed.
    expect(images(eight)).toHaveLength(8);
  });

  it("leaves other tools' images alone", () => {
    n = 0;
    const messages = [...Array.from({ length: 6 }, () => step('Read')).flat(), ...step('Screenshot')];
    expect(keepRecentScreenshots(messages, 1)).toBe(messages);
  });
});
