import { useSyncExternalStore } from 'react';

/**
 * Phone widths: below Tailwind's `md` breakpoint (48rem), where the `max-md:` classes apply. Layout follows those
 * classes; this is for what behaves differently there (the sidebar is a drawer, Settings shows its list or one page).
 */
const QUERY = '(width < 48rem)';

export function isNarrow(): boolean {
  return window.matchMedia(QUERY).matches;
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow);
}

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
