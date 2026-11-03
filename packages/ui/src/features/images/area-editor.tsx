/**
 * "Change an area": the person brushes over part of an image, says what it should become, and gets a mask the size of
 * the picture. The mask is a PNG made here on a canvas (white = change, black = stays); sending it is the owner's job
 * (`ChangeAreaProvider`). Mouse, pen and touch paint through pointer events; the keyboard has its own brush that
 * moves with the arrow keys, so nothing here needs a pointer.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Eraser, Paintbrush, Trash2, Undo2, X } from 'lucide-react';
import { Button, IconButton, SegmentedControl, TextField, cn, toast } from '../../components/ui/index.ts';
import { dialogBackdropClass } from '../../components/ui/styles.ts';
import { describeError } from '../../lib/rpc.ts';
import { BRUSH_DEFAULT, BRUSH_MAX, BRUSH_MIN, KEY_STEP_SHARE, UNDO_DEPTH, binarise, brushDiameter, drawStroke, maskSize, moveCursor, toCanvas, type Point, type Stroke } from './area-mask.ts';

/** What the marked area looks like over the picture. */
const TINT = 'rgba(244, 63, 94, 0.55)';

const TOOLS = [
  { value: 'paint', label: 'Brush', icon: Paintbrush },
  { value: 'erase', label: 'Eraser', icon: Eraser },
] as const;
type Tool = (typeof TOOLS)[number]['value'];

export interface AreaEditorProps {
  open: boolean;
  /** The picture, from the app's own blob address. */
  src: string;
  alt: string;
  onClose(): void;
  /** Sends the instruction and the mask. Throwing keeps the editor open with what the person did. */
  onSubmit(instruction: string, mask: Blob): Promise<void>;
}

