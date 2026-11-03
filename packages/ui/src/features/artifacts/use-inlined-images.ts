import { useEffect, useMemo, useReducer } from 'react';
import { blobUrl } from '../../lib/platform.ts';
import type { ImageIndex } from '../images/session-images.tsx';
import { inlineImages, loadDataUrl, loadImages, pendingImages } from './image-refs.ts';

/**
 * `content` with its `atelier-image:` references swapped for data URLs of the conversation's own images (see
 * `image-refs.ts`). Content that names no image comes back as it is, at once, and `pending` is false.
 */
export function useInlinedImages(content: string, index: ImageIndex): { content: string; pending: boolean } {
  const [version, loadedMore] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const missing = pendingImages(content, index);
    if (missing.length === 0) return;
    let current = true;
    void loadImages(missing, (image) => loadDataUrl(image, blobUrl)).then(() => current && loadedMore());
    return () => {
      current = false;
    };
  }, [content, index]);
  // `version` is what makes the swap run again once more images have arrived.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => inlineImages(content, index), [content, index, version]);
}
