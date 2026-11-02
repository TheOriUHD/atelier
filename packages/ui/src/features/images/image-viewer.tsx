/**
 * An image from the Images page over the app, with what made it and the way back to its conversation. It looks and steps
 * like the `Lightbox`, which has no room for details of its own.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { ChevronLeft, ChevronRight, Download, MessageCircle, X } from 'lucide-react';
import type { GeneratedImage } from '@atelier/protocol';
import { Button, Dialog, Icon, IconButton, toast } from '../../components/ui/index.ts';
import { dialogBackdropClass } from '../../components/ui/styles.ts';
import { SESSION_ROUTE } from '../../app/navigation.ts';
import { shortDate } from '../../lib/dates.ts';
import { blobUrl, saveBlob } from '../../lib/platform.ts';
import { describeError } from '../../lib/rpc.ts';
import { sessionTitle } from '../../lib/sessions.ts';
import { formatUsd } from '../settings/usage-data.ts';

/** A control on its own surface, so it reads over any image and over the dimmed app in both themes. */
const control = (place: string) => `absolute ${place} rounded-xl bg-popover shadow-popover`;

/** The details panel's width (`--at-image-details-width`), set on the popup so the close button can stand beside it. */
const DETAILS_WIDTH = '[--at-image-details-width:320px]';

export interface ImageViewerProps {
  images: readonly GeneratedImage[];
  /** The image shown; null keeps it closed. */
  index: number | null;
  onIndexChange(index: number | null): void;
}

export function ImageViewer({ images, index, onIndexChange }: ImageViewerProps) {
  const open = index !== null && images.length > 0;
  const at = Math.max(0, Math.min(index ?? 0, images.length - 1));
  const image = images[at];
  const stage = useRef<HTMLDivElement>(null);
  const go = (to: number) => {
    if (to >= 0 && to < images.length) onIndexChange(to);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'ArrowRight') go(at + 1);
    else return;
    e.preventDefault();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onIndexChange(null)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={dialogBackdropClass} />
        <BaseDialog.Popup
          aria-label="Image"
          onKeyDown={onKeyDown}
          // The stage around the image is what's left of the backdrop; a click there is a click on it.
          onClick={(e) => e.target === stage.current && onIndexChange(null)}
          className={`${DETAILS_WIDTH} fixed inset-0 z-(--at-layout-z-modal) flex outline-none transition-opacity duration-(--at-duration-base) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0 max-md:flex-col max-md:overflow-y-auto`}
        >
          <div ref={stage} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center p-20 max-md:min-h-[60dvh] max-md:shrink-0 max-md:p-4 max-md:pt-16">
            {image && <img key={image.blob} src={blobUrl(image.blob)} alt={image.prompt} className="max-h-full max-w-full rounded-xl object-contain shadow-lg" />}
            {images.length > 1 && (
              <>
                <span className={control('top-1/2 left-4 -translate-y-1/2 max-md:left-2')}>
                  <IconButton icon={ChevronLeft} label="Previous image" iconSize="md" size="lg" disabled={at === 0} onClick={() => go(at - 1)} />
                </span>
                <span className={control('top-1/2 right-4 -translate-y-1/2 max-md:right-2')}>
                  <IconButton icon={ChevronRight} label="Next image" iconSize="md" size="lg" disabled={at === images.length - 1} onClick={() => go(at + 1)} />
                </span>
              </>
            )}
          </div>
          {image && <Details image={image} onLeave={() => onIndexChange(null)} />}
          <span className={control('top-4 right-4 md:right-[calc(var(--at-image-details-width)+16px)]')}>
            <BaseDialog.Close render={<IconButton icon={X} label="Close" iconSize="md" size="lg" />} />
          </span>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </Dialog>
  );
}

const seconds = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;

function Details({ image, onLeave }: { image: GeneratedImage; onLeave(): void }) {
  const download = () => void saveBlob(image.blob, `${image.id}.${image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1]}`).catch((e: unknown) => toast.error(describeError(e).message));
  return (
    <aside aria-label="Details" className="flex w-(--at-image-details-width) shrink-0 flex-col gap-5 overflow-y-auto bg-popover p-5 text-body shadow-popover max-md:w-full">
      <Block label="Prompt">{image.prompt}</Block>
      {image.revisedPrompt && <Block label="What the service made of it">{image.revisedPrompt}</Block>}
      {image.negativePrompt && <Block label="Negative prompt">{image.negativePrompt}</Block>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <Fact label="Model">{image.modelName}</Fact>
        {image.width > 0 && (
          <Fact label="Size">
            {image.width}×{image.height}
          </Fact>
        )}
        {image.seed !== undefined && <Fact label="Seed">{image.seed}</Fact>}
        {image.durationMs !== undefined && <Fact label="Took">{seconds(image.durationMs)}</Fact>}
        {image.costUsd !== undefined && (
          <Fact label="Cost">
            {formatUsd(image.costUsd)}
            {image.costEstimated && <span className="text-fg-muted"> estimate</span>}
          </Fact>
        )}
        <Fact label="Made">{shortDate(image.createdAt)}</Fact>
      </dl>
      <div className="mt-auto flex flex-col gap-2">
        {image.sessionId && image.sessionMode && (
          <Link
            to={SESSION_ROUTE[image.sessionMode]}
            params={{ sessionId: image.sessionId }}
            onClick={onLeave}
            className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg"
          >
            <Icon icon={MessageCircle} className="shrink-0" />
            <span className="min-w-0 truncate">{sessionTitle({ title: image.sessionTitle ?? '', mode: image.sessionMode })}</span>
          </Link>
        )}
        <Button leadingIcon={Download} onClick={download}>
          Download
        </Button>
      </div>
    </aside>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-footnote text-fg-muted">{label}</h3>
      <p className="break-words whitespace-pre-wrap text-fg">{children}</p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg tabular-nums">{children}</dd>
    </>
  );
}
