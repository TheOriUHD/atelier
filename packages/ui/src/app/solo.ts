/**
 * A window opened for one session ("Open in › New window"): the session's page and nothing around it, no sidebar. It
 * is decided when the window loads, from its address, so what the session navigates to doesn't bring the sidebar back.
 */
export const SOLO_PARAM = 'solo=1';

export function isSoloHash(hash: string): boolean {
  return /[?&]solo=1(?:&|$)/.test(hash);
}

export const solo = typeof window !== 'undefined' && isSoloHash(window.location.hash);
