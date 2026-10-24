import { SHORTCUTS, type ShortcutBindings, type ShortcutInfo } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Kbd } from '../components/ui/index.ts';
import { keysOf, useShortcutBindings } from '../lib/shortcuts.ts';
import { isLocal } from '../features/auth/screen-lock.ts';
import { useOpenSettings } from './navigation.ts';

/** The keys of the message box that can't be changed: typing needs them. */
export const FIXED_SHORTCUTS: [string, string[]][] = [
  ['Send', ['Enter']],
  ['New line', ['Shift', 'Enter']],
  ['Stop while it works (empty box)', ['Esc']],
  ['Commands and skills', ['/']],
  ['Mention a file (Code)', ['@']],
  ['Switch permission mode (Code)', ['Shift', 'Tab']],
];

/** The shortcuts that work here: the screen lock exists only on "Run on this computer". */
export const shortcutsHere = (): readonly ShortcutInfo[] => SHORTCUTS.filter((s) => s.id !== 'lock' || isLocal());

/** Every shortcut Atelier binds, as the person set them (Settings › Shortcuts changes them). */
const groups = (bindings: ShortcutBindings): { title: string; keys: [string, string[] | null][] }[] => [
  { title: 'App', keys: shortcutsHere().filter((s) => s.group === 'App').map((s) => [s.label, keysOf(bindings[s.id])]) },
  {
    title: 'Message box',
    keys: [
      ...FIXED_SHORTCUTS.slice(0, 3),
      ...shortcutsHere()
        .filter((s) => s.group === 'Message box')
        .map((s): [string, string[] | null] => [s.label, keysOf(bindings[s.id])]),
      ...FIXED_SHORTCUTS.slice(3),
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const bindings = useShortcutBindings();
  const openSettings = useOpenSettings();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" width={440}>
        <div className="flex flex-col gap-5">
          {groups(bindings).map((group) => (
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
                      {keys ? keys.map((k) => <Kbd key={k}>{k}</Kbd>) : <span className="text-body text-fg-muted">Off</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              onOpenChange(false);
              openSettings('shortcuts');
            }}
          >
            Change shortcuts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
