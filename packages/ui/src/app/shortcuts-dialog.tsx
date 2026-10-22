import { Dialog, DialogContent, Kbd } from '../components/ui/index.ts';
import { isMac } from '../lib/platform.ts';
import { isLocal } from '../features/auth/screen-lock.ts';

const mod = isMac ? '⌘' : 'Ctrl';

/** Every shortcut Atelier binds (app-wide in AppShell, in the message box in Composer and its footer). */
const groups = (): { title: string; keys: [string, string[]][] }[] => [
  {
    title: 'App',
    keys: [
      ['New chat, task or session', [mod, 'N']],
      ['New temporary chat', [mod, 'Shift', 'N']],
      ['Search', [mod, 'K']],
      ['Settings', [mod, ',']],
      ['Show or hide the sidebar', [mod, 'B']],
      // The screen lock exists only on "Run on this computer".
      ...(isLocal() ? ([['Lock Atelier', [mod, 'Shift', 'L']]] as [string, string[]][]) : []),
    ],
  },
  {
    title: 'Message box',
    keys: [
      ['Send', ['Enter']],
      ['New line', ['Shift', 'Enter']],
      ['Stop while it works (empty box)', ['Esc']],
      ['Upload or add files', [mod, 'U']],
      ['Commands and skills', ['/']],
      ['Mention a file (Code)', ['@']],
      ['Switch permission mode (Code)', ['Shift', 'Tab']],
      ['Change effort', [mod, 'Shift', 'E']],
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" width={440}>
        <div className="flex flex-col gap-5">
          {groups().map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="pb-1 text-footnote text-fg-muted">{group.title}</h3>
              <dl>
                {group.keys.map(([action, keys]) => (
                  <div
                    key={action}
                    className="flex h-9 items-center justify-between gap-4 border-b border-line-subtle last:border-b-0"
                  >
                    <dt className="text-body text-fg">{action}</dt>
                    <dd className="flex gap-1">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
