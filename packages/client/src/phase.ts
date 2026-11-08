/** Words for what a run is doing and how long it has taken, shared by the app and the terminal. */
import type { RunPhase } from '@atelier/protocol';

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

/** "8s", "3m 12s", "1h 4m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The first string in a tool call's input: what a one-line summary shows for a tool it doesn't know. */
export function inputPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.values(input).find((v): v is string => typeof v === 'string') ?? '';
}
