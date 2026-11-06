/**
 * Sounds a model made, where they belong in the conversation (design/components.md › GeneratedAudio): a card that holds
 * its place from the first moment, with a calm made-up waveform and one line that says what is being waited for, then
 * the sound's own waveform in the same place, to play and to seek. The page's own `<audio>` plays it; the card is its
 * controls, by pointer, touch and keyboard. A sound never plays by itself, and only one plays at a time.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { AudioLines, Download, Ellipsis, Info, Music, Pause, Play, Speech, VolumeX, type LucideIcon } from 'lucide-react';
import type { AudioKind } from '@atelier/protocol';
import { Dialog, DialogContent, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, cn, toast } from '../../components/ui/index.ts';
import { reducedMotionClass } from '../../components/ui/styles.ts';
import { blobUrl, saveBlob } from '../../lib/platform.ts';
import { describeError } from '../../lib/rpc.ts';
import { formatUsd } from '../settings/usage-data.ts';
import { ALT_CHARS, Detail, ImageNotice, PromptDetail, PromptLine, type ImageStep } from './generated-images.tsx';
import { formatDuration, resultText } from './image-view.ts';
import { KIND_LABELS, shownSounds, soundFailure, soundFileName, soundFraction, soundKind, soundLabel, soundSeconds, soundStatus, soundSubject, type ShownSound } from './audio-view.ts';
import { formatClock } from './video-view.ts';
import { loadPeaks, placeholderPeaks, resample } from './waveform.ts';
import './generated-images.css';

/** The widest a card gets: a waveform wider than this is hard to follow. */
const MAX_CARD_PX = 640;
/** One bar and its gap, in pixels: thin enough to show speech's syllables, wide enough to read. */
const BAR_PX = 4;
const SPEEDS = [1, 1.25, 1.5, 2, 0.75] as const;
const KIND_ICONS: Record<AudioKind, LucideIcon> = { speech: Speech, music: Music, sound: AudioLines };

/** The one sound playing on the page: starting another pauses it. */
let playing: HTMLAudioElement | null = null;

/** Bars across the card's width, as many as fit. */
function useBarCount(): [(element: HTMLDivElement | null) => void, number] {
  const [bars, setBars] = useState(64);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!element || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setBars(Math.max(24, Math.min(240, Math.floor(width / BAR_PX))));
    });
    observer.current.observe(element);
  }, []);
  return [ref, bars];
}

/** The bars, in one colour; the played part is a second copy over it, cut to the playhead, so seeking moves nothing else. */
function Bars({ heights, className }: { heights: readonly number[]; className: string }) {
  return (
    <div aria-hidden="true" className="absolute inset-0 flex items-center gap-[1.5px]">
      {heights.map((h, i) => (
        <span key={i} className={cn('min-w-0 flex-1 rounded-full transition-[height] duration-(--at-duration-slow) ease-out', reducedMotionClass, className)} style={{ height: `${Math.max(8, h * 100)}%` }} />
      ))}
    </div>
  );
}

interface PlayerProps {
  sound: ShownSound;
  /** Larger, for the library's viewer. */
  size?: 'md' | 'lg';
  onDetails?: (() => void) | undefined;
}

/**
 * A finished sound: play, the waveform to seek on, the time, and what can be done with it. The waveform is a slider:
 * arrows move five seconds, Page keys a tenth, Home and End the ends, and Space plays or pauses.
 */
