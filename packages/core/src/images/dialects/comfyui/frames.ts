/**
 * ComfyUI's binary socket frames. Every frame starts with a big-endian type. Type 1 is a preview: a format (1 JPEG,
 * 2 PNG), then the image. Type 4 is a preview with metadata: its length, the JSON, then the image.
 */
import { sniffMime } from '../../../providers/images.ts';
import { rec, str, toBase64 } from '../../../providers/util.ts';

const PREVIEW = 1;
const PREVIEW_WITH_METADATA = 4;
const FORMATS: Record<number, string> = { 1: 'image/jpeg', 2: 'image/png' };
const HEADER = 8;

export interface PreviewFrame {
  mime: string;
  data: string;
  /** Only type 4 says which job it belongs to. */
  promptId?: string;
}

/** The preview in a frame, or null for the other kinds of frame and for anything cut short. */
export function decodeFrame(frame: Uint8Array): PreviewFrame | null {
  if (frame.byteLength <= HEADER) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const type = view.getUint32(0);
  if (type === PREVIEW) {
    const mime = FORMATS[view.getUint32(4)];
    return mime ? { mime, data: toBase64(frame.subarray(HEADER)) } : null;
  }
  if (type !== PREVIEW_WITH_METADATA) return null;
  const start = HEADER + view.getUint32(4);
  if (start >= frame.byteLength) return null;
  const image = frame.subarray(start);
  const mime = sniffMime(image);
  if (!mime) return null;
  const promptId = metadataPrompt(frame.subarray(HEADER, start));
  return { mime, data: toBase64(image), ...(promptId ? { promptId } : {}) };
}

function metadataPrompt(bytes: Uint8Array): string | undefined {
  try {
    return str(rec(JSON.parse(new TextDecoder().decode(bytes))).prompt_id);
  } catch {
    return undefined;
  }
}
