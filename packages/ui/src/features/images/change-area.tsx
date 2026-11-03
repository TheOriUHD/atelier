/**
 * "Change an area" from a conversation's side: which image the person is marking, uploading the mask they brushed and
 * sending it with their words as a message the model turns into a `GenerateImage` call with `mask` (ARCHITECTURE §23).
 * The images that offer it (`GeneratedImages`, the Images page) only call `useChangeArea().open(image)`.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Part } from '@atelier/protocol';
import { blobUrl } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';
import { readBase64 } from '../chat/use-attachments.ts';
import { AreaEditor } from './area-editor.tsx';

export interface AreaImage {
  blob: string;
  mime: string;
  /** For the picture's alt text. */
  prompt?: string;
}

type ChangeArea = { open(image: AreaImage): void };

const ChangeAreaContext = createContext<ChangeArea | null>(null);

/** Where an image can offer "Change an area": null on pages that have no conversation to send it to. */
export const useChangeArea = (): ChangeArea | null => useContext(ChangeAreaContext);

/**
 * Sends the instruction and the mask to `sessionId` (queued behind a reply still being written, or sent at once).
 * The mask is uploaded first, to the same session, and travels as a `notice` the backend checks and turns into words.
 */
export async function sendAreaChange(sessionId: string, image: { blob: string; mime: string }, instruction: string, mask: Blob): Promise<void> {
  const client = rpc();
  const file = await client.call('files.upload', { name: 'area-mask.png', mime: 'image/png', dataBase64: await readBase64(new File([mask], 'area-mask.png', { type: 'image/png' })), sessionId });
  const parts: Part[] = [
    { type: 'context', text: '', notice: { kind: 'area', image: { blob: image.blob, mime: image.mime }, mask: { blob: file.blob, mime: 'image/png' } } },
    { type: 'text', text: instruction },
  ];
  await client.call('chat.queue', { sessionId, parts });
}

export function ChangeAreaProvider({ sessionId, children, onSent }: { sessionId: string; children: ReactNode; onSent?: () => void }) {
  const [image, setImage] = useState<AreaImage | null>(null);
  const open = useCallback((next: AreaImage) => setImage(next), []);
  const value = useMemo(() => ({ open }), [open]);
  // The image stays while the editor fades out.
  const [shown, setShown] = useState<AreaImage | null>(null);
  if (image && image !== shown) setShown(image);
  return (
    <ChangeAreaContext.Provider value={value}>
      {children}
      {shown && (
        <AreaEditor
          open={!!image}
          src={blobUrl(shown.blob)}
          alt={shown.prompt ? shown.prompt.slice(0, 200) : 'The image to change'}
          onClose={() => setImage(null)}
          onSubmit={async (instruction, mask) => {
            await sendAreaChange(sessionId, shown, instruction, mask);
            onSent?.();
          }}
        />
      )}
    </ChangeAreaContext.Provider>
  );
}
