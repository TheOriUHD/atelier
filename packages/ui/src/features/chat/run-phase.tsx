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

export { PHASE_TEXTS, type PhaseStep } from '@atelier/client/phase.ts';
import { PHASE_TEXTS } from '@atelier/client/phase.ts';

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
