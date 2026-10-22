import { createContext, memo, useContext, useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, OctagonX, Pencil, RotateCcw } from 'lucide-react';
import type { MessageError as MessageErrorData, ToolCallPart, ToolResultPart, TranscriptView } from '@atelier/protocol';
import { Button, Icon, ThinkingDots, cn } from '../../components/ui/index.ts';
import { useOpenSettings } from '../../app/navigation.ts';
import { blobUrl } from '../../lib/platform.ts';
import type { ActivityStepView } from './turns.ts';
import { WithViewedImages, ZoomableImage } from './images.tsx';
import { MemoryStep, splitMemorySteps } from './memory-steps.tsx';

/** The newest thought, as a one-line live summary. */
export function lastLine(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed
    .slice(trimmed.lastIndexOf('\n') + 1)
    .replace(/^[\s#>*-]+|\*\*/g, '')
    .trim();
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      icon={ChevronRight}
      className={cn('text-fg-muted transition-transform duration-(--at-duration-snap) ease-snap', open && 'rotate-90')}
    />
  );
}

/** Collapsed summary line (14/21, secondary) with a chevron that turns down when open. */
export function Summary({ open, onToggle, children }: { open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex min-h-6 max-w-full items-center gap-1.5 self-start rounded-sm text-body leading-[21px] text-fg-secondary outline-none focus-ring hover:text-fg"
    >
      {children}
      <Chevron open={open} />
    </button>
  );
}

export function ThinkingText({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'ml-1.5 border-l-2 border-line pl-4 font-serif text-prose-sm whitespace-pre-wrap text-fg-muted',
        className,
      )}
    >
      {text}
    </div>
  );
}

/** How much of a transcript starts expanded (Settings › Code › Default transcript view, or a session's own pick). */
export const TranscriptDetail = createContext<TranscriptView>('normal');

export const TRANSCRIPT_VIEWS: { value: TranscriptView; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'verbose', label: 'Verbose' },
];

export const ThinkingBlock = memo(function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(useContext(TranscriptDetail) !== 'normal');
  if (!active && !text.trim()) return null;
  return (
    <div className="flex flex-col">
      <Summary open={open} onToggle={() => setOpen((o) => !o)}>
        {active && <ThinkingDots />}
        <span className="truncate">{active ? lastLine(text) || 'Thinking…' : 'Thought process'}</span>
      </Summary>
      {open && <ThinkingText text={text} className="mt-2" />}
    </div>
  );
});

/** Wall-clock time, ticking every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** "12s", "36m 32s", "2h 5m". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const elapsed = (now: number, since: number) => formatElapsed(now - since);

/** First string argument of a call, e.g. the path or query, shown after the tool name. */
export function inputPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.values(input).find((v): v is string => typeof v === 'string') ?? '';
}

const isActive = (step: ActivityStepView) => (step.kind === 'tool' ? step.running : step.active);

/**
 * "ToolActivity": a run of tool calls (and the thinking between them) as one summary line that opens
 * into a bordered list; each 36px row opens to its input and output. Memory and past-chat calls get lines of their own.
 */
export function ToolActivity({ steps, turnSince }: { steps: ActivityStepView[]; turnSince?: number }) {
  const segments = splitMemorySteps(steps);
  if (segments.every((s) => s.kind === 'other')) return <GenericActivity steps={steps} turnSince={turnSince} />;
  return (
    <div className="flex flex-col gap-2.5">
      {segments.map((s) => (s.kind === 'memory' ? <MemoryStep key={s.steps[0]!.key} steps={s.steps} /> : <GenericActivity key={s.steps[0]!.key} steps={s.steps} turnSince={turnSince} />))}
    </div>
  );
}

