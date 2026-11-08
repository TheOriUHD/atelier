/**
 * The fullscreen view's mouse wheel. With wheel reports on (MOUSE_ON), the terminal sends each turn of the wheel as an
 * escape sequence; this stands between the terminal and Ink, takes those out and passes everything else through. It
 * reads only while Ink has raw mode on, so a program Ink hands the terminal to (Ctrl+G's editor) gets its keys.
 */
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Lines to scroll: negative up, positive down. */
export type WheelListener = (lines: number) => void;
export interface Wheel {
  on(listener: WheelListener): () => void;
}

// eslint-disable-next-line no-control-regex -- terminal reports are control characters.
const REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// eslint-disable-next-line no-control-regex -- a report cut off at the end of what was read.
const CUT = /\x1b\[<[\d;]*$/;
const STEP = 3;

/** Takes the wheel reports out of `text`; what is left, and a cut-off report to keep for the next read. */
export function takeWheel(text: string, emit: WheelListener): { rest: string; held: string } {
  const cut = CUT.exec(text);
  const whole = cut ? text.slice(0, cut.index) : text;
  const rest = whole.replace(REPORT, (_m, button: string) => {
    const b = Number(button);
    // 64 and 65: the wheel up and down (with Shift, Alt or Ctrl held: 68–81, the same two directions).
    if ((b & 0b11100011) === 64) emit(-STEP);
    else if ((b & 0b11100011) === 65) emit(STEP);
    return '';
  });
  return { rest, held: cut ? cut[0] : '' };
}

export function mouseInput(source: NodeJS.ReadStream): { stdin: NodeJS.ReadStream; wheel: Wheel; close(): void } {
  const listeners = new Set<WheelListener>();
  const decoder = new StringDecoder('utf8');
  const out = new PassThrough();
  let held = '';
  const onData = (chunk: Buffer | string) => {
    const taken = takeWheel(held + (typeof chunk === 'string' ? chunk : decoder.write(chunk)), (n) => listeners.forEach((fn) => fn(n)));
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
    wheel: { on: (fn) => (listeners.add(fn), () => void listeners.delete(fn)) },
    close: () => {
      source.off('data', onData);
      source.pause();
      out.end();
    },
  };
}
