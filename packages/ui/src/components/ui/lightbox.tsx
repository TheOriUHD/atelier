import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Info, Minus, Plus, X } from 'lucide-react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { cn } from './cn.ts';
import { Dialog } from './dialog.tsx';
import { IconButton } from './icon-button.tsx';
import { FITTED, PAN_STEP, ZOOM_STEP, distance, doubleClickScale, dragged, middle, settle, wheelScale, zoomAt, type Point, type ZoomView } from './lightbox-zoom.ts';
import { dialogBackdropClass } from './styles.ts';

export interface LightboxImage {
  src: string;
  alt?: string;
}

/** A control on its own surface, so it reads over any image and over the dimmed app in both themes. */
const control = (place: string) => `absolute ${place} rounded-xl bg-popover shadow-popover`;

/** A movement this small is a click that wavered, not a drag. */
const DRAG_PX = 3;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;

export interface LightboxProps {
  images: readonly LightboxImage[];
  /** The image shown; null keeps the lightbox closed. */
  index: number | null;
  /** Steps to another image, or closes (null). */
  onIndexChange(index: number | null): void;
  /** Buttons for the image shown, beside Close. */
  actions?: (index: number) => ReactNode;
  /** What the image's details panel shows; without it there is no panel and no button for one. */
  details?: (index: number) => ReactNode;
  detailsOpen?: boolean;
  onDetailsOpenChange?(open: boolean): void;
  /** Where focus goes on closing, when not back to what opened it (an action that sent the person elsewhere). */
  finalFocus?: BaseDialog.Popup.Props['finalFocus'];
}

/**
 * An image over the app, fitted to the window, with its group's other images a step away (arrow buttons and keys).
 * Wheel, pinch, double-click, the zoom buttons and + − 0 zoom in; a drag or the arrow keys then pan. Escape, the close
 * button and a click beside the image close it.
 */
export function Lightbox({ images, index, onIndexChange, actions, details, detailsOpen = false, onDetailsOpenChange, finalFocus }: LightboxProps) {
  const open = index !== null && images.length > 0;
  // While it closes `index` is null already: the image stays until the fade is over.
  const [last, setLast] = useState(0);
  if (index !== null && index !== last) setLast(index);
  const at = Math.max(0, Math.min(index ?? last, images.length - 1));
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onIndexChange(null)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={dialogBackdropClass} />
        <LightboxBody images={images} at={at} onIndexChange={onIndexChange} actions={actions} details={details} detailsOpen={detailsOpen} onDetailsOpenChange={onDetailsOpenChange} finalFocus={finalFocus} />
      </BaseDialog.Portal>
    </Dialog>
  );
}

