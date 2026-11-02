import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@atelier/protocol';
import { keepRecentGenerated, keepRecentScreenshots } from './screenshots.ts';

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

describe('keepRecentGenerated', () => {
  const generated = (id: string): Message[] => [
    { id: `a${id}`, sessionId: 's', parentId: null, role: 'assistant', parts: [{ type: 'tool_call', id, name: 'GenerateImage', input: {} }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 },
    { id: `t${id}`, sessionId: 's', parentId: null, role: 'tool', parts: [{ type: 'tool_result', callId: id, content: [{ type: 'text', text: `made img_${id}` }, { type: 'image', mime: 'image/png', blob: id }] }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 },
  ];
  const texts = (messages: Message[]) => messages.flatMap((m) => m.parts).flatMap((p) => (p.type === 'tool_result' ? p.content : []));

  it('drops old images in steps, keeping their ids in the text', () => {
    const history = [...'abcdefghij'].flatMap(generated);
    const kept = texts(keepRecentGenerated(history, 4));
    expect(kept.filter((c) => c.type === 'image')).toHaveLength(6);
    expect(kept.filter((c) => c.type === 'text' && c.text.startsWith('made img_'))).toHaveLength(10);
    expect(kept.filter((c) => c.type === 'text' && c.text === '[An earlier image, left out]')).toHaveLength(4);
  });

  it('leaves screenshots alone', () => {
    const history: Message[] = [
      { id: 'a', sessionId: 's', parentId: null, role: 'assistant', parts: [{ type: 'tool_call', id: 'x', name: 'Screenshot', input: {} }], model: null, usage: null, stopReason: null, error: null, kind: 'normal', summarizesThroughId: null, createdAt: 0 },
      ...Array.from({ length: 1 }, () => generated('b')).flat(),
    ];
    expect(keepRecentGenerated(history, 0, 1).flatMap((m) => m.parts).some((p) => p.type === 'tool_call' && p.name === 'Screenshot')).toBe(true);
  });
});
