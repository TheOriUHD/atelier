import { PanelLeft } from 'lucide-react';
import { IconButton, cn } from '../components/ui/index.ts';
import { desktop, isMac } from '../lib/platform.ts';
import { useNarrow } from '../lib/narrow.ts';
import { useUi } from '../lib/ui-store.ts';
import { solo } from './solo.ts';

/** macOS draws the traffic lights over the top-left corner of the window (see apps/desktop main.ts). */
export const trafficLightInset = !!desktop && isMac;

export function SidebarToggle({ className }: { className?: string }) {
  const toggle = useUi((s) => s.toggleSidebar);
  const narrow = useNarrow();
  const open = useUi((s) => (narrow ? s.drawerOpen : !s.sidebarCollapsed));
  return (
    <IconButton
      icon={PanelLeft}
      label={open ? 'Close sidebar' : 'Open sidebar'}
      size="xs"
      onClick={toggle}
      className={cn('app-no-drag text-fg-secondary', className)}
    />
  );
}

/** The sidebar is collapsed, or a drawer on narrow screens: the page's top-left corner holds the toggle instead. */
export function useSidebarHidden(): boolean {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const narrow = useNarrow();
  return solo || narrow || collapsed;
}