/** `turnSince`: when the person's message was sent. The line counts the whole turn from there, not the step it is in. */
function GenericActivity({ steps, turnSince }: { steps: ActivityStepView[]; turnSince?: number }) {
  const [open, setOpen] = useState(useContext(TranscriptDetail) === 'verbose');
  const current = steps.findLast(isActive);
  const since = turnSince ?? (current?.kind === 'tool' ? current.since : undefined);
  const now = useNow(!!current && since !== undefined);
  const tools = steps.filter((s) => s.kind === 'tool');
  const failed = tools.filter((s) => s.result?.isError).length;

  return (
    <div className="flex flex-col">
      <WithViewedImages steps={steps}>
        <Summary open={open} onToggle={() => setOpen((o) => !o)}>
          {current ? (
            <>
              <ThinkingDots />
              <span className="truncate">
                {current.kind === 'tool' ? current.call.name : lastLine(current.text) || 'Thinking…'}
              </span>
              {since !== undefined && <span className="text-fg-muted tabular-nums">{elapsed(now, since)}</span>}
            </>
          ) : (
            <span className="truncate">
              Used {[...new Set(tools.map((s) => s.call.name))].join(', ')}
              {failed > 0 && <span className="text-danger-text"> · {failed} failed</span>}
            </span>
          )}
        </Summary>
      </WithViewedImages>
      {open && (
        <ul className="mt-2 overflow-hidden rounded-2xl inset-ring inset-ring-line">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StepRow({ step, now }: { step: ActivityStepView; now: number }) {
  const [open, setOpen] = useState(useContext(TranscriptDetail) === 'verbose');
  const preview = step.kind === 'tool' ? inputPreview(step.call.input) : '';
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-body text-fg-muted outline-none focus-ring hover:bg-fill-ghost-hover"
      >
        <span className="min-w-0 flex-1 truncate">
          {step.kind === 'thinking' ? (
            lastLine(step.text) || 'Thought process'
          ) : (
            <>
              <span className="text-fg">{step.call.name}</span>
              {preview && ` ${preview}`}
            </>
          )}
        </span>
        {isActive(step) && <ThinkingDots />}
        {step.kind === 'tool' && step.running && <span className="tabular-nums">{elapsed(now, step.since)}</span>}
        {step.kind === 'tool' && step.result?.isError && <span className="text-danger-text">Failed</span>}
        <Chevron open={open} />
      </button>
      {open &&
        (step.kind === 'thinking' ? (
          <ThinkingText text={step.text} className="mx-3 mb-3" />
        ) : (
          <ToolDetail call={step.call} result={step.result} />
        ))}
    </li>
  );
}

export const detailClass =
  'max-h-80 overflow-auto rounded-lg bg-code-background p-3 font-mono text-code whitespace-pre-wrap break-words';

function ToolDetail({ call, result }: { call: ToolCallPart; result: ToolResultPart | undefined }) {
  const text = result?.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
  const images = (result?.content ?? []).flatMap((c) => (c.type === 'image' ? [{ src: blobUrl(c.blob), alt: 'Tool result' }] : []));
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <pre className={cn(detailClass, 'text-fg')}>{JSON.stringify(call.input, null, 2)}</pre>
      {text && <pre className={cn(detailClass, result?.isError ? 'text-danger-text' : 'text-fg')}>{text}</pre>}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((image, i) => (
            <ZoomableImage key={i} group={images} index={i} className="max-h-32 max-w-48 rounded-lg object-cover inset-ring inset-ring-line" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The model provider stopped the reply (docs/PROMPTS.md §9.1): said as the provider's doing, not Atelier's, with Edit
 * and Retry where the person can use them. Atelier never retries on its own.
 */
export function ProviderStopped({ onEdit, onRetry }: { onEdit?: () => void; onRetry?: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body">
      <Icon icon={OctagonX} className="text-fg-muted" />
      <span className="text-fg-secondary">The model provider stopped this response.{(onEdit || onRetry) && ' Edit your message or try again.'}</span>
      {onEdit && (
        <Button size="sm" leadingIcon={Pencil} onClick={onEdit}>
          Edit
        </Button>
      )}
      {onRetry && (
        <Button size="sm" leadingIcon={RotateCcw} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Failed reply: what went wrong, a link to the settings page that fixes it, and Retry. */
export function MessageError({ error, onRetry }: { error: MessageErrorData; onRetry?: () => void }) {
  const openSettings = useOpenSettings();
  const fixPage = error.fix?.replace(/^settings\//, '');
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body">
      <Icon icon={CircleAlert} className="text-danger-text" />
      <span className="text-danger-text">{error.message}</span>
      {fixPage && (
        <button
          type="button"
          onClick={() => openSettings(fixPage)}
          className="rounded-xs text-interactive-text underline-offset-2 outline-none hover:underline focus-ring"
        >
          Fix in Settings
        </button>
      )}
      {onRetry && (
        <Button size="sm" leadingIcon={RotateCcw} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
