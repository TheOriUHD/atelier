/**
 * The effort control in the composer footer (design/components.md › EffortControl): a chip with the level's name next to
 * the model, opening a popover with the level, a (?) help, "Faster"/"Smarter" and the slider. In Code its last stop is
 * Ultracode, with a violet name and the charged field in the slider; a provider's last stop can be drawn the same way
 * (`effortStops[].featured`, ChatGPT Chat's Pro). Cmd/Ctrl+Shift+E opens it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CircleHelp, TriangleAlert } from 'lucide-react';
import { effortChoices, recommendedEffort, shownEffort, type Effort, type Mode, type ModelInfo } from '@atelier/protocol';
import { Icon, Popover, PopoverContent, PopoverTrigger, Switch, Tooltip, cn } from '../../components/ui/index.ts';
import { prefersReducedMotion } from '../../lib/motion.ts';
import { isMac } from '../../lib/platform.ts';
import { EffortSlider } from './effort-slider.tsx';
import { EFFORT_LABELS, effortHelp } from './models.ts';
import { UltracodeField, useFieldSlot } from './ultracode-field.tsx';
import { useIsActiveCell } from '../../lib/split-cell.tsx';
import './effort.css';

const SHORTCUT = isMac ? '⌘⇧E' : 'Ctrl+Shift+E';

/** Levels that cost much more: a warning mark next to their name, here in the chip, with this text in the popover. */
const WARNINGS: Partial<Record<Effort, string>> = {
  max: 'Max Usage, consumes 3.5X more Tokens',
  ultracode: 'Ultracode Usage, consumes far more Tokens and takes much longer',
};

export interface EffortControlProps {
  model: ModelInfo | undefined;
  mode: Mode;
  /** The stored level; null starts at the model's Recommended one. */
  effort: Effort | null;
  /** A promise (an existing session's update) shows the new level until it settles; the caller reports failures. */
  onChange(effort: Effort): unknown;
  /** In an existing session (a change applies from the next message; the popover doesn't say so). */
  inSession?: boolean;
  /** The admin allows Ultracode (system setting `ultracode.enabled`); without it a session that chose it shows Extra. */
  ultracode?: boolean;
  thinking?: boolean;
  onThinkingChange?(thinking: boolean): unknown;
}

