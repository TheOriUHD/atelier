import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider, toast } from '../../components/ui/index.ts';
import { AreaEditor } from './area-editor.tsx';

vi.mock('../../components/ui/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ui/index.ts')>();
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } };
});

/** A canvas that keeps score instead of drawing, and hands back pixels a test chooses. */
function fakeContext() {
  const painted: { op: string; width: number; at: number[] }[] = [];
  const ctx: Record<string, unknown> = {
    globalCompositeOperation: 'source-over',
    lineWidth: 0,
    fillStyle: '',
    strokeStyle: '',
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: (x: number, y: number) => painted.push({ op: String(ctx.globalCompositeOperation), width: Number(ctx.lineWidth), at: [x, y] }),
    fill: () => undefined,
    stroke: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    drawImage: () => undefined,
    putImageData: () => undefined,
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) })),
  };
  return { ctx, painted };
}

const SIZE = { width: 400, height: 200 };
let score: ReturnType<typeof fakeContext>;

beforeEach(() => {
  score = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => score.ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback: BlobCallback) {
    callback(new Blob(['png'], { type: 'image/png' }));
  });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => SIZE.width });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => SIZE.height });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function open(onSubmit = vi.fn(async () => {}), onClose = vi.fn()) {
  render(
    <TooltipProvider>
      <AreaEditor open src="/blob/x" alt="A kite" onClose={onClose} onSubmit={onSubmit} />
    </TooltipProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Change an area' });
  const picture = dialog.querySelector('img')!;
  fireEvent.load(picture);
  const canvas = await waitFor(() => {
    const found = dialog.querySelector('canvas');
    if (!found) throw new Error('no canvas yet');
    return found;
  });
  return { dialog, canvas, onSubmit, onClose };
}

const press = (canvas: HTMLCanvasElement, x: number, y: number, extra: Record<string, unknown> = {}) => fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, pointerType: 'mouse', ...extra });
const drag = (canvas: HTMLCanvasElement, x: number, y: number, extra: Record<string, unknown> = {}) => fireEvent.pointerMove(canvas, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...extra });
const release = (canvas: HTMLCanvasElement, extra: Record<string, unknown> = {}) => fireEvent.pointerUp(canvas, { pointerId: 1, isPrimary: true, pointerType: 'mouse', ...extra });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const field = () => screen.getByRole('textbox', { name: 'What the marked area should become' });

