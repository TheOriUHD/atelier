import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Info, X } from 'lucide-react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { cn } from './cn.ts';
import { Dialog } from './dialog.tsx';
import { IconButton } from './icon-button.tsx';
import { dialogBackdropClass } from './styles.ts';

export interface LightboxVideo {
  src: string;
  /** What it shows, for those who can't see it. */
  alt?: string;
  /** The frame's shape, so the player has it before the file has loaded. */
  width?: number;
  height?: number;
}

export interface VideoLightboxProps {
  videos: readonly LightboxVideo[];
  /** The video shown; null keeps the viewer closed. */
  index: number | null;
  /** Steps to another video, or closes (null). */
  onIndexChange(index: number | null): void;
  actions?: (index: number) => ReactNode;
  /** What the details panel shows; without it there is no panel and no button for one. */
  details?: (index: number) => ReactNode;
  detailsOpen?: boolean;
  onDetailsOpenChange?(open: boolean): void;
}

/** A control on its own surface, so it reads over any video and over the dimmed app in both themes. */
const control = (place: string) => `absolute ${place} rounded-xl bg-popover shadow-popover`;

/**
 * A video over the app, fitted to the window, with the browser's own player: play, seek, volume and full screen work by
 * pointer, touch and keyboard as in any page. Unlike the picture lightbox it has no zoom or drag, which would take a
 * click away from the controls. It starts muted and playing as a still picture would simply be there; Escape, Close and a
 * click beside the video close it.
 */
export function VideoLightbox({ videos, index, onIndexChange, actions, details, detailsOpen = false, onDetailsOpenChange }: VideoLightboxProps) {
  const open = index !== null && videos.length > 0;
  // While it closes `index` is null already: the video stays until the fade is over.
  const [last, setLast] = useState(0);
  if (index !== null && index !== last) setLast(index);
  const at = Math.max(0, Math.min(index ?? last, videos.length - 1));
  const video = videos[at];
  const several = videos.length > 1;
  const go = (to: number) => to >= 0 && to < videos.length && onIndexChange(to);
  // Arrow keys belong to the player while it has focus (they seek); the buttons and Escape work everywhere.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLVideoElement || e.metaKey || e.ctrlKey || e.altKey) return;
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
          aria-label="Video"
          onKeyDown={onKeyDown}
          onClick={(e) => e.target === e.currentTarget && onIndexChange(null)}
          className="fixed inset-0 z-(--at-layout-z-modal) flex items-center justify-center outline-none transition-opacity duration-(--at-duration-base) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          <div
            role="presentation"
            onClick={(e) => e.target === e.currentTarget && onIndexChange(null)}
            className={cn('absolute inset-0 flex items-center justify-center p-16 transition-[padding] duration-(--at-duration-base) ease-out max-md:p-4 max-md:pt-16', details && detailsOpen && 'md:pr-[352px] md:pl-4')}
          >
            {video && (
              <video
                key={video.src}
                src={video.src}
                aria-label={video.alt}
                controls
                loop
                muted
                autoPlay
                playsInline
                preload="metadata"
                style={video.width && video.height ? { aspectRatio: `${video.width} / ${video.height}` } : undefined}
                className="max-h-full max-w-full rounded-xl bg-black object-contain shadow-lg outline-none focus-visible:shadow-[var(--at-shadow-focus)]"
              />
            )}
          </div>
          <span className={cn(control('top-4 right-4'), 'flex items-center')}>
            {actions?.(at)}
            {details && <IconButton icon={Info} label="Details" iconSize="md" size="lg" aria-pressed={detailsOpen} onClick={() => onDetailsOpenChange?.(!detailsOpen)} />}
            <BaseDialog.Close render={<IconButton icon={X} label="Close" iconSize="md" size="lg" />} />
          </span>
          {details && detailsOpen && (
            <aside
              aria-label="Details"
              className="absolute top-[72px] right-4 flex max-h-[calc(100dvh-88px)] w-80 flex-col overflow-y-auto rounded-2xl bg-popover p-4 text-body text-fg shadow-popover max-md:inset-x-4 max-md:top-auto max-md:bottom-4 max-md:max-h-[45dvh] max-md:w-auto"
            >
              {details(at)}
            </aside>
          )}
          {several && (
            <>
              <span className={control('top-1/2 left-4 -translate-y-1/2')}>
                <IconButton icon={ChevronLeft} label="Previous video" iconSize="md" size="lg" disabled={at === 0} onClick={() => go(at - 1)} />
              </span>
              <span className={cn(control('top-1/2 -translate-y-1/2'), details && detailsOpen ? 'right-[352px] max-md:right-4' : 'right-4')}>
                <IconButton icon={ChevronRight} label="Next video" iconSize="md" size="lg" disabled={at === videos.length - 1} onClick={() => go(at + 1)} />
              </span>
            </>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </Dialog>
  );
}
