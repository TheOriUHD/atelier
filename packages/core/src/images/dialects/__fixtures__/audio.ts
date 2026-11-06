/** What the sound dialect tests share: a sound model's capabilities, a request fitted to it, and a tiny real MP3. */
import { readFileSync } from 'node:fs';
import type { AudioCapabilities } from '@atelier/protocol';
import type { ImageRequest } from '../../types.ts';
import { soundModel } from '../audio-common.ts';
import { request } from './images.ts';

export const MP3 = new Uint8Array(readFileSync(new URL('../../__fixtures__/audio/tone-cbr.mp3', import.meta.url)));
export const WAV = new Uint8Array(readFileSync(new URL('../../__fixtures__/audio/tone.wav', import.meta.url)));

/** An answer that is the sound itself. */
export const soundResponse = (bytes: Uint8Array = MP3, type = 'audio/mpeg') => new Response(bytes, { headers: { 'content-type': type } });

/** A sound request: `audio` is merged over a speech one. */
export function audioRequest(over: Omit<Partial<ImageRequest>, 'audio'> & { audio?: Partial<NonNullable<ImageRequest['audio']>> } = {}, capabilities: Partial<AudioCapabilities> = {}): ImageRequest {
  const { audio, ...rest } = over;
  return request({ model: 'm', prompt: 'Hello there.', capabilities: soundModel({ kinds: ['speech', 'music', 'sound'], direction: true, ...capabilities }, { seed: true }), audio: { kind: 'speech', ...audio }, ...rest });
}