describe('AreaEditor', () => {
  it('makes the mask at the picture\'s real size, not the size it is shown at', async () => {
    const { canvas } = await open();
    expect([canvas.width, canvas.height]).toEqual([SIZE.width, SIZE.height]);
  });

  it('paints where the pointer goes, in the picture\'s own pixels', async () => {
    const { canvas } = await open();
    press(canvas, 100, 50);
    drag(canvas, 120, 60);
    release(canvas);
    // The picture is shown at half its size, so a click at (100, 50) is at (200, 100) in its pixels.
    expect(score.painted[0]).toMatchObject({ op: 'source-over', at: [200, 100] });
  });

  it('keeps the brush the person chose: bigger on a bigger setting, and a tap of the eraser takes paint away', async () => {
    const { canvas } = await open();
    press(canvas, 10, 10);
    release(canvas);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '60' } });
    press(canvas, 10, 10);
    release(canvas);
    // 12 of 100 and 60 of 100 on a picture 200 pixels high, where the brush tops out at 40% of that.
    expect(score.painted.map((p) => Math.round(p.width * 10) / 10)).toEqual([9.6, 48]);
    fireEvent.click(screen.getByRole('radio', { name: 'Eraser' }));
    press(canvas, 20, 20);
    release(canvas);
    expect(score.painted.at(-1)).toMatchObject({ op: 'destination-out' });
  });

  it('paints with a finger, and a second finger doesn\'t start another stroke', async () => {
    const { canvas } = await open();
    press(canvas, 40, 40, { pointerType: 'touch' });
    press(canvas, 80, 40, { pointerType: 'touch', pointerId: 2, isPrimary: false });
    release(canvas, { pointerType: 'touch' });
    expect(score.painted).toHaveLength(1);
    expect(button('Undo').disabled).toBe(false);
  });

  it('offers undo and clear only once there is something to take back, and they do', async () => {
    const { canvas } = await open();
    expect(button('Undo').disabled).toBe(true);
    expect(button('Clear').disabled).toBe(true);
    press(canvas, 10, 10);
    release(canvas);
    press(canvas, 30, 30);
    release(canvas);
    expect(button('Undo').disabled).toBe(false);
    fireEvent.click(button('Undo'));
    expect(button('Undo').disabled).toBe(false);
    fireEvent.click(button('Undo'));
    expect(button('Undo').disabled).toBe(true);
    press(canvas, 30, 30);
    release(canvas);
    fireEvent.click(button('Clear'));
    expect(button('Clear').disabled).toBe(true);
  });

  it('can be used without a pointer: arrow keys move the brush, Space paints, Shift paints while it moves, and Ctrl+Z undoes', async () => {
    const { dialog } = await open();
    const surface = dialog.querySelector<HTMLElement>('[role="application"]')!;
    surface.focus();
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    fireEvent.keyDown(surface, { key: ' ' });
    expect(button('Undo').disabled).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Painted');
    // The brush started in the middle and moved right before painting.
    expect(score.painted[0]!.at[0]).toBeGreaterThan(SIZE.width / 2);
    fireEvent.keyDown(surface, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(surface, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyUp(surface, { key: 'Shift' });
    fireEvent.keyDown(surface, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(surface, { key: 'z', ctrlKey: true });
    expect(button('Undo').disabled).toBe(true);
  });

  it('keeps Generate off until something is painted and said', async () => {
    const { canvas } = await open();
    expect(button('Generate').disabled).toBe(true);
    fireEvent.change(field(), { target: { value: 'a red door' } });
    expect(button('Generate').disabled).toBe(true);
    press(canvas, 10, 10);
    release(canvas);
    expect(button('Generate').disabled).toBe(false);
    fireEvent.change(field(), { target: { value: '   ' } });
    expect(button('Generate').disabled).toBe(true);
  });

  it('sends what they said and a black and white PNG of the whole picture', async () => {
    const { canvas, onSubmit, onClose } = await open();
    press(canvas, 10, 10);
    release(canvas);
    fireEvent.change(field(), { target: { value: '  a red door ' } });
    fireEvent.click(button('Generate'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [instruction, mask] = onSubmit.mock.calls[0] as unknown as [string, Blob];
    expect(instruction).toBe('a red door');
    expect(mask.type).toBe('image/png');
    expect(score.ctx.getImageData).toHaveBeenCalledWith(0, 0, SIZE.width, SIZE.height);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says so, and sends nothing, when what they painted was erased again', async () => {
    const { canvas, onSubmit } = await open();
    (score.ctx.getImageData as ReturnType<typeof vi.fn>).mockImplementation((_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));
    press(canvas, 10, 10);
    release(canvas);
    fireEvent.change(field(), { target: { value: 'a red door' } });
    fireEvent.click(button('Generate'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Paint over the part you want changed first.'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('stays open with their work when the send fails, and says why', async () => {
    const { canvas, onClose } = await open(vi.fn(async () => { throw new Error("There's no image img_00000000 in this conversation."); }));
    press(canvas, 10, 10);
    release(canvas);
    fireEvent.change(field(), { target: { value: 'a red door' } });
    fireEvent.click(button('Generate'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("There's no image")));
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Generate').disabled).toBe(false);
    expect((field() as HTMLInputElement).value).toBe('a red door');
  });

  it('says when the image is gone', async () => {
    render(
      <TooltipProvider>
        <AreaEditor open src="/blob/x" alt="A kite" onClose={() => {}} onSubmit={async () => {}} />
      </TooltipProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Change an area' });
    act(() => void fireEvent.error(dialog.querySelector('img')!));
    expect(screen.getByRole('alert').textContent).toContain('no longer available');
  });
});
