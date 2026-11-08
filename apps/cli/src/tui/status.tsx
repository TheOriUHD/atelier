/**
 * The line while a reply is on its way: the paint dab, a studio word (or what the run waits on: a local model loading,
 * a retry, a place in line), how long it has run, the tokens so far, and how to stop it.
 */
import { Box, Text, useAnimation } from 'ink';
import { formatElapsed, formatTokenCount, type LiveStatus } from '@atelier/client';
import { DAB_FRAMES, DAB_STEP_MS, studioWord } from '../art/words.ts';
import type { Paint } from '../style.ts';

export function StatusLine({ status, paint, now }: { status: LiveStatus; paint: Paint; now: number }) {
  const { frame } = useAnimation({ interval: DAB_STEP_MS, isActive: paint.p.depth > 0 });
  const dab = DAB_FRAMES[frame % DAB_FRAMES.length]!;
  // Plain words for waiting (they say what's going on); a studio word for thinking, writing and working.
  const waiting = status.phase || status.queued !== null || status.verb.startsWith('Compacting');
  const word = waiting ? status.verb : studioWord(status.since || now, now);
  const parts = [formatElapsed(now - (status.since || now))];
  if (status.counts && status.tokens > 0) parts.push(`↓ ${formatTokenCount(status.tokens)} tokens`);
  if (status.retryAttempt) parts.push(`attempt ${status.retryAttempt + 1}`);
  parts.push('esc to stop');
  const tool = !waiting && status.verb !== 'Thinking' && status.verb !== 'Writing' ? paint.fg('muted', ` ${status.verb.toLowerCase()}`) : '';
  return (
    <Box marginBottom={1}>
      <Text>{`${paint.fg('accent', dab)} ${paint.gradient(`${word}…`, [paint.p.accentSoft, paint.p.accent, paint.p.accentSoft], ((frame % 30) / 30) * 0.4 - 0.2)}${tool} ${paint.fg('muted', `(${parts.join(' · ')})`)}`}</Text>
    </Box>
  );
}

export { DAB_FRAMES };
