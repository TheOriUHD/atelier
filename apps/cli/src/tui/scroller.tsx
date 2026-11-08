/**
 * The fullscreen view's conversation: a window onto it that follows the newest lines, and scrolls with the mouse wheel
 * (or trackpad) and Page Up/Down. Scrolled up, it holds its place while replies come in and says there is more below;
 * scrolled to the bottom again (or `follow` changing, as when a message is sent), it follows again.
 */
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Paint } from '../style.ts';
import type { Wheel } from './mouse.ts';

export function Scroller({ paint, wheel, active, follow, children }: { paint: Paint; wheel: Wheel | null; active: boolean; follow: number; children: ReactNode }) {
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const view = useBoxMetrics(viewport);
  const body = useBoxMetrics(content);
  const max = Math.max(0, body.height - view.height);
  /** Lines from the top while scrolled up; null while following the bottom. */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [followed, setFollowed] = useState(follow);
  if (followed !== follow) {
    setFollowed(follow);
    setAnchor(null);
  }
  // The wheel and the keys act outside drawing, so they read the sizes from here.
  const size = useRef({ max, page: view.height });
  useEffect(() => {
    size.current = { max, page: view.height };
  });
  const scroll = useRef((lines: number) =>
    setAnchor((a) => {
      const to = Math.max(0, (a ?? size.current.max) + lines);
      return to >= size.current.max ? null : to;
    }),
  );
  useEffect(() => wheel?.on((lines) => scroll.current(lines)), [wheel]);
  useInput(
    (_input, key) => {
      if (key.pageUp) scroll.current(-Math.max(1, size.current.page - 2));
      if (key.pageDown) scroll.current(Math.max(1, size.current.page - 2));
    },
    { isActive: active },
  );
  const offset = anchor === null ? max : Math.min(anchor, max);
  const below = max - offset;
  return (
    <>
      {/* The space left over (basis 0): sized by its content, it would squeeze what is below it. */}
      <Box ref={viewport} flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} overflow="hidden" contentOffsetY={offset}>
        <Box ref={content} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      {/* Always one row, blank while following: the window keeps its size when scrolling starts (nothing jumps). */}
      <Box flexShrink={0} height={1}>
        <Text>{anchor !== null && below > 0 ? paint.fg('muted', `  ↓ ${below} more ${below === 1 ? 'line' : 'lines'} below · scroll down or Page Down`) : ' '}</Text>
      </Box>
    </>
  );
}
