/** How loud the person is right now, as bars that move right to left (ARCHITECTURE §27). */
import { cn } from '../../components/ui/index.ts';
import { useLevels, type Levels } from './use-dictation.ts';

const BARS = 28;

export function Waveform({ levels, className }: { levels: Levels; className?: string }) {
  const values = useLevels(levels).slice(-BARS);
  return (
    <span role="img" aria-label="Listening" className={cn('flex h-4 shrink-0 items-center gap-[2px] text-fg-secondary', className)}>
      {values.map((v, i) => (
        <span
          key={i}
          aria-hidden
          className="w-[2px] rounded-full bg-current transition-[height] duration-75 ease-out"
          // A dot for silence, up to the full height for a loud voice.
          style={{ height: `${Math.max(2, Math.round(Math.pow(Math.min(1, v), 0.6) * 16))}px` }}
        />
      ))}
    </span>
  );
}
