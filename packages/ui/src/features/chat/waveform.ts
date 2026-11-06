/**
 * A sound's waveform for its card (design/components.md › GeneratedAudio): the loudest moment of each slice, read once
 * by the browser's own decoder and kept for the session, so a long conversation decodes each sound a single time.
 * Where the page can't decode (no Web Audio, a format the browser doesn't play), the card falls back to a flat line.
 */

/** Slices read from a sound; a card shows fewer, each the loudest of the ones it covers. */
export const PEAK_COUNT = 480;

const cache = new Map<string, Promise<number[] | null>>();

type Decoder = { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> };

function decoder(): Decoder | null {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  // An offline context decodes without asking to play anything, so no browser holds it back until a click.
  return Offline ? new Offline(1, 1, 44_100) : null;
}

/** The loudest sample of each of `count` slices, across channels, 0 to 1. */
export function peaksFrom(channels: readonly Float32Array[], count = PEAK_COUNT): number[] {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return [];
  const peaks = new Array<number>(count).fill(0);
  const per = length / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    let peak = 0;
    for (const data of channels) {
      // Every sample of a short slice, an even spread of a long one: the shape is the same, and an hour-long file stays quick.
      const step = Math.max(1, Math.floor((end - start) / 256));
      for (let at = start; at < end && at < length; at += step) {
        const v = Math.abs(data[at]!);
        if (v > peak) peak = v;
      }
    }
    peaks[i] = peak;
  }
  return normalise(peaks);
}

/** Scaled so the loudest is 1, with a curve that lifts quiet passages enough to see. */
function normalise(peaks: number[]): number[] {
  const top = Math.max(...peaks, 1e-6);
  return peaks.map((p) => Math.min(1, Math.pow(p / top, 0.7)));
}

/** `peaks` as `bars` bars, each the loudest of the peaks it covers. */
export function resample(peaks: readonly number[], bars: number): number[] {
  if (bars <= 0 || peaks.length === 0) return [];
  const out = new Array<number>(bars);
  const per = peaks.length / bars;
  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    let peak = 0;
    for (let at = start; at < end; at++) peak = Math.max(peak, peaks[at] ?? 0);
    out[i] = peak;
  }
  return out;
}

/** Heights for the bars of a sound still being made: a calm made-up shape that is the same for one call every time. */
export function placeholderPeaks(seed: string, bars: number): number[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: bars }, (_, i) => {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const noise = ((h >>> 0) % 1000) / 1000;
    const swell = 0.55 + 0.3 * Math.sin(i / 7) * Math.sin(i / 19);
    return Math.max(0.12, Math.min(1, swell * (0.6 + noise * 0.5)));
  });
}

/** The peaks of the sound at `url`, or null when this page can't decode it. */
export function loadPeaks(url: string): Promise<number[] | null> {
  let found = cache.get(url);
  if (!found) {
    found = (async () => {
      const context = decoder();
      if (!context) return null;
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const audio = await context.decodeAudioData(await response.arrayBuffer());
        return peaksFrom(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)));
      } catch {
        return null;
      }
    })();
    cache.set(url, found);
  }
  return found;
}
