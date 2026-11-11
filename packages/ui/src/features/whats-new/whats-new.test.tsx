import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sparkles } from 'lucide-react';
import { APP, defaultUserPrefs } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { MAX_VERSIONS, releaseNotesSince, RELEASE_NOTES, type ReleaseNotes } from './release-notes.ts';
import { WhatsNewDialog, WhatsNewHost } from './whats-new.tsx';

vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});
// A development build has no notes of its own; the host is tested as if this version had them.
vi.mock('./release-notes.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./release-notes.ts')>();
  return { ...real, releaseNotesSince: vi.fn(real.releaseNotesSince) };
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
const prefsWith = (seen: string | null, from: string | null = null) => ({ ...defaultUserPrefs(), whatsNew: { seen, from } });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(releaseNotesSince).mockImplementation(() => [notes]);
});
afterEach(() => vi.useRealTimers());

const later = () => act(async () => void vi.advanceTimersByTime(1000));

/** Real notes, as `releaseNotesSince` would have them: what's actually in the list. */
const real = await vi.importActual<typeof import('./release-notes.ts')>('./release-notes.ts');

describe('what is new since a version', () => {
  it('is every version after the one the person had, through the one they run, newest first', () => {
    expect(real.releaseNotesSince('0.5.3', '0.6.0').map((n) => n.version)).toEqual(['0.6.0', '0.5.5', '0.5.4']);
    // Nothing seen yet, or the same version again: that version's own.
    expect(real.releaseNotesSince(null, '0.6.0').map((n) => n.version)).toEqual(['0.6.0']);
    expect(real.releaseNotesSince('0.6.0', '0.6.0').map((n) => n.version)).toEqual(['0.6.0']);
    // A version without notes (a development build) shows nothing, however much came before it.
    expect(real.releaseNotesSince('0.5.3', '9.9.9-dev')).toEqual([]);
  });
});

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
    // Notes with smaller changes too (the newest may have none, and then the dialog leaves that part out).
    const full = RELEASE_NOTES.find((n) => n.also.length > 0)!;
    mount(<WhatsNewDialog notes={[full]} open onOpenChange={onOpenChange} />);
    const dialog = screen.getByRole('dialog', { name: new RegExp(`What’s new in Atelier\\s*${full.version}`) });
    for (const h of full.highlights) expect(dialog.textContent).toContain(h.title);
    expect(dialog.textContent).toContain('Also in this version');
    for (const line of full.also) expect(dialog.textContent).toContain(line);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('the dialog over several versions', () => {
  const clip = (version: string, title: string): ReleaseNotes => ({
    version,
    intro: `Intro of ${version}.`,
    highlights: [
      { icon: Sparkles, title, body: 'A larger feature, shown off with its clip across the whole width of the dialog.', media: { src: '/clips/feature.mp4', alt: `${title} in action`, poster: '/clips/feature.jpg' } },
      { icon: Sparkles, title: `Small thing in ${version}`, body: 'A smaller highlight, a line with an icon beside it as before, below the larger feature.' },
    ],
    also: [`A line in ${version}.`],
  });

  it('shows the newest version first, then each one in between with its own notes, and features with their clips', () => {
    mount(<WhatsNewDialog notes={[clip('0.7.0', 'Big new thing'), clip('0.6.5', 'Older big thing')]} open onOpenChange={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: /What’s new in Atelier\s*0\.7\.0/ });
    expect(dialog.textContent).toContain('Intro of 0.7.0.');
    const latest = screen.getByRole('region', { name: 'Atelier 0.7.0' });
    const older = screen.getByRole('region', { name: 'Atelier 0.6.5' });
    // Newest first, in the order of the page.
    expect(latest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.textContent).toContain('Also new since your last update');
    expect(older.textContent).toContain('Intro of 0.6.5.');
    expect(older.textContent).toContain('Also in 0.6.5');
    // The clip: silent and looping, before its title.
    const video = screen.getByLabelText('Big new thing in action');
    expect(video.tagName).toBe('VIDEO');
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect(video.hasAttribute('loop')).toBe(true);
    expect(video.compareDocumentPosition(screen.getByRole('heading', { name: 'Big new thing' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows at most a few versions and sends the rest to the changelog', () => {
    const many = Array.from({ length: MAX_VERSIONS + 3 }, (_, i) => clip(`0.${40 - i}.0`, `Thing ${i}`));
    mount(<WhatsNewDialog notes={many} open onOpenChange={() => {}} />);
    expect(screen.getAllByRole('region', { name: /^Atelier / })).toHaveLength(MAX_VERSIONS);
    expect(screen.getByRole('dialog').textContent).toContain('And 3 earlier versions: the full changelog has them.');
  });
});

describe('the host', () => {
  it('shows the notes once after an update, and remembers it was seen and where the person came from', async () => {
    resetBackend({ 'prefs.get': () => prefsWith('0.0.1'), 'prefs.set': () => prefsWith(APP.version, '0.0.1') });
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    await later();
    expect(await screen.findByRole('dialog', { name: /What’s new in Atelier/ })).toBeTruthy();
    expect(releaseNotesSince).toHaveBeenCalledWith('0.0.1', APP.version);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['whatsNew'], value: { seen: APP.version, from: '0.0.1' } }]));
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
    await waitFor(() => expect(callsTo('prefs.set')).toEqual([{ path: ['whatsNew'], value: { seen: APP.version, from: null } }]));
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
    vi.mocked(releaseNotesSince).mockImplementation(() => []);
    resetBackend({ 'prefs.get': () => prefsWith('0.0.1') });
    mount();
    await later();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
