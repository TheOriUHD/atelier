import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingInteraction } from '@atelier/protocol';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { InteractionCard, lentTool } from '../code/interaction-card.tsx';
import { ADA, BEN, coopState, guestOf, hosting, liveState, renderCoop } from './test-coop.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

beforeEach(() => resetBackend({ 'chat.respond': () => ({ ok: true }) }));

const bash = (extra: Partial<PendingInteraction> = {}): PendingInteraction => ({
  kind: 'permission',
  id: 'i1',
  payload: { callId: 'c1', toolName: 'Bash', input: { command: 'npm install', description: 'install the packages' }, reason: 'Bash needs your approval.', suggestedRule: 'Bash(npm install *)' },
  approver: ADA.id,
  ...extra,
});

const asBen = (trusted = false) => coopState({ sessionId: guestOf.id, me: BEN.id, role: 'editor', participants: [ADA, { ...BEN, trusted }] });

describe('approvals in a shared session', () => {
  it('show someone else’s question read-only, with the time left before it is denied', async () => {
    const pending = bash({ expiresAt: Date.now() + 252_000 });
    renderCoop(<InteractionCard sessionId={guestOf.id} pending={pending} />, { live: liveState(guestOf), state: asBen() });
    const card = await screen.findByRole('region', { name: 'Waiting for Ada to approve' });
    expect(within(card).getByText('Waiting for Ada to approve…')).toBeTruthy();
    expect(card.textContent).toContain('Allow Atelier to run install the packages?');
    expect(card.textContent).toContain('npm install');
    expect(within(card).getByText(/^Denied in 4:1[12] unless Ada answers\.$/)).toBeTruthy();
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('let a guest the host trusts answer the host’s, for this session at most', async () => {
    renderCoop(<InteractionCard sessionId={guestOf.id} pending={bash()} />, { live: liveState(guestOf), state: asBen(true) });
    const card = await screen.findByRole('region', { name: 'Allow Atelier to run install the packages?' });
    expect(within(card).queryByRole('button', { name: 'Always allow' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Allow for this session' }));
    await waitFor(() => expect(callsTo('chat.respond')).toEqual([{ sessionId: guestOf.id, interactionId: 'i1', answer: { behavior: 'allow', remember: 'session' } }]));
  });

  it('ask a guest about their own connector, named without its prefix', async () => {
    const pending = bash({ approver: BEN.id, payload: { callId: 'c1', toolName: 'coop_ben__get_issue', input: { number: 7 }, reason: 'Your connector asks first.', suggestedRule: '' } });
    renderCoop(<InteractionCard sessionId={guestOf.id} pending={pending} />, { live: liveState(guestOf), state: asBen() });
    const card = await screen.findByRole('region', { name: 'Allow Atelier to use get_issue?' });
    expect(within(card).getByText('Your connector')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(callsTo('chat.respond')).toHaveLength(1));
  });

  it('show the host a guest’s connector question as theirs to answer, not the host’s', async () => {
    const pending = bash({ approver: BEN.id, payload: { callId: 'c1', toolName: 'coop_ben__get_issue', input: {}, reason: '', suggestedRule: '' }, expiresAt: Date.now() + 61_000 });
    renderCoop(<InteractionCard sessionId={hosting.id} pending={pending} />, { live: liveState(hosting), state: coopState() });
    const card = await screen.findByRole('region', { name: 'Waiting for Ben to approve' });
    expect(card.textContent).toContain('Allow Atelier to use get_issue?');
    expect(within(card).getByText(/^Denied in 1:0[01] unless Ben answers\.$/)).toBeTruthy();
  });

  it('name a lent connector’s tool by its own name', () => {
    expect(lentTool('coop_k3Y-9__mcp__github__get_issue')).toBe('mcp__github__get_issue');
    expect(lentTool('mcp__github__get_issue')).toBeNull();
    expect(lentTool('Bash')).toBeNull();
  });
});
