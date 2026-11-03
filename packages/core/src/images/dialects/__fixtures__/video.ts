/** What the video dialect tests share: a video model's capabilities and a request fitted to it. */
import type { ImageCapabilities, VideoCapabilities } from '@atelier/protocol';
import { hostedVideo } from '../video-common.ts';
import type { ImageRequest } from '../../types.ts';
import { request } from './images.ts';

export const videoOf = (capabilities: ImageCapabilities): VideoCapabilities => {
  if (!capabilities.video) throw new Error('not a video model');
  return capabilities.video;
};

const caps = (audio: VideoCapabilities['audio'] = 'optional'): ImageCapabilities =>
  hostedVideo({ family: 'test', ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], durations: { kind: 'list', seconds: [4, 6, 8] }, defaultSeconds: 6, firstFrame: true, lastFrame: true, audio, seed: true });

/** A video request: `video` is merged over a 6-second one. */
export function videoRequest(over: Omit<Partial<ImageRequest>, 'video'> & { video?: Partial<NonNullable<ImageRequest['video']>> } = {}, capabilities: Partial<VideoCapabilities> = {}): ImageRequest {
  const base = caps(capabilities.audio);
  const { video, ...rest } = over;
  return request({ model: 'm', capabilities: base, video: { seconds: 6, ...video }, ...rest });
}
