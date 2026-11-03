/**
 * The images of one conversation by the ids the model knows them by (`img_` + 8 hex of the hash, ARCHITECTURE §23).
 * This is the only table that turns an id into pixels in the page, so an id the model writes in an artifact, a visual
 * or a reply can reach exactly this conversation's images and nothing else.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { imageId, type Message } from '@atelier/protocol';
import { useLiveSession } from '../../lib/live-session.ts';

export interface SessionImage {
  id: string;
  blob: string;
  mime: string;
}

export type ImageIndex = ReadonlyMap<string, SessionImage>;

const NONE: ImageIndex = new Map();

/**
 * Every image a conversation shows: attached, read by a tool or made. The mask of a marked area is no picture to show,
 * and isn't here.
 */
export function imageIndex(messages: readonly Message[]): ImageIndex {
  const found = new Map<string, SessionImage>();
  const add = (blob: string, mime: string) => {
    const id = imageId(blob);
    if (!found.has(id)) found.set(id, { id, blob, mime });
  };
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'image') add(part.blob, part.mime);
      else if (part.type === 'tool_result') {
        for (const content of part.content) if (content.type === 'image') add(content.blob, content.mime);
        for (const made of part.generated ?? []) add(made.blob, made.mime);
      }
    }
  }
  return found;
}

const SessionImagesContext = createContext<ImageIndex>(NONE);

/** The conversation's images for everything below it (the transcript's visuals and replies). */
export function SessionImagesProvider({ messages, children }: { messages: readonly Message[]; children: ReactNode }) {
  const index = useMemo(() => imageIndex(messages), [messages]);
  return <SessionImagesContext.Provider value={index}>{children}</SessionImagesContext.Provider>;
}

/** The images of the conversation the page is showing. Empty outside a transcript. */
export const useSessionImages = (): ImageIndex => useContext(SessionImagesContext);

/** The images of a session by its id, for a panel that sits beside the transcript (the artifact panel). */
export function useSessionImagesOf(sessionId: string | undefined): ImageIndex {
  // `useLiveSession` holds the subscription for as long as this is mounted, the same one the page has.
  const live = useLiveSession(sessionId ?? '');
  return useMemo(() => (sessionId ? imageIndex(live.messages) : NONE), [sessionId, live.messages]);
}
