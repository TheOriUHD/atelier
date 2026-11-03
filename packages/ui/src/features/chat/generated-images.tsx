/**
 * Images a model made, where they belong in the conversation (design/components.md › GeneratedImages): a frame with the
 * final shape from the first moment, the picture forming in it, then the finished image in the same place, big.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Check, Copy, Download, Ellipsis, ImageOff, ImagePlus, Info, OctagonX, Paintbrush, type LucideIcon } from 'lucide-react';
import { Icon, IconButton, Lightbox, Menu, MenuContent, MenuItem, MenuTrigger, cn, toast, type ButtonSize } from '../../components/ui/index.ts';
import { reducedMotionClass } from '../../components/ui/styles.ts';
import { useOpenSettings } from '../../app/navigation.ts';
import { blobUrl, saveBlob } from '../../lib/platform.ts';
import { useAccount } from '../../lib/queries.ts';
import { describeError } from '../../lib/rpc.ts';
import { formatUsd } from '../settings/usage-data.ts';
import { useChangeArea } from '../images/change-area.tsx';
import { CopyButton } from './copy-button.tsx';
import { formatDuration, imageFailure, imageFileName, imageFraction, imageLayout, imageStatus, missingNote, plannedCount, plannedShape, previewBlur, promptOf, resultText, shownImages, type ImageFailure, type ImageLayout, type ImageShape, type ShownImage } from './image-view.ts';
import { Chevron } from './parts.tsx';
import type { ComposerHandle } from './composer.tsx';
import type { ActivityStepView } from './turns.ts';
import type { Attachments } from './use-attachments.ts';
import './generated-images.css';

/** What a page offers an image: into the message box as an attachment. Absent where a transcript has no box of its own. */
export const ComposerImages = createContext<{ attach(image: { blob: string; mime: string }): void; focus(): void; /** A file made on the page, such as a video's first frame. */ addFile?(file: File): void } | null>(null);

/** The message box as images see it: an image goes in once, is sent with the next message, and the model gets its id. */
export function useImageReference(attachments: Pick<Attachments, 'items' | 'restore'> & Partial<Pick<Attachments, 'add'>>, composer: RefObject<ComposerHandle | null>) {
  const { items, restore, add } = attachments;
  return useMemo(
    () => ({
      attach(image: { blob: string; mime: string }) {
        if (!items.some((a) => a.file?.blob === image.blob)) restore([{ type: 'image', blob: image.blob, mime: image.mime }]);
      },
      focus: () => composer.current?.focus(),
      ...(add ? { addFile: (file: File) => void add([file]) } : {}),
    }),
    [items, restore, add, composer],
  );
}

/** Images go on the clipboard only with the async Clipboard API, which browsers keep to https and localhost. */
export const canCopyImages = () => typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

/** The clipboard takes PNG everywhere, and little else, so anything other goes through a canvas. */
async function pngOf(src: string): Promise<Blob> {
  const blob = await (await fetch(src)).blob();
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('No PNG came out'))), 'image/png'));
}

interface ImageAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run(): void;
}

/** What can be done with an image, wherever it is shown. */
function useImageActions(image: ShownImage, { onDetails, onAttached, onAway }: { onDetails?: (() => void) | undefined; onAttached?: (() => void) | undefined; onAway?: (() => void) | undefined }): ImageAction[] {
  const [copied, setCopied] = useState(false);
  const composer = useContext(ComposerImages);
  const area = useChangeArea();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const fail = (e: unknown) => toast.error(describeError(e).message);
  return [
    ...(canCopyImages()
      ? [
          {
            id: 'copy',
            label: copied ? 'Copied' : 'Copy',
            icon: copied ? Check : Copy,
            // The promise goes into the item, not the other way round: Safari only allows a write that starts in the click.
            run: () => void navigator.clipboard.write([new ClipboardItem({ 'image/png': pngOf(blobUrl(image.blob)) })]).then(() => setCopied(true), () => toast.error('The image could not be copied.')),
          },
        ]
      : []),
    { id: 'download', label: 'Download', icon: Download, run: () => void saveBlob(image.blob, imageFileName(image)).catch(fail) },
    ...(composer
      ? [
          {
            id: 'reference',
            label: 'Use as reference',
            icon: ImagePlus,
            run() {
              composer.attach(image);
              if (onAttached) onAttached();
              else composer.focus();
            },
          },
        ]
      : []),
    ...(area
      ? [
          {
            id: 'area',
            label: 'Change an area',
            icon: Paintbrush,
            run() {
              area.open(image);
              // From the lightbox: it closes, so the editor is the only thing over the page.
              onAway?.();
            },
          },
        ]
      : []),
    ...(onDetails ? [{ id: 'details', label: 'Details', icon: Info, run: onDetails }] : []),
  ];
}

