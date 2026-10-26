/**
 * Computer use screenshots in a request (ARCHITECTURE §22): only the newest few go to the model, older ones become a
 * line of text. They leave in blocks, so the request's cached start changes once every few screenshots, not with
 * each one. The stored conversation keeps them all.
 */
import type { Message, Part } from '@atelier/protocol';

/** Tools whose results carry screenshots. */
const SCREENSHOT_TOOLS = new Set(['Screenshot', 'ComputerAction']);
const LEFT_OUT: Part = { type: 'text', text: '[An earlier screenshot, left out]' };

export function keepRecentScreenshots(messages: Message[], keep: number, step = 5): Message[] {
  const tools = new Map<string, string>();
  for (const m of messages) for (const p of m.parts) if (p.type === 'tool_call') tools.set(p.id, p.name);
  const isScreenshotResult = (p: Part) => p.type === 'tool_result' && SCREENSHOT_TOOLS.has(tools.get(p.callId) ?? '');
  let total = 0;
  for (const m of messages) for (const p of m.parts) if (isScreenshotResult(p) && p.type === 'tool_result') total += p.content.filter((c) => c.type === 'image').length;
  let drop = Math.floor(Math.max(0, total - keep) / step) * step;
  if (!drop) return messages;
  return messages.map((m) => {
    if (!drop || !m.parts.some(isScreenshotResult)) return m;
    const parts = m.parts.map((p) => {
      if (!drop || !isScreenshotResult(p) || p.type !== 'tool_result') return p;
      const content = p.content.map((c) => (c.type === 'image' && drop > 0 ? (drop--, LEFT_OUT) : c));
      return { ...p, content } as Part;
    });
    return { ...m, parts };
  });
}