export function SoundPlayer({ sound, size = 'md', onDetails }: PlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const [barsRef, bars] = useBarCount();
  const [peaks, setPeaks] = useState<number[] | null | undefined>(undefined);
  const [state, setState] = useState<'paused' | 'playing'>('paused');
  const [duration, setDuration] = useState(sound.seconds ?? 0);
  const [second, setSecond] = useState(0);
  const [speed, setSpeed] = useState<number>(1);
  const [broken, setBroken] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const kind = sound.audioKind ?? 'speech';
  const src = blobUrl(sound.blob);

  useEffect(() => {
    let live = true;
    void loadPeaks(src).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [src]);

  // The playhead follows every frame while it plays, written straight to the style: a re-render per frame would cost the whole card.
  useEffect(() => {
    if (state !== 'playing') return;
    let frame = 0;
    const tick = () => {
      const el = audio.current;
      if (el && el.duration > 0) {
        wave.current?.style.setProperty('--at-played', String(el.currentTime / el.duration));
        setSecond(Math.floor(el.currentTime));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  useEffect(() => {
    const el = audio.current;
    return () => {
      if (el && playing === el) {
        el.pause();
        playing = null;
      }
    };
  }, []);

  const seekTo = (fraction: number) => {
    const el = audio.current;
    const total = el && el.duration > 0 ? el.duration : duration;
    if (!el || !(total > 0)) return;
    const clamped = Math.min(1, Math.max(0, fraction));
    el.currentTime = clamped * total;
    wave.current?.style.setProperty('--at-played', String(clamped));
    setSecond(Math.floor(el.currentTime));
  };

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      if (playing && playing !== el) playing.pause();
      playing = el;
      void el.play().catch((e: unknown) => {
        if ((e as DOMException).name !== 'AbortError') setBroken(true);
      });
    } else el.pause();
  };

  const fractionAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? (event.clientX - box.left) / box.width : 0;
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const el = audio.current;
    const total = el && el.duration > 0 ? el.duration : duration;
    if (!el || !(total > 0)) return;
    const at = el.currentTime / total;
    const moves: Record<string, number> = { ArrowRight: 5 / total, ArrowUp: 5 / total, ArrowLeft: -5 / total, ArrowDown: -5 / total, PageUp: 0.1, PageDown: -0.1 };
    if (event.key in moves) seekTo(at + moves[event.key]!);
    else if (event.key === 'Home') seekTo(0);
    else if (event.key === 'End') seekTo(1);
    else if (event.key === ' ' || event.key === 'Enter') toggle();
    else return;
    event.preventDefault();
  };

  const download = () => void saveBlob(sound.blob, soundFileName(sound)).catch((e: unknown) => toast.error(describeError(e).message));
  const shown = resample(peaks ?? placeholderPeaks(sound.blob, bars).map(() => 0.16), bars);
  const total = duration > 0 ? duration : undefined;
  const large = size === 'lg';
  const label = soundLabel(kind, sound.voice);
  const KindIcon = KIND_ICONS[kind];

  if (broken)
    return (
      <div className="flex h-16 items-center gap-2.5 rounded-2xl bg-fill-ghost-hover px-4 text-body text-fg-muted inset-ring inset-ring-line">
        <VolumeX className="size-4 shrink-0" aria-hidden="true" />
        <span>This sound is no longer available.</span>
      </div>
    );

  return (
    <div role="group" aria-label={`${label}: ${sound.prompt.slice(0, ALT_CHARS)}`} className={cn('group/audio @container/cell relative flex items-center rounded-2xl bg-fill-ghost-hover inset-ring inset-ring-line', large ? 'gap-4 px-4 py-4' : 'gap-3 py-2.5 pr-2.5 pl-3')}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a speech's words are the line under the card and in its details; music and effects have none. */}
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        crossOrigin="anonymous"
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
          e.currentTarget.playbackRate = speed;
        }}
        onPlay={() => setState('playing')}
        onPause={() => setState('paused')}
        onEnded={(e) => {
          setState('paused');
          e.currentTarget.currentTime = 0;
          wave.current?.style.setProperty('--at-played', '0');
          setSecond(0);
        }}
        onError={() => {
          setState('paused');
          setBroken(true);
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={state === 'playing' ? 'Pause' : 'Play'}
        className={cn('flex shrink-0 items-center justify-center rounded-full bg-fill-primary text-on-primary outline-none hover:bg-fill-primary-hover focus-ring transition-[scale] duration-(--at-duration-snap) ease-snap active:scale-95', large ? 'size-12' : 'size-9')}
      >
        {state === 'playing' ? <Pause className={large ? 'size-5' : 'size-4'} fill="currentColor" aria-hidden="true" /> : <Play className={cn(large ? 'size-5' : 'size-4', 'translate-x-px')} fill="currentColor" aria-hidden="true" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-5 items-center gap-2 text-footnote">
          <KindIcon className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-fg-secondary">{label}</span>
          {/* Pointing at the waveform shows the time there, in the readout, where it covers nothing. */}
          <span className={cn('shrink-0 tabular-nums', hover !== null && total !== undefined ? 'text-fg' : 'text-fg-muted')}>
            {total !== undefined ? `${formatClock(hover !== null ? hover * total : second)} / ${formatClock(total)}` : formatClock(second)}
          </span>
        </div>
        <div
          ref={(element) => {
            wave.current = element;
            barsRef(element);
          }}
          role="slider"
          tabIndex={0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(total ?? 0)}
          aria-valuenow={second}
          aria-valuetext={total !== undefined ? `${formatClock(second)} of ${formatClock(total)}` : formatClock(second)}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekTo(fractionAt(e));
          }}
          onPointerMove={(e) => {
            const at = Math.min(1, Math.max(0, fractionAt(e)));
            if (dragging.current) seekTo(at);
            if (e.pointerType === 'mouse') setHover(at);
          }}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
          onPointerLeave={() => setHover(null)}
          style={{ '--at-played': '0' } as CSSProperties}
          className={cn('relative w-full cursor-pointer touch-none rounded-sm outline-none select-none focus-ring', large ? 'h-14' : 'h-8')}
        >
          <Bars heights={shown} className="bg-line-stronger" />
          <div className="absolute inset-0" style={{ clipPath: 'inset(0 calc((1 - var(--at-played)) * 100%) 0 0)' }}>
            <Bars heights={shown} className="bg-interactive" />
          </div>
          {hover !== null && total !== undefined && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-px bg-fg-muted" style={{ left: `${hover * 100}%` }} />}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 self-start">
        {kind === 'speech' && (
          <button
            type="button"
            aria-label={`Playback speed, ${speed}×`}
            onClick={() => {
              const next = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!;
              setSpeed(next);
              if (audio.current) audio.current.playbackRate = next;
            }}
            className="flex h-7 min-w-9 items-center justify-center rounded-md px-1 text-footnote text-fg-muted tabular-nums outline-none hover:bg-fill-ghost-hover hover:text-fg focus-ring"
          >
            {speed}×
          </button>
        )}
        <div className="flex @max-[319px]/cell:hidden">
          <IconButton icon={Download} label="Download" size="sm" onClick={download} />
          {onDetails && <IconButton icon={Info} label="Details" size="sm" onClick={onDetails} />}
        </div>
        <div className="hidden @max-[319px]/cell:flex">
          <Menu>
            <MenuTrigger render={<IconButton icon={Ellipsis} label="Sound actions" size="sm" />} />
            <MenuContent align="end">
              <MenuItem icon={Download} onClick={download}>
                Download
              </MenuItem>
              {onDetails && (
                <MenuItem icon={Info} onClick={onDetails}>
                  Details
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>
    </div>
  );
}

/** Everything known about a sound, in its details dialog. */
export function SoundDetails({ sound }: { sound: ShownSound }) {
  const kind = sound.audioKind ?? 'speech';
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col divide-y divide-line-subtle">
        <Detail label="Kind">{KIND_LABELS[kind]}</Detail>
        {sound.modelName && <Detail label="Model">{sound.modelName}</Detail>}
        {sound.voice && <Detail label={sound.voice.includes(':') ? 'Voices' : 'Voice'}>{sound.voice}</Detail>}
        {sound.seconds !== undefined && <Detail label="Length">{formatClock(sound.seconds)}</Detail>}
        {sound.seed !== undefined && <Detail label="Seed">{sound.seed}</Detail>}
        {sound.durationMs !== undefined && <Detail label="Time">{formatDuration(sound.durationMs)}</Detail>}
        {sound.costUsd !== undefined && (
          <Detail label="Cost">
            {formatUsd(sound.costUsd)}
            {sound.costEstimated && <span className="text-fg-muted"> estimated</span>}
          </Detail>
        )}
      </dl>
      {sound.prompt && <PromptDetail label={kind === 'speech' ? 'Text' : 'Prompt'} text={sound.prompt} />}
      {sound.direction && <PromptDetail label="Direction" text={sound.direction} />}
      {sound.lyrics && <PromptDetail label="Lyrics" text={sound.lyrics} />}
      {sound.negativePrompt && <PromptDetail label="Negative prompt" text={sound.negativePrompt} />}
    </div>
  );
}

/** The card while the sound is made: the made-up waveform under a sheen, and a hairline that fills as it goes. */
function Pending({ seed, kind, fraction, quiet }: { seed: string; kind: AudioKind; fraction: number | undefined; quiet: boolean }) {
  const [barsRef, bars] = useBarCount();
  const KindIcon = KIND_ICONS[kind];
  return (
    <div className="relative flex items-center gap-3 overflow-hidden rounded-2xl bg-fill-ghost-hover py-2.5 pr-2.5 pl-3 inset-ring inset-ring-line">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-skeleton text-fg-muted">
        <KindIcon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-5 items-center text-footnote text-fg-muted">{KIND_LABELS[kind]}</div>
        <div ref={barsRef} className="relative h-8 w-full">
          <Bars heights={placeholderPeaks(seed, bars)} className="bg-skeleton" />
        </div>
      </div>
      <span aria-hidden="true" className={cn('at-image-sheen', quiet && 'opacity-0')} />
      {fraction !== undefined && (
        <div role="progressbar" aria-label="Making the sound" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="absolute inset-x-0 bottom-0 h-0.5 bg-progress-track">
          <div className="h-full w-full origin-left bg-interactive transition-transform duration-500 ease-linear" style={{ transform: `scaleX(${fraction})` }} />
        </div>
      )}
    </div>
  );
}

/**
 * A GenerateAudio call in the transcript, for its whole life: waiting, making, done, stopped or refused. It stays one
 * element throughout, so the card a sound was made in is the card it arrives in.
 */
export function GeneratedAudio({ step, waiting }: { step: ImageStep; waiting: boolean }) {
  const { call, result, progress } = step;
  const sound = shownSounds(result, progress)[0];
  const running = step.running && !sound;
  const failure = sound || running ? null : soundFailure(result ? resultText(result) : 'Stopped.');
  const [arrived] = useState(step.running);
  const [details, setDetails] = useState(false);
  const kind = sound?.audioKind ?? progress?.audioKind ?? soundKind(call);
  const subject = sound?.prompt ?? soundSubject(call);
  const fraction = soundFraction(progress);

  if (failure)
    return (
      <figure className="flex flex-col">
        <ImageNotice failure={failure} />
        <figcaption>
          <PromptLine prompt={subject} revised={undefined} />
        </figcaption>
      </figure>
    );

  return (
    <figure className="flex flex-col" style={{ width: `min(100%, ${MAX_CARD_PX}px)` }}>
      <div className={cn(arrived && sound && 'animate-[at-image-preview-in_240ms_ease-out]', reducedMotionClass)}>
        {sound ? <SoundPlayer sound={sound} onDetails={() => setDetails(true)} /> : <Pending seed={call.id} kind={kind} fraction={running ? fraction : undefined} quiet={waiting && !progress} />}
      </div>
      {/* One line under the card in every state, so the status can hand over to the words with nothing moving. */}
      <figcaption className="mt-1.5 flex min-h-6 flex-col">
        {running ? (
          <div role="status" aria-live="off" className="flex h-6 items-center text-footnote text-fg-muted tabular-nums">
            <span key={progress?.phase ?? 'start'} className={cn('animate-[at-image-preview-in_240ms_ease-out] truncate', reducedMotionClass)}>
              {soundStatus(progress, { kind, seconds: soundSeconds(call), waiting })}
            </span>
          </div>
        ) : (
          <div className={cn(arrived && 'animate-[at-image-preview-in_240ms_ease-out]', reducedMotionClass)}>
            <PromptLine prompt={subject} revised={undefined} />
          </div>
        )}
      </figcaption>
      <span role="status" className="sr-only">
        {sound ? 'Sound ready' : ''}
      </span>
      {sound && (
        <Dialog open={details} onOpenChange={setDetails}>
          <DialogContent title={soundLabel(kind, undefined)} width={440}>
            <SoundDetails sound={sound} />
          </DialogContent>
        </Dialog>
      )}
    </figure>
  );
}
