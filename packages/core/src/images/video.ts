/**
 * What a generated clip really is (ARCHITECTURE §23). A service decides what comes back, and a clip is shown by the
 * page's own player and offered for download, so the bytes must be a video container Atelier knows: MP4 or WebM,
 * recognised by their structure and not by what the service called them. The frame size, length, frame rate and sound
 * come from the file, so the transcript's frame has its shape before the video is loaded.
 */

export type VideoMime = 'video/mp4' | 'video/webm';

/** The most a clip may weigh, here and in `/api/blobs`. A video a service makes is far below this; a hostile one can't fill the disk. */
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export interface VideoFacts {
  mime: VideoMime;
  width: number;
  height: number;
  /** Absent when the file doesn't say. */
  seconds?: number;
  fps?: number;
  /** Whether the file has a sound track. */
  audio: boolean;
}

const ascii = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));

/** The container a file's first bytes show, or null. MP4 starts with an `ftyp` box, WebM with the EBML magic and the doctype `webm`. */
export function sniffVideo(bytes: Uint8Array): VideoMime | null {
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    // The brand matters: HEIC and AVIF images also start with `ftyp`.
    const brand = ascii(bytes, 8, 4);
    return /^(?:avif|avis|heic|heix|hevc|mif1|msf1|heim|heis|hevm|hevs)$/.test(brand) ? null : 'video/mp4';
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    // The doctype is near the start; Matroska files (`matroska`) aren't what browsers' players promise.
    const head = ascii(bytes, 0, Math.min(bytes.byteLength, 64));
    return head.includes('webm') ? 'video/webm' : null;
  }
  return null;
}