/** The actions as buttons in a row, for the lightbox's tile and over an image with room for them. */
function ActionButtons({ actions, size }: { actions: readonly ImageAction[]; size: ButtonSize }) {
  return actions.map((action) => <IconButton key={action.id} icon={action.icon} label={action.label} size={size} onClick={action.run} />);
}

/**
 * Over an image, shown on hover and focus, and all the time where nothing can hover. A cell of a phone's grid has no
 * room for a row of four, and a row on each of four images would hide them: there they fold into one button.
 */
function ImageOverlayActions({ image, onDetails }: { image: ShownImage; onDetails(): void }) {
  const actions = useImageActions(image, { onDetails });
  const surface = 'absolute top-2 right-2 items-center rounded-lg bg-popover p-0.5 text-fg-secondary shadow-popover transition-opacity delay-100 duration-(--at-duration-snap) ease-snap';
  const reveal = 'opacity-0 group-focus-within/image:opacity-100 group-hover/image:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100';
  return (
    <>
      <div className={cn(surface, reveal, 'flex @max-[239px]/cell:hidden')}>
        <ActionButtons actions={actions} size="sm" />
      </div>
      <div className={cn(surface, reveal, 'hidden @max-[239px]/cell:flex')}>
        <Menu>
          <MenuTrigger render={<IconButton icon={Ellipsis} label="Image actions" size="sm" />} />
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

function LightboxActions({ image, onAttached, onAway }: { image: ShownImage; onAttached(): void; onAway(): void }) {
  return <ActionButtons actions={useImageActions(image, { onAttached, onAway })} size="lg" />;
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-footnote text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-right text-footnote break-words text-fg tabular-nums">{children}</dd>
    </div>
  );
}

export function PromptDetail({ label, text }: { label: string; text: string }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex h-6 items-center justify-between">
        <h4 className="text-footnote text-fg-muted">{label}</h4>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <p data-selectable className="text-body break-words whitespace-pre-wrap text-fg">
        {text}
      </p>
    </section>
  );
}

/** Everything known about an image, in the lightbox's details panel. Old results know little, and show that little. */
export function ImageDetails({ image, loaded }: { image: ShownImage; loaded: ImageShape | undefined }) {
  const size = image.width && image.height ? { width: image.width, height: image.height } : loaded;
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col divide-y divide-line-subtle">
        {image.modelName && <Detail label="Model">{image.modelName}</Detail>}
        {size && (
          <Detail label="Size">
            {size.width} × {size.height}
          </Detail>
        )}
        {image.seed !== undefined && <Detail label="Seed">{image.seed}</Detail>}
        {image.durationMs !== undefined && <Detail label="Time">{formatDuration(image.durationMs)}</Detail>}
        {image.costUsd !== undefined && (
          <Detail label="Cost">
            {formatUsd(image.costUsd)}
            {image.costEstimated && <span className="text-fg-muted"> estimated</span>}
          </Detail>
        )}
      </dl>
      {image.prompt && <PromptDetail label="Prompt" text={image.prompt} />}
      {image.revisedPrompt && <PromptDetail label="Reworded by the service" text={image.revisedPrompt} />}
      {image.negativePrompt && <PromptDetail label="Negative prompt" text={image.negativePrompt} />}
    </div>
  );
}

