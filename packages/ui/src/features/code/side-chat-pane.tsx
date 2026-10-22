/** The Side chat pane (design/components.md › Code panes, SideChat): the session's side chats as tabs in the dock. */
import { SIDE_CHAT_TITLE, SideChatBody, SideChatTabs, type SideChats } from '../chat/side-chat.tsx';
import { PaneFrame, type PaneFrameState } from './pane-dock.tsx';
import { CodeActivity } from './tool-cards.tsx';

export function SideChatPane({ frame, chats }: { frame: PaneFrameState; chats: SideChats }) {
  return (
    <PaneFrame
      frame={frame}
      title={SIDE_CHAT_TITLE}
      start={
        <SideChatTabs
          chats={chats}
          onClose={(id) => {
            chats.close(id);
            if (chats.chats.length <= 1) frame.close();
          }}
        />
      }
    >
      <SideChatBody chats={chats} activity={CodeActivity} />
    </PaneFrame>
  );
}
