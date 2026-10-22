import type { KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Dialog } from './dialog.tsx';
import { IconButton } from './icon-button.tsx';
import { dialogBackdropClass } from './styles.ts';

export interface LightboxImage {
  src: string;
  alt?: string;
}

/** A control on its own surface, so it reads over any image and over the dimmed app in both themes. */
const control = (place: string) => `absolute ${place} rounded-xl bg-popover shadow-popover`;

export interface LightboxProps {
  images: readonly LightboxImage[];
  /** The image shown; null keeps the lightbox closed. */
  index: number | null;
  /** Steps to another image, or closes (null). */
  onIndexChange(index: number | null): void;
}

/**
 * An image over the app, fitted to the window, with its group's other images a step away (arrow buttons and keys).
 * Escape, the close button and a click beside the image close it.
 */
export function Lightbox({ images, index, onIndexChange }: LightboxProps) {
  const open = index !== null && images.length > 0;
  const at = Math.max(0, Math.min(index ?? 0, images.length - 1));
  const image = images[at];
  const several = images.length > 1;
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
          // The popup covers the window around the image; a click there is a click on the backdrop.
          onClick={(e) => e.target === e.currentTarget && onIndexChange(null)}
          className="fixed inset-0 z-(--at-layout-z-modal) flex items-center justify-center outline-none transition-opacity duration-(--at-duration-base) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          {image && <img key={image.src} src={image.src} alt={image.alt ?? ''} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-lg" />}
          <span className={control('top-4 right-4')}>
            <BaseDialog.Close render={<IconButton icon={X} label="Close" iconSize="md" size="lg" />} />
          </span>
          {several && (
            <>
              <span className={control('top-1/2 left-4 -translate-y-1/2')}>
                <IconButton icon={ChevronLeft} label="Previous image" iconSize="md" size="lg" disabled={at === 0} onClick={() => go(at - 1)} />
              </span>
              <span className={control('top-1/2 right-4 -translate-y-1/2')}>
                <IconButton icon={ChevronRight} label="Next image" iconSize="md" size="lg" disabled={at === images.length - 1} onClick={() => go(at + 1)} />
              </span>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-popover px-3 py-1 text-footnote text-fg tabular-nums shadow-popover">
                {at + 1} of {images.length}
              </span>
            </>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </Dialog>
  );
}