export function AreaEditor({ open, onClose, ...rest }: AreaEditorProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={dialogBackdropClass} />
        <AreaEditorBody onClose={onClose} {...rest} />
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function AreaEditorBody({ src, alt, onClose, onSubmit }: Omit<AreaEditorProps, 'open'>) {
  const hint = useId();
  const picture = useRef<HTMLImageElement>(null);
  const view = useRef<HTMLCanvasElement>(null);
  const ring = useRef<HTMLSpanElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  // The mask itself, off screen: older strokes baked into `base`, the rest replayed over it, so undo is exact.
  const base = useRef<HTMLCanvasElement | null>(null);
  const paint = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<Stroke[]>([]);
  const live = useRef<Stroke | null>(null);
  const frame = useRef(0);
  const cursor = useRef<Point | null>(null);
  const keyStroke = useRef<Stroke | null>(null);

  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const [tool, setTool] = useState<Tool>('paint');
  const [size, setSize] = useState(BRUSH_DEFAULT);
  // Counts of what undo and clear act on, which live in refs for the sake of fast drawing.
  const [strokeCount, setStrokeCount] = useState(0);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);

  const diameter = () => (natural ? brushDiameter(size, natural.width, natural.height) : 0);

  /** The tinted copy of the mask over the picture. */
  const draw = useCallback(() => {
    frame.current = 0;
    const target = view.current;
    const mask = paint.current;
    const ctx = target?.getContext('2d');
    if (!target || !mask || !ctx) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = TINT;
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.globalCompositeOperation = 'source-over';
  }, []);
  /** Once a frame at most: a drag on a large picture would otherwise repaint it per pointer event. */
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /** The mask is made when the picture has loaded, at the picture's real pixel size. */
  const onLoad = () => {
    const img = picture.current;
    if (!img?.naturalWidth) return;
    const { width, height } = maskSize(img.naturalWidth, img.naturalHeight);
    setNatural({ width, height });
    base.current = canvasOf(width, height);
    paint.current = canvasOf(width, height);
    cursor.current = { x: width / 2, y: height / 2 };
  };
  useLayoutEffect(() => {
    // Already loaded from the cache before React was listening.
    if (picture.current?.complete && picture.current.naturalWidth && !natural) onLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Every stroke over the baked ones, from scratch. */
  const replay = () => {
    const mask = paint.current;
    const ctx = mask?.getContext('2d');
    if (!mask || !ctx || !base.current) return;
    ctx.clearRect(0, 0, mask.width, mask.height);
    ctx.drawImage(base.current, 0, 0);
    for (const stroke of strokes.current) drawStroke(ctx, stroke);
    schedule();
  };

  const commit = (stroke: Stroke) => {
    strokes.current.push(stroke);
    // The oldest stroke becomes part of the picture of the mask: undo reaches back this far and no further.
    while (strokes.current.length > UNDO_DEPTH) {
      const oldest = strokes.current.shift()!;
      const ctx = base.current?.getContext('2d');
      if (ctx) drawStroke(ctx, oldest);
    }
    setStrokeCount(strokes.current.length);
  };

  /** Adds `to` to the stroke being drawn, painting just that piece. */
  const extend = (stroke: Stroke, to: Point) => {
    const ctx = paint.current?.getContext('2d');
    const from = stroke.points.at(-1);
    stroke.points.push(to);
    if (ctx && from) drawStroke(ctx, { ...stroke, points: [from, to] });
    schedule();
  };
  const begin = (at: Point): Stroke => {
    const stroke: Stroke = { erase: tool === 'erase', diameter: diameter(), points: [at] };
    const ctx = paint.current?.getContext('2d');
    if (ctx) drawStroke(ctx, stroke);
    schedule();
    return stroke;
  };

  const place = (e: PointerEvent): Point => {
    const target = view.current!;
    return toCanvas({ x: e.clientX, y: e.clientY }, target.getBoundingClientRect(), target);
  };
  /** The brush ring follows the pointer or the keyboard brush, at the size the brush will paint. */
  const moveRing = (at: Point | null) => {
    const el = ring.current;
    const target = view.current;
    if (!el) return;
    if (!at || !target || !natural) {
      el.style.opacity = '0';
      return;
    }
    const box = target.getBoundingClientRect();
    const scale = box.width / natural.width;
    const d = diameter() * scale;
    el.style.opacity = '1';
    el.style.width = el.style.height = `${d}px`;
    el.style.transform = `translate(${at.x * scale - d / 2}px, ${at.y * scale - d / 2}px)`;
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !natural) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const at = place(e);
    live.current = begin(at);
    cursor.current = at;
    moveRing(at);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const at = place(e);
    moveRing(e.pointerType === 'touch' ? null : at);
    if (!live.current || !e.isPrimary) return;
    extend(live.current, at);
    cursor.current = at;
  };
  const onPointerEnd = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!live.current || !e.isPrimary) return;
    commit(live.current);
    live.current = null;
    if (e.pointerType === 'touch') moveRing(null);
  };

  const undo = () => {
    if (strokes.current.length === 0) return;
    strokes.current.pop();
    setStrokeCount(strokes.current.length);
    replay();
  };
  const clear = () => {
    strokes.current = [];
    base.current?.getContext('2d')?.clearRect(0, 0, base.current.width, base.current.height);
    setStrokeCount(0);
    replay();
  };

  const announce = (text: string) => {
    if (status.current) status.current.textContent = text;
  };
  const describeAt = (at: Point) => `Brush ${Math.round((at.x / natural!.width) * 100)} percent across, ${Math.round((at.y / natural!.height) * 100)} percent down.`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!natural || e.target !== e.currentTarget) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const at = cursor.current ?? { x: natural.width / 2, y: natural.height / 2 };
    const step = Math.max(1, diameter() * KEY_STEP_SHARE);
    const next = moveCursor(at, e.key, step, natural);
    if (next) {
      e.preventDefault();
      // Shift paints while moving, as one stroke until Shift is let go.
      if (e.shiftKey) {
        if (!keyStroke.current) keyStroke.current = begin(at);
        extend(keyStroke.current, next);
      }
      cursor.current = next;
      moveRing(next);
      announce(describeAt(next));
    } else if (e.key === ' ' || e.key === 'Enter') {
      // A dab where the brush is.
      e.preventDefault();
      const dab = begin(at);
      commit(dab);
      moveRing(at);
      announce(`${tool === 'erase' ? 'Erased' : 'Painted'}. ${describeAt(at)}`);
    } else if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      setSize((s) => Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, s + (e.key === ']' ? 4 : -4))));
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Shift' || !keyStroke.current) return;
    commit(keyStroke.current);
    keyStroke.current = null;
  };
  // The ring is the brush's size: it follows the slider while the keyboard brush is out.
  useEffect(() => {
    if (cursor.current && ring.current?.style.opacity === '1') moveRing(cursor.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const submit = async () => {
    const mask = paint.current;
    const text = instruction.trim();
    if (!mask || !text || busy) return;
    const out = canvasOf(mask.width, mask.height);
    const ctx = out.getContext('2d');
    if (!ctx) return;
    // White on black, then every pixel made fully one or the other.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(mask, 0, 0);
    const pixels = ctx.getImageData(0, 0, out.width, out.height);
    const share = binarise(pixels.data);
    if (share === 0) {
      toast.error('Paint over the part you want changed first.');
      return;
    }
    ctx.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
    if (!blob) {
      toast.error('The marked area could not be made into an image.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(text, blob);
      onClose();
    } catch (error) {
      toast.error(describeError(error).message);
      setBusy(false);
    }
  };

  const ready = !!natural && strokeCount > 0 && instruction.trim().length > 0;

  return (
    <BaseDialog.Popup
      aria-label="Change an area"
      className="fixed inset-0 z-(--at-layout-z-modal) flex flex-col gap-3 p-3 outline-none transition-opacity duration-(--at-duration-base) ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 md:p-4"
    >
      <div className="flex shrink-0 items-center gap-3 rounded-xl bg-popover px-3 py-1.5 shadow-popover">
        <BaseDialog.Title className="text-control text-fg">Change an area</BaseDialog.Title>
        <p id={hint} className="min-w-0 flex-1 truncate text-footnote text-fg-muted max-md:hidden">
          Paint over the part you want changed, then say what it should become. With the keyboard: arrow keys move the brush, Space paints, Shift with an arrow paints while it moves.
        </p>
        <BaseDialog.Close render={<IconButton icon={X} label="Close" iconSize="md" size="lg" className="ml-auto" />} />
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        {broken ? (
          <p role="alert" className="rounded-xl bg-popover px-4 py-3 text-body text-fg shadow-popover">
            This image is no longer available.
          </p>
        ) : (
          // A drawing surface has no native element. It takes focus on purpose: with it, the arrow keys move a brush.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <div
            role="application"
            aria-roledescription="painting canvas"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label="The image. Paint the part to change."
            aria-describedby={hint}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onBlur={() => moveRing(null)}
            className="relative inline-block max-h-full max-w-full rounded-xl shadow-lg outline-none focus-visible:shadow-[var(--at-shadow-focus)]"
          >
            <img
              ref={picture}
              src={src}
              alt={alt}
              draggable={false}
              onLoad={onLoad}
              onError={() => setBroken(true)}
              className="block max-h-[calc(100dvh-210px)] max-w-full rounded-xl object-contain select-none max-md:max-h-[calc(100dvh-290px)]"
            />
            {natural && (
              <canvas
                ref={view}
                width={natural.width}
                height={natural.height}
                aria-hidden="true"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onPointerLeave={(e) => !live.current && e.pointerType !== 'touch' && moveRing(null)}
                className="absolute inset-0 size-full cursor-none touch-none rounded-xl"
              />
            )}
            <span ref={ring} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 rounded-full opacity-0 inset-ring-2 inset-ring-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
          </div>
        )}
        <span ref={status} role="status" className="sr-only" />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-popover p-2 shadow-popover">
        <SegmentedControl aria-label="Tool" size="sm" items={TOOLS} value={tool} onValueChange={setTool} />
        <label className="flex items-center gap-2 text-footnote text-fg-secondary">
          Brush size
          <input
            type="range"
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            aria-valuetext={`${size} of ${BRUSH_MAX}`}
            className="h-6 w-28 accent-interactive"
          />
        </label>
        <div className="flex items-center">
          <IconButton icon={Undo2} label="Undo" size="md" disabled={strokeCount === 0} onClick={undo} />
          <IconButton icon={Trash2} label="Clear" size="md" disabled={strokeCount === 0} onClick={clear} />
        </div>
        <form
          className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextField
            aria-label="What the marked area should become"
            placeholder="What should it become? For example: a red door"
            value={instruction}
            maxLength={2000}
            onChange={(e) => setInstruction(e.target.value)}
            className={cn('flex-1')}
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
            Generate
          </Button>
        </form>
      </div>
    </BaseDialog.Popup>
  );
}