/** Throws what the person should read when the bytes aren't a clip Atelier can keep. */
export function checkVideo(bytes: Uint8Array): VideoMime {
  if (bytes.byteLength === 0) throw new Error('The video came back empty.');
  if (bytes.byteLength > MAX_VIDEO_BYTES) throw new Error(`The video is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
  const mime = sniffVideo(bytes);
  if (!mime) throw new Error("What came back isn't an MP4 or WebM video.");
  return mime;
}

// -------------------------------------------------------------------------------------------- MP4

interface Box {
  type: string;
  /** Where its content starts and ends. */
  start: number;
  end: number;
}

function* boxes(view: DataView, bytes: Uint8Array, from: number, to: number): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function mp4Facts(bytes: Uint8Array): VideoFacts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const facts: VideoFacts = { mime: 'video/mp4', width: 0, height: 0, audio: false };
  let movieScale = 0;
  let movieDuration = 0;
  for (const top of boxes(view, bytes, 0, bytes.byteLength)) {
    if (top.type !== 'moov') continue;
    for (const box of boxes(view, bytes, top.start, top.end)) {
      if (box.type === 'mvhd') {
        const version = view.getUint8(box.start);
        movieScale = view.getUint32(box.start + (version === 1 ? 20 : 12));
        movieDuration = version === 1 ? Number(view.getBigUint64(box.start + 24)) : view.getUint32(box.start + 16);
      } else if (box.type === 'trak') trackFacts(view, bytes, box, facts);
    }
  }
  if (movieScale > 0 && movieDuration > 0) facts.seconds = movieDuration / movieScale;
  return facts;
}

function trackFacts(view: DataView, bytes: Uint8Array, trak: Box, facts: VideoFacts): void {
  let width = 0;
  let height = 0;
  let handler = '';
  let scale = 0;
  let delta = 0;
  for (const box of boxes(view, bytes, trak.start, trak.end)) {
    if (box.type === 'tkhd') {
      const version = view.getUint8(box.start);
      const at = box.start + (version === 1 ? 88 : 76);
      // 16.16 fixed point.
      width = Math.round(view.getUint32(at) / 65536);
      height = Math.round(view.getUint32(at + 4) / 65536);
    } else if (box.type === 'mdia') {
      for (const inner of boxes(view, bytes, box.start, box.end)) {
        if (inner.type === 'hdlr') handler = ascii(bytes, inner.start + 8, 4);
        else if (inner.type === 'mdhd') scale = view.getUint32(inner.start + (view.getUint8(inner.start) === 1 ? 20 : 12));
        else if (inner.type === 'minf') {
          for (const media of boxes(view, bytes, inner.start, inner.end)) {
            if (media.type !== 'stbl') continue;
            for (const table of boxes(view, bytes, media.start, media.end)) {
              // The first run of the time-to-sample table: the length of one frame.
              if (table.type === 'stts' && view.getUint32(table.start + 4) > 0) delta = view.getUint32(table.start + 12);
            }
          }
        }
      }
    }
  }
  if (handler === 'soun') facts.audio = true;
  if (handler === 'vide' && facts.width === 0) {
    facts.width = width;
    facts.height = height;
    if (scale > 0 && delta > 0) facts.fps = Math.round((scale / delta) * 100) / 100;
  }
}

// ------------------------------------------------------------------------------------------- WebM

const ID = {
  segment: 0x18538067,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  video: 0xe0,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  trackType: 0x83,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  defaultDuration: 0x23e383,
} as const;
const MASTERS = new Set<number>([ID.segment, ID.info, ID.tracks, ID.trackEntry, ID.video]);

/** An EBML variable-length number; an element id keeps its length marker, a size drops it. */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > bytes.byteLength) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]!;
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function webmFacts(bytes: Uint8Array): VideoFacts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const facts: VideoFacts = { mime: 'video/webm', width: 0, height: 0, audio: false };
  let scale = 1_000_000;
  let duration = 0;
  let frameNs = 0;
  let track: { type?: number; width?: number; height?: number; frameNs?: number } = {};
  const uint = (at: number, length: number) => {
    let n = 0;
    for (let i = 0; i < length; i++) n = n * 256 + bytes[at + i]!;
    return n;
  };
  const endTrack = () => {
    if (track.type === 2) facts.audio = true;
    if (track.type === 1 && facts.width === 0) {
      facts.width = track.width ?? 0;
      facts.height = track.height ?? 0;
      frameNs = track.frameNs ?? 0;
    }
  };
  const walk = (from: number, to: number): void => {
    let at = from;
    while (at < to) {
      const id = vint(bytes, at, true);
      if (!id) return;
      const size = vint(bytes, at + id.length, false);
      if (!size) return;
      const start = at + id.length + size.length;
      const end = size.unknown ? to : Math.min(to, start + size.value);
      if (MASTERS.has(id.value)) {
        if (id.value === ID.trackEntry) track = {};
        walk(start, end);
        if (id.value === ID.trackEntry) endTrack();
      } else if (id.value === ID.timecodeScale) scale = uint(start, end - start) || scale;
      else if (id.value === ID.duration) duration = end - start === 8 ? view.getFloat64(start) : end - start === 4 ? view.getFloat32(start) : 0;
      else if (id.value === ID.trackType) track.type = uint(start, end - start);
      else if (id.value === ID.pixelWidth) track.width = uint(start, end - start);
      else if (id.value === ID.pixelHeight) track.height = uint(start, end - start);
      else if (id.value === ID.defaultDuration) track.frameNs = uint(start, end - start);
      at = end;
    }
  };
  walk(0, bytes.byteLength);
  if (duration > 0) facts.seconds = (duration * scale) / 1e9;
  if (frameNs > 0) facts.fps = Math.round((1e9 / frameNs) * 100) / 100;
  return facts;
}

/**
 * The frame size, length, frame rate and sound of a clip. A container that is damaged past reading gives a zero size
 * rather than an error: the clip may still play, and `checkVideo` is what decides whether it is kept.
 */
export function videoFacts(bytes: Uint8Array): VideoFacts {
  const mime = sniffVideo(bytes);
  if (!mime) throw new Error("That isn't an MP4 or WebM video.");
  try {
    return mime === 'video/mp4' ? mp4Facts(bytes) : webmFacts(bytes);
  } catch {
    return { mime, width: 0, height: 0, audio: false };
  }
}
