import { useCallback } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { Mode } from '@atelier/protocol';
import { useNarrow } from '../lib/narrow.ts';

/** Opens Settings on top of the current page, optionally scrolled to and highlighting one row. Narrow screens start at the list of pages. */
export function useOpenSettings(): (page?: string, row?: string) => void {
  const navigate = useNavigate();
  const narrow = useNarrow();
  return useCallback(
    (page = narrow ? '' : 'general', row) => void navigate({ to: '.', search: (prev) => ({ ...prev, settings: page, row, memory: undefined }) }),
    [navigate, narrow],
  );
}

export function useCloseSettings(): () => void {
  const navigate = useNavigate();
  return useCallback(() => void navigate({ to: '.', search: (prev) => ({ ...prev, settings: undefined, row: undefined, memory: undefined }) }), [navigate]);
}

/** Opens one memory entry's page in Settings › Memory, or the list without `id`. */
export function useOpenMemory(): (id?: string) => void {
  const navigate = useNavigate();
  return useCallback((id) => void navigate({ to: '.', search: (prev) => ({ ...prev, settings: 'memory', row: undefined, memory: id }) }), [navigate]);
}

/** Where each mode starts: its home page, where a new session is set up before the first message. */
export const MODE_HOME = { chat: '/', work: '/work', code: '/code' } as const satisfies Record<Mode, string>;

/** A session's own page, by its mode. */
export const SESSION_ROUTE = { chat: '/chat/$sessionId', work: '/work/$sessionId', code: '/code/$sessionId' } as const satisfies Record<Mode, string>;

/**
 * Chat, Cowork (`work`) or Code, from the route. The sidebar shows Code's tab in Code and Chat's everywhere else;
 * Customize, which both tabs offer, stays in Code when opened from there (`?mode=code`).
 */
export function useMode(): Mode {
  return useRouterState({ select: (s) => modeOf(s.location.pathname, s.location.search) });
}

export function modeOf(pathname: string, search: { mode?: unknown } = {}): Mode {
  if (pathname === '/customize' && search.mode === 'code') return 'code';
  return (['work', 'code'] as const).find((m) => pathname === `/${m}` || pathname.startsWith(`/${m}/`)) ?? 'chat';
}

/** A new temporary chat: the new-chat page in its temporary state (Chat only). */
export function useNewTemporaryChat(): () => void {
  const navigate = useNavigate();
  return useCallback(() => void navigate({ to: '/', search: { temporary: true } }), [navigate]);
}

/** A new chat (or Cowork task or Code session) starts on its mode's home page; the session is created when the first message is sent. */
export function useNewChat(): () => void {
  const navigate = useNavigate();
  const mode = useMode();
  return useCallback(() => void navigate({ to: MODE_HOME[mode] }), [navigate, mode]);
}
