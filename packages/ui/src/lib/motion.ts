import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** Reduced motion: the system preference, or Settings › Appearance › Motion (`data-motion` on <html>). */
export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduced' || window.matchMedia(QUERY).matches;
}

function subscribe(changed: () => void): () => void {
  const query = window.matchMedia(QUERY);
  const observer = new MutationObserver(changed);
  query.addEventListener('change', changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => {
    query.removeEventListener('change', changed);
    observer.disconnect();
  };
}

/** `prefersReducedMotion`, kept current while either setting changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion);
}
