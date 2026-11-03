/**
 * A video's first picture, as a PNG file, for "Use first frame as reference". It is taken from a second, hidden player
 * loaded for the purpose, so the visible one keeps playing where it is. The player is loaded with `crossorigin`, which
 * the server's blob route and the desktop's blob scheme both allow, because a canvas that drew a cross-origin video
 * refuses to hand its pixels over.
 */

const LOAD_TIMEOUT_MS = 15_000;

export async function firstFrame(src: string): Promise<File> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The video took too long to load.')), LOAD_TIMEOUT_MS);
      video.addEventListener(
        'loadeddata',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('The video could not be loaded.'));
        },
        { once: true },
      );
      video.src = src;
      video.load();
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error('The video has no picture to take.');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The picture could not be taken.');
    context.drawImage(video, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be taken.'))), 'image/png'));
    return new File([png], 'first-frame.png', { type: 'image/png' });
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
