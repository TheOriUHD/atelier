/**
 * Videos a model made, where they belong in the conversation (design/components.md › GeneratedVideos): a frame with the
 * final shape from the first moment, a status line that says what is being waited for, then the player in the same
 * place. The frame is the browser's own `<video controls>`, so play, seek, volume and full screen work by pointer, touch
 * and keyboard; it starts muted, loops, and never plays on its own for a person who asked for less motion.
 */
import { useCallback, useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Download, Ellipsis, ImagePlus, Info, Maximize2, VideoOff, type LucideIcon } from 'lucide-react';
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger, VideoLightbox, cn, toast } from '../../components/ui/index.ts';
import { reducedMotionClass } from '../../components/ui/styles.ts';
import { blobUrl, saveBlob } from '../../lib/platform.ts';
import { describeError } from '../../lib/rpc.ts';
import { formatUsd } from '../settings/usage-data.ts';
import { ALT_CHARS, ComposerImages, Detail, ImageNotice, PromptDetail, PromptLine, type ImageStep } from './generated-images.tsx';
import { formatDuration, previewBlur, resultText, type ImageShape } from './image-view.ts';
import { firstFrame } from './video-frame.ts';
import { formatClock, plannedVideoShape, shownVideos, videoFailure, videoFileName, videoFraction, videoPrompt, videoStatus, type ShownVideo } from './video-view.ts';
import './generated-images.css';

/** The widest a single frame gets, so a clip in a very wide column isn't a wall. */
const MAX_FRAME_PX = 960;

/** The user asked their system, or Atelier, for less motion. */
const wantsLessMotion = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) || document.documentElement.dataset.motion === 'reduced';

interface VideoAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run(): void;
}

/** What can be done with a clip, wherever it is shown. */
function useVideoActions(video: ShownVideo, { onOpen, onDetails, onAttached }: { onOpen?: (() => void) | undefined; onDetails?: (() => void) | undefined; onAttached?: (() => void) | undefined }): VideoAction[] {
  const composer = useContext(ComposerImages);
  const fail = (e: unknown) => toast.error(describeError(e).message);
  return [
    ...(onOpen ? [{ id: 'open', label: 'Open larger', icon: Maximize2, run: onOpen }] : []),
    { id: 'download', label: 'Download', icon: Download, run: () => void saveBlob(video.blob, videoFileName(video)).catch(fail) },
    // The box can take a file of its own (the pages that have one say so); a link to the clip would mean nothing outside this app.
    ...(composer?.addFile
      ? [
          {
            id: 'reference',
            label: 'Use first frame as reference',
            icon: ImagePlus,
            run() {
              const add = composer.addFile!;
              void firstFrame(blobUrl(video.blob)).then(
                (file) => {
                  add(file);
                  if (onAttached) onAttached();
                  else composer.focus();
                },
                (e: unknown) => toast.error(describeError(e).message),
              );
            },
          },
        ]
      : []),
    ...(onDetails ? [{ id: 'details', label: 'Details', icon: Info, run: onDetails }] : []),
  ];
}