const ratio = ({ width, height }: ImageShape) => width / height;

const LAYOUT_CLASS: Record<ImageLayout, string> = {
  one: 'grid-cols-1',
  row: 'grid-cols-(--at-image-columns)',
  'hero-side': 'grid-cols-[2fr_1fr] @max-[520px]:grid-cols-2',
  'hero-top': 'grid-cols-2',
  strip: 'grid-cols-4 @max-[520px]:grid-cols-2',
  grid: 'grid-cols-2',
};

/** How wide the frames may be: the column, or less where the height limit would be reached first. */
function blockWidth(layout: ImageLayout, shapes: readonly ImageShape[]): string {
  const first = ratio(shapes[0] ?? { width: 1, height: 1 });
  const stands: Record<ImageLayout, number> = {
    one: first,
    row: shapes.reduce((sum, s) => sum + ratio(s), 0),
    // The hero and the stack beside it stand as tall as one big picture, half again as wide.
    'hero-side': first * 1.5,
    'hero-top': first / 1.5,
    strip: first * 4,
    grid: first,
  };
  const single = shapes.length === 1 ? shapes[0] : undefined;
  // A small picture is shown at its own size, or a little over; blown up to the column it would only look soft.
  const own = single && single.width > 64 ? `, ${Math.max(single.width, 480)}px` : '';
  return `min(100%, calc(var(--at-image-max-height) * ${stands[layout].toFixed(4)})${own})`;
}

/** The hero of three images takes two cells, and the frames' `aspect-ratio` is left to the stretch beside it. */
function cellClass(layout: ImageLayout, index: number): string {
  if (index !== 0) return '[aspect-ratio:var(--at-image-ratio)]';
  if (layout === 'hero-top') return 'col-span-2 [aspect-ratio:var(--at-image-ratio)]';
  if (layout === 'hero-side') return 'row-span-2 @max-[520px]:col-span-2 @max-[520px]:row-span-1 @max-[520px]:[aspect-ratio:var(--at-image-ratio)]';
  return '[aspect-ratio:var(--at-image-ratio)]';
}

/** The frames' arrangement, the same while an image is made and once it is there, so nothing moves when it arrives. */
function ImageFrames({ shapes, children }: { shapes: readonly ImageShape[]; children: (cell: { className: string; style: CSSProperties }, index: number) => ReactNode }) {
  const layout = imageLayout(shapes);
  // Two wide pictures side by side in a narrow column would be two slivers.
  const stack = layout === 'row' && shapes.every((s) => ratio(s) > 1.2);
  const style = {
    width: blockWidth(layout, shapes),
    '--at-image-columns': shapes.map((s) => `${ratio(s).toFixed(4)}fr`).join(' '),
  } as CSSProperties;
  return (
    <div className="at-image-frames @container max-w-full">
      <div style={style} className={cn('grid gap-2 transition-[width] duration-(--at-duration-base) ease-out', LAYOUT_CLASS[layout], stack && '@max-[520px]:grid-cols-1')}>
        {shapes.map((shape, i) => children({ className: cellClass(layout, i), style: { '--at-image-ratio': ratio(shape).toFixed(4) } as CSSProperties }, i))}
      </div>
    </div>
  );
}

interface PreviewFrame {
  id: number;
  mime: string;
  data: string;
  /** How far the work was when it came, which is how blurred it stays if the run stops here. */
  fraction: number | undefined;
}

