/**
 * The fullscreen view's conversation: a window onto it that follows the newest lines, and scrolls with the mouse wheel
 * (or trackpad) and Page Up/Down. Scrolled up, it holds its place while replies come in and says there is more below;
 * scrolled to the bottom again (or `follow` changing, as when a message is sent), it follows again. A click on a row
 * wrapped in `Clickable` tells `onClick` which one; the window then holds still, so the row opens downwards where it is.
 */
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink';
import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Paint } from '../style.ts';
import type { Mouse } from './mouse.ts';

/** The rows a click can reach, by id. */
type Targets = Map<string, DOMElement>;
const TargetsContext = createContext<Targets | null>(null);

/** A row a click opens or closes (in the fullscreen view with the mouse on; elsewhere just its children). */
export function Clickable({ id, children }: { id: string; children: ReactNode }) {
  const targets = use(TargetsContext);
  const ref = useRef<DOMElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!targets || !el) return;
    targets.set(id, el);
    return () => void (targets.get(id) === el && targets.delete(id));
  }, [targets, id]);
  if (!targets) return <>{children}</>;
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  );
}

/** How far `el` sits below `ancestor` (layout rows, before any scrolling). */
function topWithin(el: DOMElement, ancestor: DOMElement): number | null {
  let top = 0;
  for (let node: DOMElement | undefined = el; node; node = node.parentNode) {
    if (node === ancestor) return top;
    top += node.yogaNode?.getComputedLayout().top ?? 0;
  }
  return null;
}

export function Scroller({ paint, mouse, active, follow, onClick, children }: { paint: Paint; mouse: Mouse | null; active: boolean; follow: number; onClick?: (id: string) => void; children: ReactNode }) {
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
  const offset = anchor === null ? max : Math.min(anchor, max);
  const below = max - offset;
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
  const [targets] = useState<Targets>(() => new Map());
  const clicked = useRef(onClick);
  useEffect(() => {
    clicked.current = onClick;
  });
  useEffect(() => mouse?.onWheel((lines) => scroll.current(lines)), [mouse]);
  useEffect(
    () =>
      mouse?.onClick(({ y }) => {
        const port = viewport.current;
        const inside = content.current;
        if (!port || !inside || !clicked.current) return;
        // As the screen shows it now: the window's first row (the app fills the screen from its top), its height and how
        // far it is scrolled, then the line of the conversation under the pointer.
        let portTop = 0;
        for (let node: DOMElement | undefined = port; node; node = node.parentNode) portTop += node.yogaNode?.getComputedLayout().top ?? 0;
        const page = port.yogaNode?.getComputedLayout().height ?? 0;
        const offset = Number(port.style.contentOffsetY) || 0;
        if (y < portTop || y >= portTop + page) return;
        const line = y - portTop + offset;
        for (const [id, el] of targets) {
          const top = topWithin(el, inside);
          const height = el.yogaNode?.getComputedLayout().height ?? 0;
          if (top === null || line < top || line >= top + height) continue;
          // Hold the window where it is, so what opens grows downwards under the pointer.
          setAnchor(offset);
          clicked.current(id);
          return;
        }
      }),
    [mouse, targets],
  );
  useInput(
    (_input, key) => {
      if (key.pageUp) scroll.current(-Math.max(1, size.current.page - 2));
      if (key.pageDown) scroll.current(Math.max(1, size.current.page - 2));
    },
    { isActive: active },
  );
  return (
    <TargetsContext value={mouse && onClick ? targets : null}>
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
    </TargetsContext>
  );
}