function LightboxBody({ images, at, onIndexChange, actions, details, detailsOpen, onDetailsOpenChange, finalFocus }: Omit<LightboxProps, 'index'> & { at: number; detailsOpen: boolean }) {
  const image = images[at];
  const several = images.length > 1;
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const viewNow = useRef(FITTED);
  const [view, setView] = useState(FITTED);
  // The size in real pixels, at the moment the view last changed.
  const [percent, setPercent] = useState(100);
  // Buttons, keys and a double-click glide; a finger, a drag or a wheel moves the picture directly.
  const [gliding, setGliding] = useState(false);
  const zoomed = view.scale > 1;

  const show = (next: ZoomView, glide: boolean) => {
    viewNow.current = next;
    setView(next);
    setGliding(glide);
    const img = picture.current;
    if (img?.naturalWidth) setPercent(Math.round(((next.scale * img.offsetWidth) / img.naturalWidth) * 100));
  };
  const measure = () => ({
    pictureSize: { width: picture.current?.offsetWidth ?? 0, height: picture.current?.offsetHeight ?? 0 },
    stageSize: { width: stage.current?.clientWidth ?? 0, height: stage.current?.clientHeight ?? 0 },
  });
  /** A point on the screen, measured from the middle of the stage. */
  const fromCenter = ({ x, y }: Point): Point => {
    const box = stage.current?.getBoundingClientRect();
    return box ? { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 } : { x: 0, y: 0 };
  };
  const zoomTo = (scale: number, at: Point, glide: boolean) => {
    const { pictureSize, stageSize } = measure();
    show(settle(zoomAt(viewNow.current, scale, at), pictureSize, stageSize), glide);
  };
  const go = (to: number) => {
    if (to < 0 || to >= images.length) return;
    show(FITTED, false);
    onIndexChange(to);
  };
  const toggleZoom = (point: Point) => {
    if (viewNow.current.scale > 1) return show(FITTED, true);
    const img = picture.current;
    zoomTo(doubleClickScale(img?.naturalWidth ? img.offsetWidth / img.naturalWidth : 0), point, true);
  };

  // React's own wheel listener is passive, so it couldn't stop the page zooming along with a trackpad pinch.
  const onWheelNow = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    onWheelNow.current = (e) => {
      e.preventDefault();
      zoomTo(wheelScale(viewNow.current.scale, e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1), e.ctrlKey), fromCenter({ x: e.clientX, y: e.clientY }), false);
    };
  });
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => onWheelNow.current(e);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<{ from: Point; view: ZoomView } | null>(null);
  const pinch = useRef<{ distance: number; center: Point; view: ZoomView } | null>(null);
  // The press turned into a gesture, so the click that ends it isn't one.
  const moved = useRef(false);
  const lastTap = useRef({ at: 0, x: 0, y: 0 });
  // Touch screens send both a double tap of ours and, on some, a dblclick after it.
  const tapZoomed = useRef(0);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    moved.current = false;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [first, second] = [...pointers.current.values()];
    if (first && second) {
      // A second finger: the gesture is a pinch now, and whichever fingers came later don't matter.
      drag.current = null;
      pinch.current = { distance: distance(first, second), center: fromCenter(middle(first, second)), view: viewNow.current };
      moved.current = true;
    } else if (first) drag.current = { from: first, view: viewNow.current };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [first, second] = [...pointers.current.values()];
    if (pinch.current && first && second) {
      const { distance: start, center, view: from } = pinch.current;
      const now = fromCenter(middle(first, second));
      const next = zoomAt(from, (from.scale * distance(first, second)) / start, center);
      const { pictureSize, stageSize } = measure();
      show(dragged({ scale: next.scale, x: next.x + now.x - center.x, y: next.y + now.y - center.y }, pictureSize, stageSize), false);
    } else if (drag.current && drag.current.view.scale > 1 && first) {
      const [dx, dy] = [first.x - drag.current.from.x, first.y - drag.current.from.y];
      if (!moved.current && Math.hypot(dx, dy) < DRAG_PX) return;
      // Only now: captured from the start, a plain click would land on the stage instead of on the image and close it.
      if (!moved.current) e.currentTarget.setPointerCapture(e.pointerId);
      moved.current = true;
      const { pictureSize, stageSize } = measure();
      show(dragged({ scale: drag.current.view.scale, x: drag.current.view.x + dx, y: drag.current.view.y + dy }, pictureSize, stageSize), false);
    }
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const [left] = [...pointers.current.values()];
    if (left) {
      // One finger stays after a pinch: it pans from here, without the picture jumping to where it went down.
      pinch.current = null;
      drag.current = { from: left, view: viewNow.current };
      return;
    }
    const wasGesture = moved.current;
    pinch.current = null;
    drag.current = null;
    if (wasGesture) {
      const { pictureSize, stageSize } = measure();
      show(settle(viewNow.current, pictureSize, stageSize), true);
    } else if (e.pointerType === 'touch') {
      const now = Date.now();
      const tap = lastTap.current;
      if (now - tap.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < DOUBLE_TAP_PX) {
        tapZoomed.current = now;
        toggleZoom(fromCenter({ x: e.clientX, y: e.clientY }));
        lastTap.current = { at: 0, x: 0, y: 0 };
      } else lastTap.current = { at: now, x: e.clientX, y: e.clientY };
    }
  };
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== picture.current || Date.now() - tapZoomed.current < DOUBLE_TAP_MS * 2) return;
    toggleZoom(fromCenter({ x: e.clientX, y: e.clientY }));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const pan = ({ ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] } as Record<string, [number, number]>)[e.key];
    if (e.key === '+' || e.key === '=') zoomTo(viewNow.current.scale * ZOOM_STEP, { x: 0, y: 0 }, true);
    else if (e.key === '-' || e.key === '_') zoomTo(viewNow.current.scale / ZOOM_STEP, { x: 0, y: 0 }, true);
    else if (e.key === '0') show(FITTED, true);
    else if (pan && zoomed) {
      const { pictureSize, stageSize } = measure();
      show(settle({ ...viewNow.current, x: viewNow.current.x + pan[0], y: viewNow.current.y + pan[1] }, pictureSize, stageSize), true);
    } else if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'ArrowRight') go(at + 1);
    else return;
    e.preventDefault();
  };
  const close = () => onIndexChange(null);

  return (
    <BaseDialog.Popup
      aria-label="Image"
      finalFocus={finalFocus}
      onKeyDown={onKeyDown}
      // The popup and the stage in it cover the window around the image; a click there is a click on the backdrop.
      onClick={(e) => (e.target === e.currentTarget || (e.target === stage.current && !moved.current)) && close()}
      className="fixed inset-0 z-(--at-layout-z-modal) flex items-center justify-center outline-none transition-opacity duration-(--at-duration-base) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0"
    >
      <div
        ref={stage}
        role="presentation"
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className={cn(
          'absolute inset-0 flex touch-none items-center justify-center overflow-hidden transition-[padding] duration-(--at-duration-base) ease-out',
          details && detailsOpen && 'md:pr-[352px] md:pl-4',
          zoomed && 'cursor-grab active:cursor-grabbing',
        )}
      >
        {image && (
          <img
            key={image.src}
            ref={picture}
            src={image.src}
            alt={image.alt ?? ''}
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            className={cn('max-h-[90vh] max-w-[min(90vw,100%)] rounded-xl object-contain shadow-lg select-none', gliding && 'transition-transform duration-(--at-duration-base) ease-out', zoomed && 'will-change-transform')}
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
          className="absolute top-[72px] right-4 flex max-h-[calc(100dvh-88px)] w-80 flex-col overflow-y-auto rounded-2xl bg-popover p-4 text-body text-fg shadow-popover transition-[opacity,translate] duration-(--at-duration-base) ease-out starting:translate-x-2 starting:opacity-0 max-md:inset-x-4 max-md:top-auto max-md:bottom-4 max-md:max-h-[55dvh] max-md:w-auto max-md:starting:translate-x-0 max-md:starting:translate-y-2"
        >
          {details(at)}
        </aside>
      )}
      {several && (
        <>
          <span className={control('top-1/2 left-4 -translate-y-1/2')}>
            <IconButton icon={ChevronLeft} label="Previous image" iconSize="md" size="lg" disabled={at === 0} onClick={() => go(at - 1)} />
          </span>
          {/* Beside the details panel while it is open: the arrow would sit on top of it. */}
          <span className={cn(control('top-1/2 -translate-y-1/2'), details && detailsOpen ? 'right-[352px] max-md:right-4' : 'right-4')}>
            <IconButton icon={ChevronRight} label="Next image" iconSize="md" size="lg" disabled={at === images.length - 1} onClick={() => go(at + 1)} />
          </span>
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-popover px-3 py-1 text-footnote text-fg tabular-nums shadow-popover max-md:hidden">
            {at + 1} of {images.length}
          </span>
        </>
      )}
      {/* Fingers pinch on a phone, and the tile would sit under the thumb. */}
      <span className={cn(control('bottom-4 left-4'), 'flex items-center max-md:hidden')}>
        <IconButton icon={Minus} label="Zoom out" size="md" disabled={!zoomed} onClick={() => zoomTo(view.scale / ZOOM_STEP, { x: 0, y: 0 }, true)} />
        <button
          type="button"
          aria-label={zoomed ? 'Fit to window' : undefined}
          disabled={!zoomed}
          onClick={() => show(FITTED, true)}
          className="h-8 min-w-12 rounded-md px-1 text-footnote text-fg-secondary tabular-nums outline-none focus-ring enabled:hover:bg-fill-ghost-hover"
        >
          <span role="status">{zoomed ? `${percent}%` : 'Fit'}</span>
        </button>
        <IconButton icon={Plus} label="Zoom in" size="md" onClick={() => zoomTo(view.scale * ZOOM_STEP, { x: 0, y: 0 }, true)} />
      </span>
    </BaseDialog.Popup>
  );
}