/** The picture forming: each frame over the last, sharpening as the steps go by. Larger than its frame, so a blurred edge never shows. */
function Forming({ frames, blur }: { frames: readonly PreviewFrame[]; blur: number }) {
  return (
    <div aria-hidden="true" className="absolute inset-0 transition-[filter,scale] duration-(--at-duration-slow) ease-out" style={{ filter: blur ? `blur(${blur}px)` : undefined, scale: 1 + blur * 0.006 }}>
      {frames.map((frame) => (
        <img key={frame.id} src={`data:${frame.mime};base64,${frame.data}`} alt="" className="absolute inset-0 size-full animate-[at-image-preview-in_420ms_ease-out] object-cover" />
      ))}
    </div>
  );
}

/** A hairline along the bottom edge. Moves on `transform`, as long as updates are apart, so it glides from one to the next. */
function Bar({ fraction, label }: { fraction: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="absolute inset-x-0 bottom-0 h-0.5 bg-progress-track">
      <div className="h-full w-full origin-left bg-interactive transition-transform duration-500 ease-linear" style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}

/** The time the crossfade takes, and a little over, before the preview under the image can go. */
const CROSSFADE_MS = 520;
export const ALT_CHARS = 200;

function FinishedImage({ image, position, arrived, shapeKnown, onShape, onLanded, onOpen }: { image: ShownImage; position: string; arrived: boolean; shapeKnown: boolean; onShape(shape: ImageShape): void; onLanded(): void; onOpen(): void }) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  // A prompt can run to pages; what a screen reader says of each image needn't.
  const alt = image.prompt.slice(0, ALT_CHARS);
  const loadedNow = () => {
    setLoaded(true);
    const img = ref.current;
    if (!shapeKnown && img?.naturalWidth) onShape({ width: img.naturalWidth, height: img.naturalHeight });
  };
  // Already in the browser's cache, it can be complete before React is listening.
  useLayoutEffect(() => {
    if (ref.current?.complete && ref.current.naturalWidth) setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded || broken) onLanded();
  }, [loaded, broken, onLanded]);
  if (broken)
    return (
      <div className="absolute inset-0 flex items-center justify-center text-fg-muted">
        <Icon icon={ImageOff} size="md" />
        <span className="sr-only">This image is no longer available.</span>
      </div>
    );
  return (
    <button type="button" data-image-open aria-label={`Open image${position}: ${alt}`} onClick={onOpen} className="absolute inset-0 block cursor-zoom-in outline-none">
      <img
        ref={ref}
        src={blobUrl(image.blob)}
        alt={alt}
        // A new image is the point of the moment; an old one further up can wait until it is scrolled to.
        loading={arrived ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        onLoad={loadedNow}
        onError={() => setBroken(true)}
        data-loaded={loaded || undefined}
        className={cn(
          'block size-full cursor-zoom-in object-cover opacity-0 ease-out data-loaded:opacity-100',
          arrived ? 'blur-[4px] transition-[opacity,filter] duration-(--at-duration-slow) data-loaded:blur-none' : 'transition-opacity duration-(--at-duration-base)',
        )}
      />
    </button>
  );
}

const NOTICE_ICON: Partial<Record<ImageFailure['kind'], LucideIcon>> = { refused: OctagonX, setup: ImageOff, failed: ImageOff };

/** Why there is no image: said once, quietly, with the way to fix it for those who can. */
export function ImageNotice({ failure }: { failure: ImageFailure }) {
  const { account } = useAccount();
  const openSettings = useOpenSettings();
  const icon = NOTICE_ICON[failure.kind];
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-body">
      {icon && <Icon icon={icon} className="text-fg-muted" />}
      <span data-selectable className="min-w-0 text-fg-secondary">
        {failure.text}
      </span>
      {failure.kind === 'setup' && account?.role === 'admin' && (
        <button type="button" onClick={() => openSettings('image-providers')} className="rounded-xs text-interactive-text underline-offset-2 outline-none hover:underline focus-ring">
          Fix in Settings
        </button>
      )}
    </div>
  );
}

