/**
 * One running indicator at a time. Parts of a transcript each draw their own animated dots (the thinking block, a tool
 * call, an artifact being written, the status row at the end), and two of them on screen at once look cheap. Inside
 * `root` only the lowest is drawn; the ones above it are marked and hidden by CSS (components/ui/thinking-dots.css), and
 * come back by themselves when the lowest goes away (a run of tool calls ends, the status row leaves).
 */
import { useEffect, type RefObject } from 'react';

const DOTS = '[data-thinking-dots]';

/** Marks every indicator in `root` but the last (DOM order is visual order in a transcript). Returns how many it hid. */
export function settleIndicators(root: ParentNode): number {
  const dots = root.querySelectorAll<HTMLElement>(DOTS);
  let hidden = 0;
  dots.forEach((el, i) => {
    const superseded = i < dots.length - 1;
    if (superseded) hidden++;
    if (el.hasAttribute('data-superseded') !== superseded) el.toggleAttribute('data-superseded', superseded);
  });
  return hidden;
}

export function useLowestIndicatorOnly(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    // Elements coming and going are the only changes that matter; once per frame is plenty while a reply streams.
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), void settleIndicators(root)));
    });
    observer.observe(root, { childList: true, subtree: true });
    settleIndicators(root);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
