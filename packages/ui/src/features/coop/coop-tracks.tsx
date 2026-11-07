/**
 * Parallel tracks in a co-op Code session (design/components.md › Co-op › Tracks): someone gives a task to an agent
 * that works for them in the background, in its own git worktree of the session's folder, while the conversation goes
 * on. Its end is noted in the conversation; the host merges its branch into the folder or closes it.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMerge, Plus } from 'lucide-react';
import type { CoopTrack } from '@atelier/protocol';
import { Button, Dialog, DialogContent, Spinner, TextArea, cn } from '../../components/ui/index.ts';
import { describeError, errorCode, rpc } from '../../lib/rpc.ts';
import { DiffText } from '../code/diff-review.tsx';
import { Avatar } from './avatar.tsx';
import { coopKey, reportError, type CoopView } from './coop.ts';

export const tracksKey = (sessionId: string) => [...coopKey(sessionId), 'tracks'] as const;

const STATUS: Record<CoopTrack['status'], string> = { working: 'Working…', done: 'Ready to merge', merged: 'Merged', closed: 'Closed' };

/** The session's tracks, read again with the co-op state (each `presence` event) and when the session's status changes. */
export function useTracks(sessionId: string, enabled: boolean) {
  return useQuery({ queryKey: tracksKey(sessionId), queryFn: () => rpc().call('coop.tracks', { sessionId }), enabled, retry: false });
}

/** The popover's Tracks section: each track with its author, title and status; Start a track… for those who can chat. */
export function Tracks({ sessionId, coop }: { sessionId: string; coop: CoopView }) {
  const qc = useQueryClient();
  const tracks = useTracks(sessionId, true);
  const [starting, setStarting] = useState(false);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [viewing, setViewing] = useState<CoopTrack | null>(null);
  const canStart = coop.role !== 'viewer' && !coop.ended;
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const track = await rpc().call('coop.track', { sessionId, task: task.trim() });
      qc.setQueryData<CoopTrack[]>(tracksKey(sessionId), (list = []) => [...list.filter((t) => t.id !== track.id), track]);
      setStarting(false);
      setTask('');
    } catch (e) {
      // Outside Code, or a folder that isn't on the host's own computer: said here, not as a toast.
      if (errorCode(e) === 'unsupported' || errorCode(e) === 'invalid_request') setProblem(describeError(e).message);
      else reportError(sessionId, e);
    } finally {
      setBusy(false);
    }
  };
  const list = tracks.data ?? [];
  return (
    <section aria-label="Tracks" className="flex flex-col gap-1.5 border-t border-line pt-3">
      <h3 className="text-footnote text-fg-muted">Tracks</h3>
      {list.length === 0 && !starting && <p className="text-footnote text-fg-muted">A track gives a task to an agent that works on its own copy of the folder while you go on here.</p>}
      {list.length > 0 && (
        <ul className="flex flex-col">
          {list.map((t) => (
            <TrackRow key={t.id} sessionId={sessionId} track={t} coop={coop} onView={() => setViewing(t)} />
          ))}
        </ul>
      )}
      {starting ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (task.trim()) void start();
          }}
        >
          <TextArea aria-label="The track’s task" autoFocus rows={3} value={task} placeholder="What should its agent do?" onChange={(e) => setTask(e.target.value)} />
          {problem && (
            <p role="alert" className="text-footnote text-danger-text">
              {problem}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setStarting(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!task.trim()} loading={busy}>
              Start track
            </Button>
          </div>
        </form>
      ) : (
        canStart && (
          <Button size="sm" variant="ghost" leadingIcon={Plus} className="self-start" onClick={() => setStarting(true)}>
            Start a track…
          </Button>
        )
      )}
      <TrackDiffDialog sessionId={sessionId} track={viewing} onClose={() => setViewing(null)} />
    </section>
  );
}

/** A track: its author's avatar, title and status; View changes, and the host's Merge and Close. A refused merge says why. */
function TrackRow({ sessionId, track, coop, onView }: { sessionId: string; track: CoopTrack; coop: CoopView; onView(): void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'merge' | 'close' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const author = coop.person(track.participantId);
  const open = track.status === 'working' || track.status === 'done';
  const act = async (what: 'merge' | 'close') => {
    setBusy(what);
    setProblem(null);
    try {
      if (what === 'merge') {
        const merged = await rpc().call('coop.mergeTrack', { sessionId, trackId: track.id });
        qc.setQueryData<CoopTrack[]>(tracksKey(sessionId), (list = []) => list.map((t) => (t.id === merged.id ? merged : t)));
      } else {
        await rpc().call('coop.closeTrack', { sessionId, trackId: track.id });
        qc.setQueryData<CoopTrack[]>(tracksKey(sessionId), (list = []) => list.map((t) => (t.id === track.id ? { ...t, status: 'closed' } : t)));
      }
      void qc.invalidateQueries({ queryKey: tracksKey(sessionId) });
    } catch (e) {
      // A merge that doesn't go cleanly changes nothing: git's words, under the track.
      if (errorCode(e) === 'track_failed' || errorCode(e) === 'invalid_request') setProblem(describeError(e).message);
      else reportError(sessionId, e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li aria-label={track.title} className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2.5">
        <Avatar name={author.name} avatar={author.avatar} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('truncate text-body', open ? 'text-fg' : 'text-fg-secondary')}>{track.title}</span>
          <span className="truncate text-footnote text-fg-muted">
            {author.me ? 'You' : author.name} · {STATUS[track.status]}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1 pl-[30px]">
        {track.status !== 'closed' && (
          <Button size="xs" variant="ghost" onClick={onView}>
            View changes
          </Button>
        )}
        {coop.isHost && open && (
          <>
            <Button size="xs" variant="ghost" leadingIcon={GitMerge} disabled={track.status !== 'done' || busy !== null} loading={busy === 'merge'} onClick={() => void act('merge')}>
              Merge
            </Button>
            <Button size="xs" variant="ghost" className="text-danger-text" disabled={busy !== null} loading={busy === 'close'} onClick={() => void act('close')}>
              Close
            </Button>
          </>
        )}
      </div>
      {problem && (
        <p role="alert" className="pl-[30px] text-footnote whitespace-pre-wrap text-danger-text">
          {problem}
        </p>
      )}
    </li>
  );
}

/** A track's changes against where it started, in the Diff pane's file cards, read-only. */
function TrackDiffDialog({ sessionId, track, onClose }: { sessionId: string; track: CoopTrack | null; onClose(): void }) {
  const diff = useQuery({
    queryKey: [...tracksKey(sessionId), 'diff', track?.id ?? ''],
    queryFn: () => rpc().call('coop.trackDiff', { sessionId, trackId: track!.id }),
    enabled: !!track,
    retry: false,
  });
  return (
    <Dialog open={!!track} onOpenChange={(open) => !open && onClose()}>
      {track && (
        <DialogContent title={`Changes in “${track.title}”`} description={`On the branch ${track.branch}${diff.data?.base ? `, from ${diff.data.base}` : ''}.`} width={880}>
          <div className="max-h-[min(640px,calc(100dvh-220px))] overflow-y-auto">
            {diff.error ? (
              <p role="alert" className="text-body text-danger-text">
                {describeError(diff.error).message}
              </p>
            ) : !diff.data ? (
              <Spinner label="Loading changes" className="text-fg-muted" />
            ) : (
              <DiffText diff={diff.data.diff} truncated={diff.data.truncated} />
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
