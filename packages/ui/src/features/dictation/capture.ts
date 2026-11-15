/**
 * The microphone for dictation (ARCHITECTURE §27): 16 kHz mono 16-bit PCM in 50 ms pieces, from an audio worklet so a
 * busy page never drops sound, and how loud each piece was.
 */
import workletUrl from './pcm-worklet.js?url&no-inline';

export interface Capture {
  /** Stops the microphone; the pieces already posted have been handed over. */
  stop(): void;
}

export interface CaptureOptions {
  /** A microphone by `deviceId`; null for the system's. */
  deviceId: string | null;
  onAudio(pcm: Int16Array): void;
  /** 0 (silence) to 1. */
  onLevel(level: number): void;
  /** The microphone went away (unplugged, or taken by the system). */
  onEnded(): void;
}

/** Why the microphone couldn't be used, as the person reads it; `kind` picks the help next to it. */
export class MicrophoneError extends Error {
  constructor(
    readonly kind: 'denied' | 'missing' | 'busy' | 'insecure' | 'unsupported',
    message: string,
  ) {
    super(message);
  }
}

function microphoneError(error: unknown): MicrophoneError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return new MicrophoneError('denied', 'Atelier isn’t allowed to use the microphone.');
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return new MicrophoneError('missing', 'No microphone was found.');
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
    return new MicrophoneError('busy', 'The microphone couldn’t be started. Another app may be using it.');
  return new MicrophoneError('unsupported', error instanceof Error && error.message ? error.message : 'The microphone couldn’t be started.');
}

const AUDIO: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function openStream(deviceId: string | null): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
    throw new MicrophoneError(
      typeof window !== 'undefined' && !window.isSecureContext ? 'insecure' : 'unsupported',
      typeof window !== 'undefined' && !window.isSecureContext
        ? 'The browser only lets a secure page use the microphone: open Atelier over https, or at localhost on this computer.'
        : 'This browser has no microphone access.',
    );
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...AUDIO, deviceId: { exact: deviceId } } : AUDIO });
  } catch (e) {
    const problem = microphoneError(e);
    // The microphone picked last time is gone (unplugged): the system's own is the next best.
    if (deviceId && problem.kind === 'missing') return openStream(null);
    throw problem;
  }
}

/** A context at 16 kHz saves the worklet the resampling; a browser that can't join a microphone to one gets its own rate. */
function contextFor(stream: MediaStream): { context: AudioContext; source: MediaStreamAudioSourceNode } {
  try {
    const context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' });
    try {
      return { context, source: context.createMediaStreamSource(stream) };
    } catch {
      void context.close();
    }
  } catch {
    // no 16 kHz context here
  }
  const context = new AudioContext({ latencyHint: 'interactive' });
  return { context, source: context.createMediaStreamSource(stream) };
}

export async function startCapture(options: CaptureOptions): Promise<Capture> {
  const stream = await openStream(options.deviceId);
  let stopped = false;
  const tracks = stream.getAudioTracks();
  const stopTracks = () => tracks.forEach((t) => t.stop());
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode;
  let node: AudioWorkletNode;
  try {
    ({ context, source } = contextFor(stream));
    await context.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(context, 'atelier-dictation-pcm', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
  } catch (e) {
    stopTracks();
    void context?.close().catch(() => undefined);
    throw e instanceof MicrophoneError ? e : new MicrophoneError('unsupported', 'The microphone’s sound couldn’t be read.');
  }
  const audio = context;
  node.port.onmessage = ({ data }: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
    if (stopped) return;
    options.onAudio(new Int16Array(data.pcm));
    options.onLevel(Math.min(1, data.level * 4));
  };
  source.connect(node);
  // Opened from a click or a key, it runs; a page that wasn't focused may start it suspended.
  if (audio.state === 'suspended') await audio.resume().catch(() => undefined);
  for (const track of tracks)
    track.addEventListener('ended', () => {
      if (!stopped) options.onEnded();
    });
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      source.disconnect();
      node.port.onmessage = null;
      stopTracks();
      void audio.close().catch(() => undefined);
    },
  };
}

/**
 * The microphones there are, and the name of the system's default one (Chrome lists it as "Default - …"); their names
 * show once the person allowed a microphone.
 */
export async function listMicrophones(): Promise<{ defaultLabel: string | null; list: { id: string; label: string }[] }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return { defaultLabel: null, list: [] };
  const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audioinput');
  const fallback = devices.find((d) => d.deviceId === 'default');
  return {
    defaultLabel: fallback?.label || null,
    list: devices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
  };
}
