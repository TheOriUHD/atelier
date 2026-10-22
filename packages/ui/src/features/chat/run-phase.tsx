/**
 * What a local model's server is doing before the reply's first token (RunPhase), in plain words. The line says the
 * same thing for as long as nothing has changed, and only moves on when it has something new to tell: that this is
 * taking a while, after 20 seconds, and that it is taking longer than usual, after a minute or more.
 */
import { useEffect, useState } from 'react';
import type { RunPhase } from '@atelier/protocol';
import { cn } from '../../components/ui/index.ts';
import { reducedMotionClass } from '../../components/ui/styles.ts';
import './run-phase.css';

export interface PhaseStep {
  /** Seconds into the phase from which this text is shown. */
  after: number;
  /** UI copy, shown without the trailing ellipsis. */
  text: string;
}

export const PHASE_TEXTS: Record<RunPhase, readonly PhaseStep[]> = {
  retrying: [{ after: 0, text: 'Waiting to reconnect' }],
  // A model whose own service thinks before it answers (ChatGPT's higher effort settings, which can take minutes).
  thinking: [
    { after: 0, text: 'Thinking' },
    { after: 120, text: 'Still thinking, a high effort setting can take a few minutes' },
    { after: 600, text: 'Still thinking, this is taking much longer than usual' },
  ],
  // A model writing a long tool call is silent too, so the first line doesn't claim a fault.
  quiet: [
    { after: 0, text: 'No output for a minute, it may be writing a long call' },
    { after: 120, text: 'Still no output, the model may have stalled. Stop ends the turn' },
    { after: 600, text: 'No output for ten minutes, the model has probably stalled' },
  ],
  loading: [
    { after: 0, text: 'Loading the model' },
    { after: 20, text: 'Still loading the model, a large one takes a while' },
    { after: 60, text: 'Still loading, this is taking longer than usual' },
  ],
  reading: [
    { after: 0, text: 'Reading the conversation' },
    { after: 20, text: 'Still reading, a long conversation takes a while' },
    { after: 60, text: 'Still reading, this is taking longer than usual' },
  ],
  waking: [
    { after: 0, text: 'Waking your codespace' },
    { after: 30, text: 'Still waking it, a codespace can take a minute' },
    { after: 90, text: 'Still waking it, this is taking longer than usual' },
  ],
};

/** The phase's current text, starting over when the phase changes; null without one. */
export function usePhaseText(phase: RunPhase | null): string | null {
  const [shown, setShown] = useState<{ phase: RunPhase | null; step: number }>({ phase, step: 0 });
  useEffect(() => {
    if (!phase) return;
    // One timer per change of text, not a ticking interval: nothing moves between them.
    const timers = PHASE_TEXTS[phase].slice(1).map((step, i) => setTimeout(() => setShown({ phase, step: i + 1 }), step.after * 1000));
    return () => {
      for (const timer of timers) clearTimeout(timer);
      setShown({ phase: null, step: 0 });
    };
  }, [phase]);
  if (!phase) return null;
  const steps = PHASE_TEXTS[phase];
  return steps[Math.min(shown.phase === phase ? shown.step : 0, steps.length - 1)]!.text;
}

/** The text, fading in as it changes (a plain swap under reduced motion). */
export function PhaseText({ text, className }: { text: string; className?: string }) {
  return (
    <span key={text} className={cn('inline-block animate-[at-phase-in_240ms_ease-out]', reducedMotionClass, className)}>
      {text}…
    </span>
  );
}
