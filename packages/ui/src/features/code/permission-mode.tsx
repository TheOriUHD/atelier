/**
 * The permission mode picker in the Code composer footer (design/components.md › Code composer): the mode as plain
 * text ("Ask", "Plan"), its menu with what each mode does.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FilePen, Hand, ListChecks, ShieldCheck, ShieldOff, type LucideIcon } from 'lucide-react';
import type { PermissionMode } from '@atelier/protocol';
import { Menu, MenuContent, MenuGroup, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, cn } from '../../components/ui/index.ts';
import { useSettings } from '../../lib/queries.ts';

const PERMISSION_MODES: Record<PermissionMode, { label: string; short: string; description: string; icon: LucideIcon }> = {
  auto: { label: 'Auto mode', short: 'Auto', description: 'The model reviews each action in a separate request instead of you and blocks risky ones', icon: ShieldCheck },
  default: { label: 'Ask permissions', short: 'Ask', description: 'Ask before editing files or running commands', icon: Hand },
  acceptEdits: { label: 'Accept edits', short: 'Accept edits', description: 'Edit files without asking; still ask before commands', icon: FilePen },
  plan: { label: 'Plan mode', short: 'Plan', description: 'Read and plan only; changes wait until you approve the plan', icon: ListChecks },
  bypassPermissions: { label: 'Bypass permissions', short: 'Bypass', description: 'Never ask, not even for risky commands', icon: ShieldOff },
};

/** Shift+Tab cycles these; Bypass is only ever chosen in the menu. */
const CYCLE: PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan'];

export function nextMode(mode: PermissionMode): PermissionMode {
  return CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]!;
}

/**
 * Whether a key press in the message box switches the mode: Shift+Tab while the box is empty.
 * With text in the box Shift+Tab moves focus back as usual (and a question that comes up takes focus itself).
 */
export function switchesMode(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== 'Tab' || !e.shiftKey || e.currentTarget.value !== '') return false;
  e.preventDefault();
  return true;
}

/** A session's mode: its own, or the system default (null) from Settings › Code. */
export function useEffectiveMode(mode: PermissionMode | null): PermissionMode {
  const { settings } = useSettings();
  return mode ?? settings?.permissions.defaultMode ?? 'auto';
}

export function PermissionModePicker({ value, onChange }: { value: PermissionMode; onChange(mode: PermissionMode): void }) {
  const current = PERMISSION_MODES[value];
  // Says a change out loud, since Shift+Tab makes it without moving focus here.
  const [said, setSaid] = useState('');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else setSaid(`Permission mode: ${PERMISSION_MODES[value].label}`);
  }, [value]);
  return (
    <>
    <span role="status" className="sr-only">
      {said}
    </span>
    <Menu>
      <MenuTrigger
        aria-label={`Permission mode: ${current.label}`}
        className={cn(
          'flex h-6 min-w-0 items-center rounded-sm px-2 text-control-sm text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover',
          value === 'plan' && 'text-interactive-text',
          value === 'bypassPermissions' && 'text-danger-text',
        )}
      >
        <span className="truncate">{current.short}</span>
      </MenuTrigger>
      <MenuContent side="top" className="w-80">
        <MenuGroup>
          <MenuLabel>Permission mode · Shift+Tab to switch</MenuLabel>
          <MenuRadioGroup value={value} onValueChange={(mode: PermissionMode) => onChange(mode)}>
            {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((mode) => (
              <MenuRadioItem key={mode} value={mode} icon={PERMISSION_MODES[mode].icon} description={PERMISSION_MODES[mode].description}>
                {PERMISSION_MODES[mode].label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuContent>
    </Menu>
    </>
  );
}
