/**
 * Images in the transcript open bigger in the `Lightbox`; the images a run of tool calls looked at show as thumbnails
 * on its summary line (design/components.md › Transcript).
 */
import { useState, type ReactNode } from 'react';
import { PreviewCard } from '@base-ui/react/preview-card';
import { Lightbox, cn, type LightboxImage } from '../../components/ui/index.ts';
import { popupMotionClass, positionerClass } from '../../components/ui/styles.ts';
import { blobUrl } from '../../lib/platform.ts';
import type { ActivityStepView } from './turns.ts';

/** An image that opens in the lightbox on click, with the rest of `group` a step away. */
export function ZoomableImage({ group, index = 0, className }: { group: readonly LightboxImage[]; index?: number; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const image = group[index];
  if (!image) return null;
  return (
    <>
      <button type="button" aria-label={image.alt ? undefined : 'Open image'} onClick={() => setOpen(index)} className="max-w-full cursor-zoom-in rounded-lg outline-none focus-ring">
        <img src={image.src} alt={image.alt ?? ''} loading="lazy" className={cn('cursor-zoom-in', className)} />
      </button>
      <Lightbox images={group} index={open} onIndexChange={setOpen} />
    </>
  );
}

/** An image a tool call gave the model, with the tool that produced it. */
export interface ViewedImage extends LightboxImage {
  tool: string;
}

/** "Read", "Screenshot", "Take snapshot": a tool's name as the preview's footer shows it. */
export function toolLabel(name: string): string {
  if (/screenshot/i.test(name)) return 'Screenshot';
  const words = (name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : name).replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The images the steps' tool results carried to the model, in order. */
export function viewedImages(steps: readonly ActivityStepView[]): ViewedImage[] {
  return steps.flatMap((step) => {
    if (step.kind !== 'tool' || !step.result) return [];
    const tool = toolLabel(step.call.name);
    return step.result.content.flatMap((c) => (c.type === 'image' ? [{ src: blobUrl(c.blob), alt: `${tool} image`, tool }] : []));
  });
}

/** How many thumbnails a summary line shows; earlier ones are counted ("+7"). */
const SHOWN = 3;

/** The last few images a run looked at, as small thumbnails: hover previews one, a click opens the lightbox. */
export function ViewedImages({ images }: { images: readonly ViewedImage[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (images.length === 0) return null;
  const first = Math.max(0, images.length - SHOWN);
  return (
    <div role="group" aria-label="Images looked at" className="flex shrink-0 items-center gap-1.5">
      {first > 0 && <span className="pr-0.5 text-footnote text-fg-muted tabular-nums">+{first}</span>}
      {images.slice(first).map((image, i) => (
        <Thumbnail key={first + i} image={image} position={first + i} total={images.length} onOpen={() => setOpen(first + i)} />
      ))}
      <Lightbox images={images} index={open} onIndexChange={setOpen} />
    </div>
  );
}

function Thumbnail({ image, position, total, onOpen }: { image: ViewedImage; position: number; total: number; onOpen(): void }) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${image.tool} image ${position + 1} of ${total}`}
            onClick={onOpen}
            className="h-6 w-8 shrink-0 cursor-zoom-in overflow-hidden rounded-[6px] border border-line bg-fill-ghost-hover outline-none focus-ring"
          />
        }
      >
        <img src={image.src} alt="" loading="lazy" className="size-full object-cover" />
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="top" align="end" sideOffset={8} className={positionerClass}>
          <PreviewCard.Popup aria-label="Image preview" className={cn('flex w-fit flex-col overflow-hidden rounded-2xl bg-popover text-fg shadow-popover outline-none', popupMotionClass)}>
            <img src={image.src} alt={image.alt ?? ''} className="block max-h-[min(480px,60vh)] max-w-[min(640px,calc(100vw-32px))] bg-fill-ghost-hover object-contain" />
            <div className="flex items-center justify-between gap-4 border-t border-line px-3 py-2 text-footnote">
              <span className="truncate text-fg-secondary">{image.tool}</span>
              <span className="shrink-0 text-fg-muted tabular-nums">
                {position + 1} of {total}
              </span>
            </div>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/** A summary line with the thumbnails of what its steps looked at, right-aligned on the same line. */
export function WithViewedImages({ steps, children }: { steps: readonly ActivityStepView[]; children: ReactNode }) {
  const images = viewedImages(steps);
  // Same tree with or without thumbnails, so the line doesn't remount when the first image arrives mid-run.
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col justify-center">{children}</div>
      <ViewedImages images={images} />
    </div>
  );
}
