/**
 * The fullscreen view's mouse: the wheel scrolls, a click opens a step or a thought. With mouse reports on (MOUSE_ON),
 * the terminal sends each turn of the wheel and each click as an escape sequence; this stands between the terminal and
 * Ink, takes those out and passes everything else through. It reads only while Ink has raw mode on, so a program Ink
 * hands the terminal to (Ctrl+G's editor) gets its keys.
 */
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Lines to scroll: negative up, positive down. */
export type WheelListener = (lines: number) => void;
/** Where the left button went down: the column and row from the top left, both from 0. */
export type ClickListener = (at: { x: number; y: number }) => void;
export interface Mouse {
  onWheel(listener: WheelListener): () => void;
  onClick(listener: ClickListener): () => void;
}

// eslint-disable-next-line no-control-regex -- terminal reports are control characters.
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// eslint-disable-next-line no-control-regex -- a report cut off at the end of what was read.
const CUT = /\x1b\[<[\d;]*$/;
const STEP = 3;

/** Takes the mouse reports out of `text`; what is left, and a cut-off report to keep for the next read. */
export function takeMouse(text: string, emit: { wheel: WheelListener; click: ClickListener }): { rest: string; held: string } {
  const cut = CUT.exec(text);
  const whole = cut ? text.slice(0, cut.index) : text;
  const rest = whole.replace(REPORT, (_m, button: string, x: string, y: string, end: string) => {
    // The low bits say which button, 4, 8 and 16 Shift, Alt and Ctrl, 32 a drag, 64 the wheel.
    const b = Number(button) & 0b11100011;
    if (b === 64) emit.wheel(-STEP);
    else if (b === 65) emit.wheel(STEP);
    // The left button going down (not coming up, not a drag).
    else if (b === 0 && end === 'M') emit.click({ x: Number(x) - 1, y: Number(y) - 1 });
    return '';
  });
  return { rest, held: cut ? cut[0] : '' };
}

export function mouseInput(source: NodeJS.ReadStream): { stdin: NodeJS.ReadStream; mouse: Mouse; close(): void } {
  const wheels = new Set<WheelListener>();
  const clicks = new Set<ClickListener>();
  const decoder = new StringDecoder('utf8');
  const out = new PassThrough();
  let held = '';
  const onData = (chunk: Buffer | string) => {
    const taken = takeMouse(held + (typeof chunk === 'string' ? chunk : decoder.write(chunk)), {
      wheel: (n) => wheels.forEach((fn) => fn(n)),
      click: (at) => clicks.forEach((fn) => fn(at)),
    });
    held = taken.held;
    if (taken.rest) out.write(taken.rest);
  };
  source.on('data', onData);
  source.pause();
  Object.assign(out, {
    isTTY: true,
    setRawMode(mode: boolean) {
      source.setRawMode(mode);
      if (mode) source.resume();
      else source.pause();
      return out;
    },
    ref() {
      source.ref();
      return out;
    },
    unref() {
      source.unref();
      return out;
    },
  });
  return {
    stdin: out as unknown as NodeJS.ReadStream,
    mouse: {
      onWheel: (fn) => (wheels.add(fn), () => void wheels.delete(fn)),
      onClick: (fn) => (clicks.add(fn), () => void clicks.delete(fn)),
    },
    close: () => {
      source.off('data', onData);
      source.pause();
      out.end();
    },
  };
}