/** The prompt under the images: one line that opens to all of it, with how the service reworded it if it did. */
export function PromptLine({ prompt, revised }: { prompt: string; revised: string | undefined }) {
  const [open, setOpen] = useState(false);
  if (!prompt && !revised) return null;
  return (
    <div className="flex min-h-6 items-start gap-1.5 text-footnote text-fg-muted">
      {open && (
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-[3px]">
          <p data-selectable className="break-words whitespace-pre-wrap">
            {prompt}
          </p>
          {revised && revised !== prompt && (
            <p data-selectable className="break-words whitespace-pre-wrap">
              <span className="text-fg-secondary">Reworded by the service: </span>
              {revised}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Hide the prompt' : `Show the prompt: ${prompt.slice(0, ALT_CHARS)}`}
        onClick={() => setOpen((o) => !o)}
        className={cn('flex h-6 items-center gap-1.5 rounded-sm text-left outline-none focus-ring hover:text-fg-secondary', open ? 'shrink-0' : 'min-w-0')}
      >
        {!open && <span className="min-w-0 truncate">{prompt}</span>}
        <Chevron open={open} />
      </button>
    </div>
  );
}

export type ImageStep = Extract<ActivityStepView, { kind: 'tool' }>;

/**
 * A GenerateImage call in the transcript, for its whole life: waiting, forming, done, stopped or refused. It stays one
 * element throughout, so the frame an image was made in is the frame it arrives in.
 */
export function GeneratedImages({ step, waiting }: { step: ImageStep; waiting: boolean }) {
  const { call, result, progress } = step;
  const images = shownImages(call, result, progress);
  const finished = images.length > 0;
  const running = step.running && !finished;
  // No result and no longer running: Atelier restarted under it.
  const failure = finished || running ? null : imageFailure(result ? resultText(result) : 'Stopped.');
  // Made while on screen: the frames come in and the image takes over from the preview. An old message's images are just there.
  const [arrived] = useState(step.running);
  const [opened, setOpened] = useState<{ index: number; details: boolean } | null>(null);
  // What an image's own file says, for results that don't: its frame starts from the plan and takes its shape once it loads.
  const [natural, setNatural] = useState<Record<string, ImageShape>>({});
  const composer = useContext(ComposerImages);
  // Used as a reference from the lightbox: when it closes, the person's next move is in the message box.
  const toComposer = useRef(false);

  // Previews aren't stored and leave with the result, so the frame keeps its own: a stopped run shows how far it got.
  const [frames, setFrames] = useState<PreviewFrame[]>([]);
  const fraction = imageFraction(progress);
  const preview = progress?.preview;
  if (preview && frames.at(-1)?.data !== preview.data) setFrames((kept) => [...kept.slice(-1), { id: (kept.at(-1)?.id ?? 0) + 1, ...preview, fraction }]);
  // Counted from the image being there: a big file on a slow connection must not leave the frame empty in between.
  const [landed, setLanded] = useState(false);
  const onLanded = useCallback(() => setLanded(true), []);
  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setFrames([]), CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [landed]);

  const prompt = images[0]?.prompt ?? promptOf(call);
  // Nothing to show for the frame's place: the words take it, and the message goes on under them.
  if (failure && !(failure.kind === 'stopped' && frames.length > 0))
    return (
      <figure className="flex flex-col">
        <ImageNotice failure={failure} />
        <figcaption>
          <PromptLine prompt={prompt} revised={undefined} />
        </figcaption>
      </figure>
    );

  const planned = plannedShape(call, progress);
  const count = plannedCount(call, progress);
  const shapes = finished ? images.map((image): ImageShape => (image.width && image.height ? { width: image.width, height: image.height } : (natural[image.id] ?? planned))) : Array.from({ length: count }, () => planned);
  const blur = finished ? 0 : previewBlur(fraction ?? frames.at(-1)?.fraction);
  const note = missingNote(result);

  return (
    <figure className="flex flex-col">
      <ImageFrames shapes={shapes}>
        {(cell, i) => {
          const image = images[i];
          const forming = i === 0 && frames.length > 0;
          return (
            <div
              key={i}
              style={{ ...cell.style, transitionDelay: arrived && !finished ? `${i * 40}ms` : undefined }}
              className={cn(
                'group/image @container/cell relative min-w-0 rounded-2xl has-[[data-image-open]:focus-visible]:shadow-[var(--at-shadow-focus)]',
                arrived && 'transition-[opacity,scale,aspect-ratio] duration-(--at-duration-base) ease-out starting:scale-98 starting:opacity-0',
                cell.className,
              )}
            >
              <div className="absolute inset-0 overflow-hidden rounded-[inherit] bg-fill-ghost-hover">
                {forming && <Forming frames={frames} blur={blur} />}
                {/* Nothing is at work yet while the run waits on the person. */}
                {running && <span aria-hidden="true" className={cn('at-image-sheen', (forming || (waiting && !progress)) && 'opacity-0')} />}
                {image && (
                  <FinishedImage
                    image={image}
                    position={images.length > 1 ? ` ${i + 1} of ${images.length}` : ''}
                    arrived={arrived}
                    shapeKnown={!!(image.width && image.height)}
                    onShape={(shape) => setNatural((known) => ({ ...known, [image.id]: shape }))}
                    onLanded={onLanded}
                    onOpen={() => setOpened({ index: i, details: false })}
                  />
                )}
                {running && fraction !== undefined && <Bar fraction={fraction} label={count > 1 ? `Making image ${i + 1} of ${count}` : 'Making the image'} />}
                {/* Over the picture, so a dark image keeps its edge on a dark page and a light one on a light page. */}
                <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] inset-ring inset-ring-line" />
              </div>
              {image && <ImageOverlayActions image={image} onDetails={() => setOpened({ index: i, details: true })} />}
            </div>
          );
        }}
      </ImageFrames>
      {/* One line under the frames in every state, so the status can hand over to the prompt with nothing moving. */}
      <figcaption className="mt-1.5 flex min-h-6 flex-col">
        {running ? (
          <div role="status" aria-live="off" className="flex h-6 items-center text-footnote text-fg-muted tabular-nums">
            <span key={progress?.phase ?? 'start'} className={cn('animate-[at-image-preview-in_240ms_ease-out] truncate', reducedMotionClass)}>
              {imageStatus(progress, { count, waiting })}
            </span>
          </div>
        ) : failure ? (
          <ImageNotice failure={failure} />
        ) : (
          <div className={cn(arrived && 'animate-[at-image-preview-in_240ms_ease-out]', reducedMotionClass)}>
            <PromptLine prompt={prompt} revised={images[0]?.revisedPrompt} />
          </div>
        )}
        {note && <p className="text-footnote text-fg-muted">The rest didn’t come back: {note}</p>}
      </figcaption>
      {/* Steps would be read out one by one; the end is said once instead. */}
      <span role="status" className="sr-only">
        {finished ? (images.length === 1 ? 'Image ready' : `${images.length} images ready`) : ''}
      </span>
      <Lightbox
        images={images.map((image) => ({ src: blobUrl(image.blob), alt: image.prompt.slice(0, ALT_CHARS) }))}
        index={opened?.index ?? null}
        onIndexChange={(index) => setOpened((now) => (index === null ? null : { index, details: now?.details ?? false }))}
        actions={(index) =>
          images[index] && (
            <LightboxActions
              image={images[index]}
              onAway={() => setOpened(null)}
              onAttached={() => {
                toComposer.current = true;
                setOpened(null);
              }}
            />
          )
        }
        details={(index) => images[index] && <ImageDetails image={images[index]} loaded={natural[images[index].id]} />}
        detailsOpen={!!opened?.details}
        onDetailsOpenChange={(details) => setOpened((now) => now && { ...now, details })}
        finalFocus={() => {
          if (!toComposer.current) return true;
          toComposer.current = false;
          composer?.focus();
          return false;
        }}
      />
    </figure>
  );
}
