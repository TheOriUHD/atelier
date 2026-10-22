import { memo, useContext, useRef } from 'react';
import { ThinkingDots, cn, progressRingTone } from '../../components/ui/index.ts';
import { QUEUE_HELP, useThrottledLive } from '../../lib/live-session.ts';
import { TranscriptDetail, useNow } from '../chat/parts.tsx';
import { PhaseText, usePhaseText } from '../chat/run-phase.tsx';
import { formatElapsed, formatTokenCount, liveStatus } from './live-context.ts';

/** How often the token count may change on screen while a reply streams. */
const SAMPLE_MS = 150;
/** Output can pause briefly; after this long without any, the count moves on at the model's speed. */
const QUIET_MS = 1500;

/**
 * The running line at the end of a Code transcript: what the run is doing, for how long, and
 * the output tokens so far, ticking up while the reply streams, and how full the context window is (what auto-compaction
 * goes by, unlike the output). Not announced as it changes (it would never stop).
 */
export const LiveStatus = memo(function LiveStatus({ sessionId, withActivity = false }: { sessionId: string; withActivity?: boolean }) {
  const status = useThrottledLive(sessionId, liveStatus, SAMPLE_MS);
  const compact = useContext(TranscriptDetail) !== 'verbose';
  const now = useNow(status !== null);
  // Before the first output of a local model: what its server is doing, in place of "Thinking".
  const phaseText = usePhaseText(status?.phase ?? null);
  // When the count last changed: a silent server (a tool call being written) is extrapolated from there.
  const changed = useRef({ tokens: -1, at: 0 });
  if (status && status.tokens !== changed.current.tokens) changed.current = { tokens: status.tokens, at: Date.now() };
  // A run of tool calls says what it does in its own live line in Code's compact transcript; Chat's summary has none between steps.
  if (!status || (compact && status.activity && !withActivity && status.phase !== 'retrying')) return null;
  const retrying = status.phase === 'retrying';
  const quiet = status.generating && status.rate ? now - changed.current.at - QUIET_MS : 0;
  const estimated = quiet > 0 ? Math.floor((quiet / 1000) * status.rate!) : 0;
  // The context ring's colours, so the line and the ring agree on when the window is getting full.
  const tone = status.contextUsed !== null && status.contextLimit ? progressRingTone(status.contextUsed / status.contextLimit) : 'muted';
  return (
    // The running line is the last row of the transcript; it sits in the column's gap like the rest.
    <div role="status" aria-live="off" title={status.queued !== null ? QUEUE_HELP : undefined} className="flex items-center gap-2 text-body text-fg-secondary">
      <ThinkingDots />
      {retrying ? <span>Connection interrupted. Retry {status.retryAttempt ?? 1} of 10</span> : phaseText ? <PhaseText text={phaseText} /> : <span>{status.verb}…</span>}
      <span className="text-fg-muted tabular-nums">
        {formatElapsed(now - status.since)}
        {!retrying && status.counts && (
          <>
            {' · '}
            <span aria-hidden="true">↓</span> {estimated ? '≈ ' : ''}
            {formatTokenCount(status.tokens + estimated)} tokens
          </>
        )}
        {!retrying && status.contextUsed !== null && !!status.contextLimit && (
          <>
            {' · '}
            <span className={cn(tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger')}>
              context {formatTokenCount(status.contextUsed)} / {formatTokenCount(status.contextLimit)}
            </span>
          </>
        )}
      </span>
    </div>
  );
});
