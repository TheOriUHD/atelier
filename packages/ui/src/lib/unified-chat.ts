/**
 * Chat and Cowork in one: there is one kind of conversation, which works as a Cowork task when its request needs it, and
 * old Cowork tasks open as chats. A backend says so in `app.info` (`unifiedChat`); a 0.7.4 server said so with its preview
 * switch. An older server keeps Cowork as it was, and the app shows it that way until the server is updated.
 */
import { useAppInfo, useSettings } from './queries.ts';

/** Whether the backend merges them; undefined until its info and settings are read. */
export function useUnifiedChatState(): boolean | undefined {
  const { data: info } = useAppInfo();
  const { settings } = useSettings();
  if (info?.unifiedChat === true) return true;
  if (!info || !settings) return undefined;
  return settings.capabilities.unifiedChat === true;
}

export function useUnifiedChat(): boolean {
  return useUnifiedChatState() === true;
}
