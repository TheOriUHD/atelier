import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP, defaultUserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { releaseNotesFor, RELEASE_NOTES } from './release-notes.ts';
import { WhatsNewDialog, WhatsNewHost } from './whats-new.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
// A development build has no notes of its own; the host is tested as if this version had them.
vi.mock('./release-notes.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./release-notes.ts')>();
  return { ...real, releaseNotesFor: vi.fn(real.releaseNotesFor) };
});

const notes = RELEASE_NOTES[0]!;

function mount(ui = <WhatsNewHost />) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Preferences as the backend keeps them, with this person's last seen version. */
const prefsWith = (seen: string | null) => ({ ...defaultUserPrefs(), whatsNew: { seen } });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(releaseNotesFor).mockImplementation(() => notes);
});
afterEach(() => vi.useRealTimers());

const later = () => act(async () => void vi.advanceTimersByTime(1000));

describe('the release notes', () => {
  it('are written for a version, newest first, each with highlights', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
    const versions = RELEASE_NOTES.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const n of RELEASE_NOTES) {
      expect(n.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(n.highlights.length).toBeGreaterThan(0);
      for (const h of n.highlights) expect(h.body.length).toBeGreaterThan(40);
    }
  });
});

describe('the dialog', () => {
  it('shows the version, each highlight and the smaller changes, and closes on "Got it"', () => {
    const onOpenChange = vi.fn();
    mount(<WhatsNewDialog notes={notes} open onOpenChange={onOpenChange} />);
    const dialog = screen.getByRole('dialog', { name: new RegExp(`What’s new in Atelier\\s*${notes.version}`) });
    for (const h of notes.highlights) expect(dialog.textContent).toContain(h.title);
    expect(dialog.textContent).toContain('Also in this version');
    for (const line of notes.also) expect(dialog.textContent).toContain(line);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('the host', () => {
  it('shows the notes once after an update, and remembers it was seen', async () => {
    resetBackend({ 'prefs.get': () => prefsWith('0.0.1'), 'prefs.set': () => prefsWith(APP.version) });
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    await later();
    expect(await screen.findByRole('dialog', { name: /What’s new in Atelier/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['whatsNew', 'seen'], value: APP.version }]));
  });

  it('says nothing for a version already seen', async () => {
    resetBackend({ 'prefs.get': () => prefsWith(APP.version) });
    mount();
    await later();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo('prefs.set')).toEqual([]);
  });

  it('only records the version on a new install, where there is nothing to catch up on', async () => {
    resetBackend({ 'prefs.get': () => prefsWith(null), 'sessions.list': () => [], 'prefs.set': () => prefsWith(APP.version) });
    mount();
    await later();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['whatsNew', 'seen'], value: APP.version }]));
  });

  it('shows the notes to someone who already uses Atelier and has not seen any yet', async () => {
    resetBackend({ 'prefs.get': () => prefsWith(null), 'sessions.list': () => [{ id: 's1' }], 'prefs.set': () => prefsWith(APP.version) });
    mount();
    await later();
    expect(await screen.findByRole('dialog', { name: /What’s new in Atelier/ })).toBeTruthy();
  });

  it('says nothing from an older server whose preferences cannot remember it', async () => {
    const { whatsNew: _gone, ...older } = prefsWith(null);
    resetBackend({ 'prefs.get': () => older, 'sessions.list': () => [{ id: 's1' }] });
    mount();
    await later();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says nothing for a version without notes', async () => {
    vi.mocked(releaseNotesFor).mockImplementation(() => undefined);
    resetBackend({ 'prefs.get': () => prefsWith('0.0.1') });
    mount();
    await later();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
