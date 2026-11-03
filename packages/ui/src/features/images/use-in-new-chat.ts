import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { FileRef } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { draftAttachments, draftKeys, saveDraftAttachments, useDraftScope } from '../../lib/drafts.ts';
import { blobUrl } from '../../lib/platform.ts';

/**
 * Starts a new chat with an image attached, as "Use as reference" does inside a conversation: the image joins the new
 * chat's unsent message, which the home page shows with it. There is no conversation to attach it to on the Images page.
 */
export function useInNewChat(): (image: { blob: string; mime: string }) => Promise<void> {
  const scope = useDraftScope(true);
  const navigate = useNavigate();
  return useCallback(
    async (image) => {
      if (!scope) {
        toast.error('Still signing you in. Try again in a moment.');
        return;
      }
      const key = `${scope}|${draftKeys.newChat}`;
      const kept = draftAttachments(key);
      if (!kept.some((a) => a.file.blob === image.blob)) {
        // The draft shows a size; the stored file knows it.
        const size = await fetch(blobUrl(image.blob)).then((r) => (r.ok ? r.blob() : null)).then((b) => b?.size ?? 0, () => 0);
        const name = `Image.${image.mime.split('/')[1] ?? 'png'}`;
        const file: FileRef = { id: '', name, mime: image.mime, size, blob: image.blob, kind: 'upload', tokens: null, createdAt: 0 };
        saveDraftAttachments(key, [...kept, { key: crypto.randomUUID(), name, mime: image.mime, size, file }]);
      }
      await navigate({ to: '/' });
    },
    [scope, navigate],
  );
}