export function EffortControl({ model, mode, effort, onChange, ultracode = true, thinking = true, onThinkingChange }: EffortControlProps) {
  const levels = effortChoices(model, mode, { ultracode });
  const enabled = levels.length > 1;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Effort | null>(null);
  /** Counts commits, so only the latest one's update clears `pending`. */
  const commits = useRef(0);
  const [preview, setPreview] = useState<Effort | null>(null);
  const slider = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  // Ultracode's field keeps its canvas and context between openings of the popover.
  const field = useFieldSlot();
  const current = shownEffort(pending ?? effort, model, mode, { ultracode });
  // A provider that fixes the stops (ChatGPT Chat's picker) names them, explains them and warns about them itself.
  const stop = (level: Effort) => model?.effortStops?.find((candidate) => candidate.effort === level);
  const labelOf = (level: Effort) => stop(level)?.label ?? EFFORT_LABELS[level];
  const warningOf = (level: Effort) => stop(level)?.warning ?? WARNINGS[level];
  const helpOf = (level: Effort) => stop(level)?.help ?? effortHelp(level, model, mode);
  // Drawn like Ultracode (the violet name, the charged field): Ultracode itself, or the last stop when its provider flags
  // it. Only a look, so it does not depend on the admin's Ultracode switch.
  const last = levels.at(-1);
  const stops = model?.effortStops;
  const featuredLevel = last && (last === 'ultracode' || (stops?.length === levels.length && stops.at(-1)?.featured)) ? last : null;

  const activeCell = useIsActiveCell();
  useEffect(() => {
    if (!enabled || !activeCell) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'e' || !e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey) || e.altKey) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, activeCell]);

  if (levels.length === 0 || !current) return null;
  // The popover's name is the level in force, or the one being dragged to; hovering never changes it.
  const shown = preview ?? current;
  const name = labelOf(current);
  const warning = warningOf(current);

  const commit = (next: Effort) => {
    const result = onChange(next);
    if (!(result instanceof Promise)) return;
    const id = ++commits.current;
    setPending(next);
    // An earlier step settling while a later one is on its way would bring back the stored level for a moment.
    const settled = () => {
      if (commits.current === id) setPending(null);
    };
    result.then(settled, settled);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setPreview(null);
      }}
    >
      <Tooltip content={`Effort  ${SHORTCUT}`} disabled={open}>
        <PopoverTrigger
          disabled={!enabled}
          aria-label={`Effort: ${name}${warning ? ', high usage' : ''}`}
          aria-keyshortcuts={isMac ? 'Meta+Shift+E' : 'Control+Shift+E'}
          className="flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-sm px-2 text-control-sm outline-none focus-ring hover:bg-fill-ghost-hover disabled:opacity-40 data-popup-open:bg-fill-ghost-hover"
        >
          <span className={cn('truncate', current === featuredLevel ? 'font-medium text-pro' : 'text-fg-muted')}>{name}</span>
          {warning && <Icon icon={TriangleAlert} className="size-3 text-warning" />}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        ref={popup}
        aria-label="Effort"
        side="top"
        align="end"
        sideOffset={8}
        // A pointer leaves focus on the popup; the keyboard (and the shortcut) lands on the slider.
        initialFocus={(type) => (type === 'mouse' || type === 'touch' || type === 'pen' ? popup.current : slider.current)}
        className="flex w-[220px] origin-(--transform-origin) flex-col gap-5 p-3 select-none transition-[opacity,scale] duration-(--at-duration-base) ease-out data-ending-style:scale-[0.97] data-starting-style:scale-[0.97] data-[side=top]:data-starting-style:translate-y-0"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-fg-muted">Effort</span>
            <LevelName name={labelOf(shown)} rank={levels.indexOf(shown)} pro={shown === featuredLevel}>
              {warningOf(shown) && (
                <Tooltip content={warningOf(shown)} side="top" align="start">
                  <button
                    type="button"
                    aria-label={warningOf(shown)}
                    className="flex size-4 shrink-0 items-center justify-center rounded-sm text-warning outline-none focus-ring"
                  >
                    <Icon icon={TriangleAlert} className="size-3.5" />
                  </button>
                </Tooltip>
              )}
            </LevelName>
          </div>
          <Tooltip
            delay={200}
            side="top"
            align="end"
            className="h-auto w-[220px] flex-col items-start gap-1.5 rounded-2xl bg-popover p-3 text-footnote whitespace-normal text-fg shadow-popover"
            content={
              <>
                <span className="font-medium">{labelOf(shown)}</span>
                <span className="text-pretty text-fg-muted">{helpOf(shown)}</span>
              </>
            }
          >
            <button
              type="button"
              aria-label="About effort"
              className="flex size-5 items-center justify-center rounded-full text-fg-muted outline-none focus-ring hover:text-fg pointer-coarse:hidden"
            >
              <Icon icon={CircleHelp} />
            </button>
          </Tooltip>
        </div>
        <div className="flex flex-col gap-1.5">
          <div dir="ltr" className="flex justify-between gap-2 text-footnote text-fg-muted">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <EffortSlider
            ref={slider}
            levels={levels}
            value={current}
            label={labelOf}
            recommended={recommendedEffort(model, mode)}
            onPreview={setPreview}
            onCommit={commit}
            overlay={featuredLevel ? (lit) => <UltracodeField lit={lit} slot={field} /> : undefined}
          />
          <p className="hidden text-footnote text-fg-muted pointer-coarse:block">{helpOf(shown)}</p>
        </div>
        {model?.capabilities.reasoning === 'toggle' && onThinkingChange && !['xhigh', 'max', 'ultracode'].includes(shown) && (
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-body text-fg">Thinking</span>
              <span className="text-footnote text-fg-muted">Recommended</span>
            </div>
            <Switch aria-label="Thinking" checked={thinking} onCheckedChange={(checked) => void onThinkingChange(checked)} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** How long the name takes to come in, and the curve (the `--at-ease-out` token); effort.css animates with the same. */
const NAME_MS = 200;
const EASE_OUT = 'cubic-bezier(0.165, 0.84, 0.44, 1)';
/** The element's layout width: unlike its rect it ignores the popover's scale while it pops in, and mid-glide it is the animated value. */
const widthOf = (el: HTMLElement) => parseFloat(getComputedStyle(el).width) || 0;

/**
 * The level's name: on a change it slides in from where the level moved and comes into focus (effort.css). What follows it
 * (the warning mark) is part of it: the old name leaves out of flow, so the row has the new name's width at once, and the
 * name's cell glides from the old width to the new one while the mark fades in with the name, instead of the mark standing
 * at the wider of the two widths and snapping back when the old name is gone.
 */
function LevelName({ name, rank, pro, children }: { name: string; rank: number; pro: boolean; children?: ReactNode }) {
  const [state, setState] = useState({ name, rank, pro, changed: false, up: true, leaving: null as { name: string; pro: boolean } | null });
  if (state.name !== name) {
    setState({ name, rank, pro, changed: true, up: rank > state.rank, leaving: { name: state.name, pro: state.pro } });
  }
  const cell = useRef<HTMLSpanElement>(null);
  const resting = useRef(0);
  const glide = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = cell.current;
    if (!el) return;
    // From where the cell is now (mid-glide when the level changes again) to the new name's width.
    const from = glide.current ? widthOf(el) : resting.current;
    glide.current?.cancel();
    glide.current = null;
    const to = widthOf(el);
    resting.current = to;
    if (!state.changed || Math.abs(from - to) < 0.5 || typeof el.animate !== 'function' || prefersReducedMotion()) return;
    const animation = el.animate({ width: [`${from}px`, `${to}px`] }, { duration: NAME_MS, easing: EASE_OUT });
    glide.current = animation;
    animation.onfinish = () => {
      if (glide.current === animation) glide.current = null;
    };
  }, [state.name, state.changed]);
  useLayoutEffect(() => () => glide.current?.cancel(), []);
  const tone = (violet: boolean) => (violet ? 'font-medium text-pro' : 'text-fg');
  const dir = state.up ? 'up' : 'down';
  return (
    <>
      <span ref={cell} className="effort-level-name">
        {state.leaving && (
          <span
            key={`leave-${state.leaving.name}`}
            aria-hidden
            data-leave=""
            data-dir={dir}
            className={tone(state.leaving.pro)}
            onAnimationEnd={() => setState((s) => ({ ...s, leaving: null }))}
          >
            {state.leaving.name}
          </span>
        )}
        {state.changed ? (
          <span key={`enter-${name}`} data-enter="" data-dir={dir} className={tone(pro)}>
            {[0, 1, 2, 3].map((layer) => (
              <span key={layer} data-layer={layer} aria-hidden={layer > 0 || undefined}>
                {name}
              </span>
            ))}
          </span>
        ) : (
          <span className={tone(pro)}>{name}</span>
        )}
      </span>
      {children && (
        // Mounted when the mark first appears (a level without one before it), so only then it comes in; it stays between
        // two levels that both have one, and keeps its focus.
        <span className={cn('inline-flex', state.changed && 'effort-warning-enter')}>
          {children}
        </span>
      )}
    </>
  );
}
