/**
 * The permission mode picker in the Code composer footer (design/components.md › Code composer): the mode as plain
 * text ("Ask", "Plan"), its menu with what each mode does. Plan has a side menu: Manual (the person answers what it
 * asks) or Auto (the Auto reviewer does), where the server has it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FilePen, Hand, ListChecks, ShieldCheck, ShieldOff, type LucideIcon } from 'lucide-react';
import type { PermissionMode } from '@atelier/protocol';
import { Menu, MenuContent, MenuGroup, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSubmenu, MenuTrigger, cn } from '../../components/ui/index.ts';
import { useAppInfo, useSettings } from '../../lib/queries.ts';

const PERMISSION_MODES: Record<PermissionMode, { label: string; short: string; description: string; icon: LucideIcon }> = {
  auto: { label: 'Auto mode', short: 'Auto', description: 'The model reviews each action in a separate request instead of you and blocks risky ones', icon: ShieldCheck },
  default: { label: 'Ask permissions', short: 'Ask', description: 'Ask before editing files or running commands', icon: Hand },
  acceptEdits: { label: 'Accept edits', short: 'Accept edits', description: 'Edit files without asking; still ask before commands', icon: FilePen },
  plan: { label: 'Plan mode', short: 'Plan', description: 'Read and plan only; changes wait until you approve the plan', icon: ListChecks },
  planAuto: { label: 'Plan mode · Auto', short: 'Plan · Auto', description: 'Plan first; the reviewer answers what it would ask, and nothing changes until you approve', icon: ListChecks },
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

/** The modes a conversation outside Code offers: it has no plan to approve, so Plan would keep it from ever changing anything. */
export const CHAT_MODES: readonly PermissionMode[] = ['auto', 'default', 'acceptEdits', 'bypassPermissions'];

/** A chat's mode as it works: Plan (an admin's default for Code) asks instead, as the backend does. */
export const chatMode = (mode: PermissionMode): PermissionMode => (mode === 'plan' ? 'default' : mode === 'planAuto' ? 'auto' : mode);

/** The modes the menu lists; Plan · Auto is chosen in Plan's own side menu. */
const LISTED: readonly PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Plan's two ways, in its side menu: the person answers what it asks, or the Auto reviewer does. */
const PLAN_WAYS: { mode: PermissionMode; label: string; description: string }[] = [
  { mode: 'plan', label: 'Manual', description: 'You answer what it asks, as before' },
  { mode: 'planAuto', label: 'Auto', description: 'The reviewer answers instead: reads anywhere and commands that change nothing go ahead' },
];

export function PermissionModePicker({ value, onChange, modes = LISTED, hint = true }: { value: PermissionMode; onChange(mode: PermissionMode): void; modes?: readonly PermissionMode[]; hint?: boolean }) {
  const current = PERMISSION_MODES[value];
  // A server from before Plan · Auto knows only Plan.
  const planAuto = useAppInfo().data?.planAuto === true;
  const planning = value === 'plan' || value === 'planAuto';
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
          planning && 'text-interactive-text',
          value === 'bypassPermissions' && 'text-danger-text',
        )}
      >
        <span className="truncate">{current.short}</span>
      </MenuTrigger>
      <MenuContent side="top" className="w-80">
        <MenuGroup>
          <MenuLabel>{hint ? 'Permission mode · Shift+Tab to switch' : 'Permission mode'}</MenuLabel>
          <MenuRadioGroup value={value} onValueChange={(mode: PermissionMode) => onChange(mode)}>
            {modes.map((mode) =>
              mode === 'plan' && planAuto ? (
                <MenuSubmenu
                  key={mode}
                  label="Plan mode"
                  icon={ListChecks}
                  hint={value === 'planAuto' ? 'Auto' : value === 'plan' ? 'Manual' : undefined}
                  triggerClassName={cn(planning && 'text-interactive-text')}
                  className="w-72"
                >
                  <MenuLabel>Read and plan only; changes wait until you approve</MenuLabel>
                  <MenuRadioGroup value={value} onValueChange={(next: PermissionMode) => onChange(next)}>
                    {PLAN_WAYS.map((way) => (
                      <MenuRadioItem key={way.mode} value={way.mode} description={way.description} className={cn(way.mode === 'planAuto' && 'text-interactive-text')}>
                        {way.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuSubmenu>
              ) : (
                <MenuRadioItem key={mode} value={mode} icon={PERMISSION_MODES[mode].icon} description={PERMISSION_MODES[mode].description}>
                  {PERMISSION_MODES[mode].label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuContent>
    </Menu>
    </>
  );
}
