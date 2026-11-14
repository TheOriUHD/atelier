/**
 * A picture attached to a report, as the app sends it (base64, already scaled and compressed in the window): decoded,
 * and checked to be the picture it says it is and no larger than the collector takes.
 */
import { REPORT_LIMITS } from '@atelier/protocol';

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP',
};

export interface CheckedScreenshot {
  name: string;
  mime: 'image/webp' | 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** The picture, or why it can't go. */
export function reportScreenshot(name: string, shot: { mime: CheckedScreenshot['mime']; dataBase64: string; width: number; height: number }): CheckedScreenshot | string {
  const bytes = new Uint8Array(Buffer.from(shot.dataBase64, 'base64'));
  if (!bytes.byteLength) return 'A screenshot is empty. Take it out and add it again.';
  if (bytes.byteLength > REPORT_LIMITS.screenshotBytes) return 'A screenshot is too large, even compressed. Take it out, or crop it.';
  if (!MAGIC[shot.mime]?.(bytes)) return 'A screenshot is not the picture it says it is. Take it out and add it again.';
  if (Math.max(shot.width, shot.height) > REPORT_LIMITS.screenshotSide * 2) return 'A screenshot is too large. Take it out and add it again.';
  return { name, mime: shot.mime, width: shot.width, height: shot.height, bytes };
}
