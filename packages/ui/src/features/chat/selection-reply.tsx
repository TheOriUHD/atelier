/**
 * The "Reply" pill that appears over text selected in a conversation: it quotes the selection in the message box, so
 * the next message is a reply to that passage. It shows once a selection is made (pointer released, or a keyboard
 * selection settled), not while one is being dragged, and never for text in the message box, menus or other controls.
 */
import { useEffect, useState, type RefObject } from 'react';
import { Reply } from 'lucide-react';
import { Icon } from '../../components/ui/index.ts';

interface Pick {
  text: string;
  left: number;
  top: number;
}

/** Height of the pill and the space kept between it and the selection. */
const PILL = 36;
const GAP = 8;

export function SelectionReply({ container, onReply }: { container: RefObject<HTMLElement | null>; onReply(text: string): void }) {
  const [pick, setPick] = useState<Pick | null>(null);

  useEffect(() => {
    const read = () => {
      const root = container.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return setPick(null);
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return setPick(null);
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      if (element?.closest('textarea, input, select, button, [contenteditable="true"], [role="menu"], [data-no-quote]')) return setPick(null);
      const text = selection.toString().trim();
      if (!text) return setPick(null);
      const rects = range.getClientRects();
      const first = rects[0] ?? range.getBoundingClientRect();
      const last = rects[rects.length - 1] ?? first;
      const bounds = root.getBoundingClientRect();
      // Above the first line, at its left; below the last line when there is no room above.
      const above = first.top - PILL - GAP;
      const top = above >= bounds.top + 4 ? above : last.bottom + GAP;
      const left = Math.min(Math.max(first.left, 8), window.innerWidth - 120);
      setPick({ text, left, top });
    };
    // The selection settles after the pointer is released; a keyboard (or script) selection settles by itself.
    let pressed = false;
    let timer: number | undefined;
    const later = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(read, ms);
    };
    const down = () => (pressed = true);
    const up = () => {
      pressed = false;
      later(0);
    };
    const changed = () => {
      if (window.getSelection()?.isCollapsed) {
        window.clearTimeout(timer);
        setPick(null);
      } else if (!pressed) later(150);
    };
    const hideOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPick(null);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('selectionchange', changed);
    document.addEventListener('keydown', hideOnEscape);
    const root = container.current;
    root?.addEventListener('scroll', read, { passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('selectionchange', changed);
      document.removeEventListener('keydown', hideOnEscape);
      root?.removeEventListener('scroll', read);
    };
  }, [container]);

  if (!pick) return null;
  return (
    <button
      type="button"
      aria-label="Reply to the selected text"
      // A press must not clear the selection it is about to quote.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onReply(pick.text);
        window.getSelection()?.removeAllRanges();
        setPick(null);
      }}
      style={{ left: pick.left, top: pick.top }}
      // The hover tint is translucent: laid over the opaque fill (as an image), not in place of it, or the text under the pill shows through.
      className="fixed z-50 flex h-9 items-center gap-2 rounded-xl bg-popover px-3.5 text-body font-medium text-fg shadow-popover inset-ring inset-ring-line outline-none focus-ring hover:bg-[image:linear-gradient(var(--at-color-fill-ghost-hover),var(--at-color-fill-ghost-hover))]"
    >
      Reply
      <Icon icon={Reply} size="sm" />
    </button>
  );
}
