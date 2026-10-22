/**
 * The session header's pane toggles (design/components.md › Code panes): Terminal, Diff, Browser (desktop app only), Files
 * and More, whose menu opens Background tasks, Plan, the Artifact pane and Side chat and holds "Keep computer awake" (desktop app only).
 */
import type { Ref } from 'react';
import { Activity, Coffee, EllipsisVertical, Folder, Globe, ListChecks, MessageCircleQuestion, Shapes, Terminal, createLucideIcon, type LucideIcon } from 'lucide-react';
import { Badge, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuSwitchItem, MenuTrigger } from '../../components/ui/index.ts';
import type { PaneId } from './pane-layout.ts';

/** A ± in a square: the Diff pane. */
export const SquareDiff = createLucideIcon('square-diff', [
  ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', key: 'frame' }],
  ['path', { d: 'M12 7v6', key: 'plus-v' }],
  ['path', { d: 'M9 10h6', key: 'plus-h' }],
  ['path', { d: 'M9 16h6', key: 'minus' }],
]);

export const PANE_TITLES: Record<PaneId, string> = {
  terminal: 'Terminal',
  diff: 'Diff',
  browser: 'Browser',
  files: 'Files',
  tasks: 'Background tasks',
  plan: 'Plan',
  artifact: 'Artifact',
  side: 'Side chat',
};

const TOGGLES: { pane: PaneId; icon: LucideIcon }[] = [
  { pane: 'terminal', icon: Terminal },
  { pane: 'diff', icon: SquareDiff },
  { pane: 'browser', icon: Globe },
  { pane: 'files', icon: Folder },
];

/** 28px with a 20px glyph; an open pane's toggle is tinted with the interactive blue. */
const toggleClass = 'app-no-drag text-fg-secondary aria-pressed:bg-interactive-subtle aria-pressed:text-interactive-text aria-pressed:hover:bg-interactive-subtle';

export function PaneButtons({
  open,
  available,
  onToggle,
  onOpen,
  runningTasks,
  keepAwake,
  buttonRef,
}: {
  open: ReadonlySet<PaneId>;
  /** The panes this surface offers (no Browser in a web browser). */
  available: readonly PaneId[];
  onToggle(pane: PaneId): void;
  onOpen(pane: PaneId): void;
  /** Background commands and sub-agents still running, for More's badge. */
  runningTasks: number;
  /** "Keep computer awake" for this session; null where the app can't (a web browser). */
  keepAwake: { on: boolean; set(on: boolean): void } | null;
  /** Where focus goes back when a pane closes: its toggle, or More for the panes it opens. */
  buttonRef(pane: PaneId | 'more'): Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {TOGGLES.filter((t) => available.includes(t.pane)).map(({ pane, icon }) => (
        <IconButton
          key={pane}
          ref={buttonRef(pane)}
          icon={icon}
          iconSize="md"
          size="sm"
          label={PANE_TITLES[pane]}
          aria-pressed={open.has(pane)}
          className={toggleClass}
          onClick={() => onToggle(pane)}
        />
      ))}
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              ref={buttonRef('more')}
              icon={EllipsisVertical}
              iconSize="md"
              size="sm"
              label="More"
              className={toggleClass}
            />
          }
        />
        <MenuContent align="end" className="w-64">
          <MenuItem icon={Activity} onClick={() => onOpen('tasks')} shortcut={runningTasks > 0 && <Badge tone="accent">{runningTasks}</Badge>}>
            Background tasks
          </MenuItem>
          <MenuItem icon={ListChecks} onClick={() => onOpen('plan')}>
            Plan
          </MenuItem>
          <MenuItem icon={Shapes} onClick={() => onOpen('artifact')}>
            Artifact
          </MenuItem>
          <MenuItem icon={MessageCircleQuestion} onClick={() => onOpen('side')}>
            Side chat
          </MenuItem>
          {keepAwake && (
            <>
              <MenuSeparator />
              <MenuSwitchItem icon={Coffee} description="Only for this session" checked={keepAwake.on} onCheckedChange={keepAwake.set}>
                Keep computer awake
              </MenuSwitchItem>
            </>
          )}
        </MenuContent>
      </Menu>
    </div>
  );
}
