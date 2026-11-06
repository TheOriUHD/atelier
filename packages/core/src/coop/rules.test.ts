import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from '@atelier/protocol';
import { COOP_RULES, coopAllows } from './rules.ts';

/** The procedures that act on one session: they take a `sessionId`, or are `sessions.*` taking the session's `id`. */
function sessionProcedures(): string[] {
  return Object.entries(contract.procedures as Record<string, { input: z.ZodType }>).flatMap(([name, { input }]) => {
    const shape = input instanceof z.ZodObject ? (input.shape as Record<string, unknown>) : {};
    const keys = Object.keys(shape);
    if (keys.includes('sessionId')) return [name];
    if (name.startsWith('sessions.') && keys.length > 0 && keys[0] === 'id') return [name];
    return [];
  });
}

describe('what co-op participants may call', () => {
  it('classifies every procedure that takes a session, so a new one is a decision', () => {
    const missing = sessionProcedures().filter((n) => !(n in COOP_RULES));
    expect(missing).toEqual([]);
  });

  it('lists only procedures that exist', () => {
    const procedures = new Set(Object.keys(contract.procedures));
    expect(Object.keys(COOP_RULES).filter((n) => !procedures.has(n))).toEqual([]);
  });

  it('lets viewers watch, editors take part, and keeps the folder and the history to the host', () => {
    expect(coopAllows('sessions.subscribe', 'viewer')).toBe(true);
    expect(coopAllows('chat.send', 'viewer')).toBe(false);
    expect(coopAllows('chat.send', 'editor')).toBe(true);
    for (const p of ['sessions.update', 'chat.switchBranch', 'checkpoints.rewind', 'loops.start', 'sessions.delete']) {
      expect(coopAllows(p, 'editor')).toBe(false);
      expect(coopAllows(p, 'host')).toBe(true);
    }
    // Anything not listed is the owner's.
    expect(coopAllows('terminals.open', 'editor')).toBe(false);
  });
});
