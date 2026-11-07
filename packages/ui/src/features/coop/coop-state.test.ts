import { describe, expect, it } from 'vitest';
import { coopLabel } from '../../app/session-rows.tsx';
import { applyEvent } from '../../lib/live-session.ts';
import { countdown, expiresIn, sharedUseLine, turnOwner } from './coop.ts';
import { ADA, BEN, coopState, guestOf, hosting, liveState, message, summary } from './test-coop.tsx';

describe('the live session in co-op', () => {
  it('keeps who is in, who typed, and whether the host’s computer is away', () => {
    let state = liveState(guestOf);
    state = applyEvent(state, { type: 'presence', participants: [ADA, BEN] });
    expect(state.participants?.map((p) => p.name)).toEqual(['Ada', 'Ben']);
    state = applyEvent(state, { type: 'typing', participantId: ADA.id });
    expect(Object.keys(state.typing ?? {})).toEqual([ADA.id]);
    // Sending ends their typing.
    state = applyEvent(state, { type: 'outbox', items: [{ id: 'q', parts: [{ type: 'text', text: 'hi' }], author: ADA.id }] });
    expect(state.typing).toEqual({});
    state = applyEvent(state, { type: 'host_away', away: true });
    expect(state.hostAway).toBe(true);
    expect(applyEvent(state, { type: 'resync' })).toBe(state);
  });
});

describe('co-op wording', () => {
  it('names a session in the sidebar by who shares it and where it runs', () => {
    expect(coopLabel(summary())).toBeNull();
    expect(coopLabel(hosting)).toEqual({ label: 'Co-op with 1 other', hint: 'co-op with 1 other', host: null });
    expect(coopLabel(guestOf)?.hint).toBe('on Ada’s computer');
    expect(coopLabel(summary({ coop: { role: 'editor', hostName: 'Ada', participants: 3 } }))?.hint).toBe('with Ada');
    expect(coopLabel({ ...guestOf, coop: { ...guestOf.coop!, ended: true } })?.label).toBe('Co-op ended, on Ada’s computer');
  });

  it('counts down, and says when an invite expires', () => {
    expect(countdown(252_000, 0)).toBe('4:12');
    expect(countdown(0, 5000)).toBe('0:00');
    expect(expiresIn(24 * 3600_000, 0)).toBe('Expires in 24 h');
    expect(expiresIn(40 * 60_000, 0)).toBe('Expires in 40 min');
  });

  it('says what a guest used of the host’s models today', () => {
    expect(sharedUseLine(coopState({ sharedUse: { requests: 12, spentUsd: 0.4 } }))).toBe('12 of 50 today · $0.40 of $2.00');
    expect(sharedUseLine(coopState({ sharedUse: { requests: 1, spentUsd: 0 }, settings: { ...coopState().settings, sharedRequestsPerDay: null, sharedSpendPerDayUsd: null } }))).toBe('1 request today');
  });

  it('finds whom the latest turn is for, past Atelier’s own notes', () => {
    const note = message('n', 'user', { parts: [{ type: 'context', text: 'Ada and Ben are here.' }] });
    expect(turnOwner([message('u', 'user', { parts: [{ type: 'text', text: 'go' }], author: BEN.id }), note], ADA.id)).toBe(BEN.id);
    expect(turnOwner([message('u', 'user', { parts: [{ type: 'text', text: 'go' }] })], ADA.id)).toBe(ADA.id);
    expect(turnOwner([message('a', 'assistant', { author: BEN.id })], ADA.id)).toBe(BEN.id);
  });
});
