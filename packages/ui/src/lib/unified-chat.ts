/**
 * Chat and Cowork in one (Settings › Admin › Capabilities `unifiedChat`, being built and off until it is done): there is
 * one kind of conversation, which works as a Cowork task when its request needs it. Old Cowork tasks open as chats.
 */
import { useSettings } from './queries.ts';

export function useUnifiedChat(): boolean {
  return useSettings().settings?.capabilities.unifiedChat === true;
}
