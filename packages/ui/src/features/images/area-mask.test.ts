import { describe, expect, it } from 'vitest';
import { BRUSH_MAX, MAX_MASK_SIDE, binarise, brushDiameter, drawStroke, maskSize, moveCursor, tintFromMask, toCanvas, type Pen } from './area-mask.ts';

function recordingPen() {
  const calls: unknown[][] = [];
  const pen = {
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a: number[]) => calls.push(['moveTo', ...a]),
    lineTo: (...a: number[]) => calls.push(['lineTo', ...a]),
    arc: (...a: number[]) => calls.push(['arc', ...a]),
    fill: () => calls.push(['fill']),
    stroke: () => calls.push(['stroke']),
  };
  return { pen: pen as unknown as Pen & typeof pen, calls };
}

describe('the mask canvas', () => {
  it('is the picture\'s real size, and smaller only for a picture too large to hold two of', () => {
    expect(maskSize(1024, 768)).toEqual({ width: 1024, height: 768 });
    expect(maskSize(8192, 4096)).toEqual({ width: MAX_MASK_SIDE, height: MAX_MASK_SIDE / 2 });
  });

  it('turns a screen position into a position on the canvas, however the picture is shown', () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    expect(toCanvas({ x: 300, y: 150 }, box, { width: 2000, height: 1000 })).toEqual({ x: 1000, y: 500 });
    expect(toCanvas({ x: 0, y: 0 }, box, { width: 2000, height: 1000 })).toEqual({ x: 0, y: 0 });
    expect(toCanvas({ x: 9999, y: 9999 }, box, { width: 2000, height: 1000 })).toEqual({ x: 2000, y: 1000 });
    expect(toCanvas({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 }, { width: 10, height: 10 })).toEqual({ x: 0, y: 0 });
  });
});

describe('the brush', () => {
  it('covers the same share of any picture at the same setting, never less than a few pixels', () => {
    expect(brushDiameter(50, 1000, 2000)).toBe(brushDiameter(50, 2000, 1000));
    expect(brushDiameter(BRUSH_MAX, 1000, 1000)).toBe(400);
    expect(brushDiameter(1, 100, 100)).toBe(4);
    expect(brushDiameter(500, 1000, 1000)).toBe(400);
  });

  it('paints a tap as a round dab and a drag as one rounded line', () => {
    const dab = recordingPen();
    drawStroke(dab.pen, { erase: false, diameter: 20, points: [{ x: 5, y: 6 }] });
    expect(dab.calls).toEqual([['save'], ['beginPath'], ['arc', 5, 6, 10, 0, Math.PI * 2], ['fill'], ['restore']]);
    const line = recordingPen();
    drawStroke(line.pen, { erase: false, diameter: 20, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] });
    expect(line.calls).toEqual([['save'], ['beginPath'], ['moveTo', 1, 2], ['lineTo', 3, 4], ['lineTo', 5, 6], ['stroke'], ['restore']]);
    expect(line.pen).toMatchObject({ lineWidth: 20, lineCap: 'round', lineJoin: 'round', globalCompositeOperation: 'source-over' });
  });

  it('erases by taking the paint away, not by painting black', () => {
    const { pen } = recordingPen();
    drawStroke(pen, { erase: true, diameter: 8, points: [{ x: 0, y: 0 }, { x: 4, y: 4 }] });
    expect(pen.globalCompositeOperation).toBe('destination-out');
  });

  it('draws nothing for a stroke with no points', () => {
    const { pen, calls } = recordingPen();
    drawStroke(pen, { erase: false, diameter: 8, points: [] });
    expect(calls).toEqual([]);
  });
});

describe('the keyboard brush', () => {
  const bounds = { width: 100, height: 50 };

  it('moves a step with the arrow keys and stays on the picture', () => {
    expect(moveCursor({ x: 50, y: 25 }, 'ArrowRight', 10, bounds)).toEqual({ x: 60, y: 25 });
    expect(moveCursor({ x: 50, y: 25 }, 'ArrowUp', 10, bounds)).toEqual({ x: 50, y: 15 });
    expect(moveCursor({ x: 2, y: 25 }, 'ArrowLeft', 10, bounds)).toEqual({ x: 0, y: 25 });
    expect(moveCursor({ x: 50, y: 48 }, 'ArrowDown', 10, bounds)).toEqual({ x: 50, y: 50 });
  });

  it('leaves every other key alone', () => {
    expect(moveCursor({ x: 1, y: 1 }, 'a', 10, bounds)).toBeNull();
  });
});

describe('making the mask the backend takes', () => {
  it('makes every pixel pure white or pure black and opaque, whatever the brush left at its edge', () => {
    // White over black at full, 70%, 30% and no strength, as the edge of a round brush leaves it.
    const over = (alpha: number) => [255 * (alpha / 255), 255 * (alpha / 255), 255 * (alpha / 255), 255];
    const data = new Uint8ClampedArray([...over(255), ...over(178), ...over(76), ...over(0)]);
    const share = binarise(data);
    expect([...data]).toEqual([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    expect(share).toBe(0.5);
  });

  it('reads paint that is white with some alpha over nothing the same way', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 60, 0, 0, 0, 0]);
    expect(binarise(data)).toBeCloseTo(1 / 3);
    expect([...data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...data.slice(4, 8)]).toEqual([0, 0, 0, 255]);
  });

  it('says nothing is painted when nothing is', () => {
    expect(binarise(new Uint8ClampedArray(16))).toBe(0);
    expect(binarise(new Uint8ClampedArray(0))).toBe(0);
  });

  it('shows a mask as a tint whose strength follows the brightness', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    tintFromMask(data, [10, 20, 30], 0.5);
    expect([...data]).toEqual([10, 20, 30, 128, 10, 20, 30, 0]);
  });
});