/** Over the clip, shown on hover and focus, and all the time where nothing can hover. Folded into a menu in a narrow frame. */
function VideoOverlayActions({ actions }: { actions: readonly VideoAction[] }) {
  const surface = 'absolute top-2 right-2 items-center rounded-lg bg-popover p-0.5 text-fg-secondary shadow-popover transition-opacity delay-100 duration-(--at-duration-snap) ease-snap';
  const reveal = 'opacity-0 group-focus-within/video:opacity-100 group-hover/video:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100';
  return (
    <>
      <div className={cn(surface, reveal, 'flex @max-[299px]/cell:hidden')}>
        {actions.map((action) => (
          <IconButton key={action.id} icon={action.icon} label={action.label} size="sm" onClick={action.run} />
        ))}
      </div>
      <div className={cn(surface, reveal, 'hidden @max-[299px]/cell:flex')}>
        <Menu>
          <MenuTrigger render={<IconButton icon={Ellipsis} label="Video actions" size="sm" />} />
          <MenuContent align="end">
            {actions.map((action) => (
              <MenuItem key={action.id} icon={action.icon} onClick={action.run}>
                {action.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>
    </>
  );
}

function LightboxActions({ video, onAttached }: { video: ShownVideo; onAttached(): void }) {
  const actions = useVideoActions(video, { onAttached });
  return actions.map((action) => <IconButton key={action.id} icon={action.icon} label={action.label} size="lg" onClick={action.run} />);
}

/** Everything known about a clip, in the viewer's details panel. */
export function VideoDetails({ video, loaded }: { video: ShownVideo; loaded: (ImageShape & { seconds: number }) | undefined }) {
  const size = video.width && video.height ? { width: video.width, height: video.height } : loaded;
  const seconds = video.seconds ?? loaded?.seconds;
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col divide-y divide-line-subtle">
        {video.modelName && <Detail label="Model">{video.modelName}</Detail>}
        {seconds !== undefined && <Detail label="Length">{formatClock(seconds)}</Detail>}
        {size && (
          <Detail label="Size">
            {size.width} × {size.height}
          </Detail>
        )}
        {video.fps !== undefined && <Detail label="Frame rate">{Math.round(video.fps * 100) / 100} fps</Detail>}
        {video.audio !== undefined && <Detail label="Sound">{video.audio ? 'Yes' : 'No'}</Detail>}
        {video.seed !== undefined && <Detail label="Seed">{video.seed}</Detail>}
        {video.durationMs !== undefined && <Detail label="Time">{formatDuration(video.durationMs)}</Detail>}
        {video.costUsd !== undefined && (
          <Detail label="Cost">
            {formatUsd(video.costUsd)}
            {video.costEstimated && <span className="text-fg-muted"> estimated</span>}
          </Detail>
        )}
      </dl>
      {video.prompt && <PromptDetail label="Prompt" text={video.prompt} />}
      {video.negativePrompt && <PromptDetail label="Negative prompt" text={video.negativePrompt} />}
    </div>
  );
}

/** A hairline along the bottom edge while the clip is made. */
function Bar({ fraction }: { fraction: number }) {
  return (
    <div role="progressbar" aria-label="Making the video" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="absolute inset-x-0 bottom-0 h-0.5 bg-progress-track">
      <div className="h-full w-full origin-left bg-interactive transition-transform duration-500 ease-linear" style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}

/** The player. Its source carries `#t=0.001` so the first frame shows as the poster before anything is played. */
function Player({ video, arrived, onShape }: { video: ShownVideo; arrived: boolean; onShape(shape: ImageShape & { seconds: number }): void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [broken, setBroken] = useState(false);
  // Made while the person watches, it plays once on its own (muted, as a GIF would); one further up the page waits to be asked.
  const autoPlay = arrived && !wantsLessMotion();
  if (broken)
    return (
      <div className="absolute inset-0 flex items-center justify-center text-fg-muted">
        <VideoOff className="size-5" aria-hidden="true" />
        <span className="sr-only">This video is no longer available.</span>
      </div>
    );
  return (
    <video
      ref={ref}
      src={`${blobUrl(video.blob)}#t=0.001`}
      aria-label={video.prompt.slice(0, ALT_CHARS)}
      controls
      loop
      muted
      playsInline
      autoPlay={autoPlay}
      preload="metadata"
      crossOrigin="anonymous"
      onLoadedMetadata={(e) => {
        const el = e.currentTarget;
        if (el.videoWidth) onShape({ width: el.videoWidth, height: el.videoHeight, seconds: el.duration });
      }}
      onError={() => setBroken(true)}
      className="absolute inset-0 size-full bg-black object-contain outline-none"
    />
  );
}

/**
 * A GenerateVideo call in the transcript, for its whole life: waiting, making, done, stopped or refused. It stays one
 * element throughout, so the frame a clip was made in is the frame it arrives in.
 */
export function GeneratedVideos({ step, waiting }: { step: ImageStep; waiting: boolean }) {
  const { call, result, progress } = step;
  const videos = shownVideos(result, progress);
  const video = videos[0];
  const running = step.running && !video;
  // No result and no longer running: Atelier restarted under it.
  const failure = video || running ? null : videoFailure(result ? resultText(result) : 'Stopped.');
  const [arrived] = useState(step.running);
  const [opened, setOpened] = useState<{ details: boolean } | null>(null);
  const [natural, setNatural] = useState<(ImageShape & { seconds: number }) | undefined>();
  const toComposer = useRef(false);
  const composer = useContext(ComposerImages);
  const keepNatural = useCallback((shape: ImageShape & { seconds: number }) => setNatural(shape), []);
  // Before any early return: hooks run in the same order whatever the call is up to.
  const actions = useVideoActionsFor(video, () => setOpened({ details: false }), () => setOpened({ details: true }));

  const preview = progress?.preview;
  const fraction = videoFraction(progress);
  const prompt = video?.prompt ?? videoPrompt(call);
  // Refocus the message box after a frame went there from the viewer.
  useEffect(() => {
    if (opened === null && toComposer.current) {
      toComposer.current = false;
      composer?.focus();
    }
  }, [opened, composer]);

  if (failure)
    return (
      <figure className="flex flex-col">
        <ImageNotice failure={failure} />
        <figcaption>
          <PromptLine prompt={prompt} revised={undefined} />
        </figcaption>
      </figure>
    );

  const planned = plannedVideoShape(call, progress);
  const shape: ImageShape = video?.width && video.height ? { width: video.width, height: video.height } : (natural ?? planned);
  const ratio = shape.width / shape.height;
  // The same width while it is made and once it is there, whatever size the file turns out to be: a frame that changes size on arrival would jump.
  const width = `min(100%, calc(var(--at-image-max-height) * ${ratio.toFixed(4)}), ${MAX_FRAME_PX}px)`;

  return (
    <figure className="flex flex-col">
      <div className="at-image-frames @container max-w-full">
        <div style={{ width, '--at-image-ratio': ratio.toFixed(4) } as CSSProperties} className="transition-[width] duration-(--at-duration-base) ease-out">
          <div className={cn('group/video @container/cell relative min-w-0 rounded-2xl has-[video:focus-visible]:shadow-[var(--at-shadow-focus)]', arrived && 'transition-[opacity,scale] duration-(--at-duration-base) ease-out starting:scale-98 starting:opacity-0')} style={{ aspectRatio: 'var(--at-image-ratio)' }}>
            <div className="absolute inset-0 overflow-hidden rounded-[inherit] bg-fill-ghost-hover">
              {!video && preview && (
                <img aria-hidden="true" src={`data:${preview.mime};base64,${preview.data}`} alt="" className="absolute inset-0 size-full object-cover transition-[filter] duration-(--at-duration-slow) ease-out" style={{ filter: `blur(${previewBlur(fraction)}px)`, scale: 1.04 }} />
              )}
              {running && <span aria-hidden="true" className={cn('at-image-sheen', ((waiting && !progress) || preview) && 'opacity-0')} />}
              {video && <Player video={video} arrived={arrived} onShape={keepNatural} />}
              {running && fraction !== undefined && <Bar fraction={fraction} />}
              <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] inset-ring inset-ring-line" />
            </div>
            {video && <VideoOverlayActions actions={actions} />}
          </div>
        </div>
      </div>
      {/* One line under the frame in every state, so the status can hand over to the prompt with nothing moving. */}
      <figcaption className="mt-1.5 flex min-h-6 flex-col">
        {running ? (
          <div role="status" aria-live="off" className="flex h-6 items-center text-footnote text-fg-muted tabular-nums">
            <span key={progress?.phase ?? 'start'} className={cn('animate-[at-image-preview-in_240ms_ease-out] truncate', reducedMotionClass)}>
              {videoStatus(progress, { seconds: numberOf(call.input, 'seconds'), waiting })}
            </span>
          </div>
        ) : (
          <div className={cn(arrived && 'animate-[at-image-preview-in_240ms_ease-out]', reducedMotionClass)}>
            <PromptLine prompt={prompt} revised={undefined} />
          </div>
        )}
      </figcaption>
      <span role="status" className="sr-only">
        {video ? 'Video ready' : ''}
      </span>
      <VideoLightbox
        videos={video ? [{ src: blobUrl(video.blob), alt: video.prompt.slice(0, ALT_CHARS), ...(shape.width > 1 ? shape : {}) }] : []}
        index={opened ? 0 : null}
        onIndexChange={(index) => setOpened((now) => (index === null ? null : (now ?? { details: false })))}
        actions={() =>
          video && (
            <LightboxActions
              video={video}
              onAttached={() => {
                toComposer.current = true;
                setOpened(null);
              }}
            />
          )
        }
        details={() => video && <VideoDetails video={video} loaded={natural} />}
        detailsOpen={!!opened?.details}
        onDetailsOpenChange={(details) => setOpened((now) => now && { details })}
      />
    </figure>
  );
}

function numberOf(input: unknown, key: string): number | undefined {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** The overlay's actions for the clip shown, or none before there is one. A hook, so it is called the same way every render. */
function useVideoActionsFor(video: ShownVideo | undefined, onOpen: () => void, onDetails: () => void): VideoAction[] {
  const actions = useVideoActions(video ?? PLACEHOLDER, { onOpen, onDetails });
  return video ? actions : [];
}

const PLACEHOLDER: ShownVideo = { id: '', blob: '', mime: 'video/mp4', prompt: '', kind: 'video' };
