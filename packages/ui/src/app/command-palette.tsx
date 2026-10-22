import { useDeferredValue, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Ghost, Lock, MessageSquare, Plus, Search, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { Icon, Kbd, cn } from '../components/ui/index.ts';
import { dialogBackdropClass } from '../components/ui/styles.ts';
import { relativeTime } from '../lib/dates.ts';
import { useSessions } from '../lib/queries.ts';
import { useUi } from '../lib/ui-store.ts';
import { useMode, useNewChat, useNewTemporaryChat, useOpenSettings } from './navigation.ts';
import { useLockNow, useScreenLock } from '../features/auth/screen-lock.ts';
import { sessionTitle } from '../lib/sessions.ts';

interface Action {
  id: string;
  label: string;
  icon: LucideIcon;
  run(): void;
}

/** Cmd/Ctrl+K: app actions plus full-text search over chats (titles and message text). */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query.trim());
  const { data: sessions } = useSessions({ mode: 'chat', ...(search ? { query: search } : {}) });
  const navigate = useNavigate();
  const newChat = useNewChat();
  const newTemporaryChat = useNewTemporaryChat();
  const mode = useMode();
  const openSettings = useOpenSettings();
  const lock = useScreenLock();
  const lockNow = useLockNow(openSettings);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const actions: Action[] = [
    { id: 'new-chat', label: { chat: 'New chat', work: 'New Cowork task', code: 'New session' }[mode], icon: Plus, run: newChat },
    { id: 'new-temporary-chat', label: 'New temporary chat', icon: Ghost, run: newTemporaryChat },
    { id: 'settings', label: 'Settings', icon: SettingsIcon, run: () => openSettings() },
    ...(lock?.enabled ? [{ id: 'lock', label: 'Lock Atelier', icon: Lock, run: lockNow }] : []),
  ].filter((a) => a.label.toLowerCase().includes(search.toLowerCase()));
  const chats = (sessions ?? []).slice(0, search ? 20 : 8);

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={dialogBackdropClass} />
        <BaseDialog.Popup
          aria-label="Search"
          className={cn(
            'fixed top-[146px] left-1/2 z-(--at-layout-z-modal) flex h-[min(582px,calc(100dvh-170px))] w-(--at-layout-palette-width) max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden',
            'rounded-palette bg-popover text-fg shadow-lg ring-1 ring-line outline-none',
            'transition-[opacity,scale] duration-(--at-duration-base) ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0',
          )}
        >
          <Command shouldFilter={false} loop className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 px-6 pt-5 pb-2">
              <Icon icon={Search} size="md" className="text-fg-muted" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search chats and actions"
                className="h-6 flex-1 bg-transparent text-[16px] leading-6 text-fg outline-none placeholder:text-fg-muted"
              />
            </div>
            <Command.List className="min-h-0 flex-1 overflow-y-auto pr-2.5 pb-2 pl-[11px]">
              <Command.Empty className="px-3 py-8 text-center text-body text-fg-muted">No chats match “{search}”.</Command.Empty>
              {actions.length > 0 && (
                <Group heading="Actions">
                  {actions.map((a) => (
                    <Item key={a.id} value={a.id} icon={a.icon} onSelect={() => (close(), a.run())}>
                      {a.label}
                    </Item>
                  ))}
                </Group>
              )}
              {chats.length > 0 && (
                <Group heading={search ? 'Chats' : 'Recent chats'}>
                  {chats.map((s) => (
                    <Item
                      key={s.id}
                      value={s.id}
                      icon={MessageSquare}
                      hint={relativeTime(s.updatedAt)}
                      onSelect={() => {
                        close();
                        void navigate({ to: '/chat/$sessionId', params: { sessionId: s.id } });
                      }}
                    >
                      {sessionTitle(s)}
                    </Item>
                  ))}
                </Group>
              )}
            </Command.List>
            <div className="flex h-10 shrink-0 items-center gap-4 border-t border-line-subtle px-6 text-footnote text-fg-muted">
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> Navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd> Open
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Esc</Kbd> Close
              </span>
            </div>
          </Command>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="pt-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-footnote [&_[cmdk-group-heading]]:text-fg-muted"
    >
      {children}
    </Command.Group>
  );
}

function Item({ value, icon, hint, onSelect, children }: { value: string; icon: LucideIcon; hint?: string; onSelect(): void; children: ReactNode }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-9 cursor-default items-center gap-2.5 rounded-lg px-3 text-body text-fg outline-none select-none data-[selected=true]:bg-fill-ghost-hover"
    >
      <Icon icon={icon} className="text-fg-secondary" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-footnote text-fg-muted">{hint}</span>}
    </Command.Item>
  );
}
