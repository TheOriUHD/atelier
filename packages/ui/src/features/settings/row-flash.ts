import { useEffect, type RefObject } from 'react';
import { prefersReducedMotion } from '../../lib/motion.ts';

const FLASH_MS = 1200;

/**
 * Highlights a row: `data-flash` paints the highlight with transitions off, and removing it two
 * frames later lets the row's 1.2s background transition fade it out. Reduced motion cuts
 * transitions short, so there the highlight is held for 1.2s and then removed without a fade.
 */
export function flashRow(el: HTMLElement): void {
  el.dataset.flash = '';
  const unflash = () => delete el.dataset.flash;
  if (prefersReducedMotion()) setTimeout(unflash, FLASH_MS);
  else requestAnimationFrame(() => requestAnimationFrame(unflash));
}

/**
 * When `row` is set, scrolls that row of `container` into view and flashes it, then calls
 * `onDone` (which clears the `row` search param so the same row can be targeted again).
 */
export function useRowFlash(container: RefObject<HTMLElement | null>, row: string | undefined, onDone: () => void): void {
  useEffect(() => {
    if (!row) return;
    const el = container.current?.querySelector<HTMLElement>(`[data-setting-row="${CSS.escape(row)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      flashRow(el);
    }
    onDone();
  }, [container, row, onDone]);
}
