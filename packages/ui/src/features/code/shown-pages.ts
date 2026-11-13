/**
 * Pages the assistant opened with Preview (packages/core/src/tools/preview.ts): each successful call that arrives while
 * the session is shown opens its page in the Browser pane, or reloads it where a tab already has it. Calls already in the
 * conversation when it is opened don't open anything again.
 */
import { useEffect, useRef } from 'react';
import { previewTarget, type Message, type PreviewTarget } from '@atelier/protocol';

/** Every successful Preview in `messages`, by its call id, oldest first. */
export function previewsIn(messages: readonly Message[]): { id: string; target: PreviewTarget }[] {
  const inputs = new Map<string, unknown>();
  const out: { id: string; target: PreviewTarget }[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_call' && p.name === 'Preview') inputs.set(p.id, p.input);
      else if (p.type === 'tool_result' && !p.isError && inputs.has(p.callId)) {
        const text = p.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
        const target = previewTarget(inputs.get(p.callId), text);
        if (target) out.push({ id: p.callId, target });
      }
    }
  }
  return out;
}

export function useShownPages(messages: readonly Message[], loaded: boolean, onOpen: (target: PreviewTarget) => void): void {
  const seen = useRef<Set<string> | null>(null);
  const callback = useRef(onOpen);
  useEffect(() => {
    callback.current = onOpen;
  });
  useEffect(() => {
    if (!loaded) return;
    const all = previewsIn(messages);
    const before = seen.current;
    seen.current = new Set(all.map((p) => p.id));
    if (!before) return;
    for (const p of all) if (!before.has(p.id)) callback.current(p.target);
  }, [messages, loaded]);
}
