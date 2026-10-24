import { ChevronDown, Plus } from 'lucide-react';
import type { Effort, Mode, ModelInfo } from '@atelier/protocol';
import {
  Icon,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  toast,
} from '../../components/ui/index.ts';
import { useOpenSettings } from '../../app/navigation.ts';
import { useAccount, usePrefs, useSetPref, useSettings } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { EffortControl } from './effort-control.tsx';
import { modelSubtitle, useModelGroups } from './models.ts';

export interface ModelPickerProps {
  model: ModelInfo | undefined;
  mode: Mode;
  effort: Effort | null;
  onModelChange(ref: string): void;
  /** Return the session update's promise: the controls show the change until it settles, and say so if it fails. */
  onEffortChange(effort: Effort | null): unknown;
  /** In an existing session, where an effort change applies from the next message. */
  inSession?: boolean;
  sessionId?: string;
  thinking?: boolean;
  /** Controls the list (the `/model` command opens it). */
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

/**
 * Composer footer controls: the model, opening a provider-grouped list, then its effort level. A model that can only
 * switch thinking on or off has an independent thinking switch inside the effort popover.
 */
export function ModelPicker({ model, mode, effort, onModelChange, onEffortChange, inSession, sessionId, thinking, open, onOpenChange }: ModelPickerProps) {
  const { settings } = useSettings();
  const { prefs } = usePrefs();
  const setPref = useSetPref();
  const changeEffort = (next: Effort | null) => {
    const result = onEffortChange(next);
    return result instanceof Promise ? result.catch(() => toast.error('Couldn’t change effort')) : undefined;
  };

  return (
    <>
      <ModelMenu value={model?.ref ?? null} label={model?.displayName ?? 'Choose a model'} onChange={(ref) => ref && onModelChange(ref)} open={open} onOpenChange={onOpenChange} />
      <EffortControl model={model} mode={mode} effort={effort} onChange={changeEffort} inSession={inSession} thinking={thinking ?? prefs?.thinking ?? true} onThinkingChange={sessionId ? (value) => rpc().call('sessions.update', { id: sessionId, thinking: value }).catch(() => toast.error('Couldn’t change thinking')) : (value) => setPref.mutate({ path: ['thinking'], value })} ultracode={settings?.ultracode?.enabled !== false} />
    </>
  );
}

/** Radio value of the automatic choice; model refs always contain a slash, so it can't collide. */
const AUTOMATIC = 'default';

export interface ModelMenuProps {
  /** The chosen model's ref; null is the automatic choice (`automatic`) or nothing yet. */
  value: string | null;
  /** The trigger's text. */
  label: string;
  onChange(ref: string | null): void;
  /** A first item for the automatic choice, which `onChange` reports as null. */
  automatic?: { label: string; description: string };
  'aria-label'?: string;
  disabled?: boolean;
  align?: 'start' | 'end';
  open?: boolean;
  onOpenChange?(open: boolean): void;
}

/** The composer's model list: the visible models by provider, or a way to add a provider when there are none. */
export function ModelMenu({ value, label, onChange, automatic, 'aria-label': ariaLabel, disabled, align = 'end', open, onOpenChange }: ModelMenuProps) {
  const groups = useModelGroups();
  const { account } = useAccount();
  const openSettings = useOpenSettings();
  const select = (next: string) => onChange(next === AUTOMATIC ? null : next);
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        aria-label={ariaLabel}
        disabled={disabled}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-2 text-control-sm outline-none focus-ring hover:bg-fill-ghost-hover disabled:opacity-60 data-popup-open:bg-fill-ghost-hover"
      >
        <span className="max-w-56 truncate text-fg">{label}</span>
        <Icon icon={ChevronDown} size="sm" className="size-3 text-fg-muted" />
      </MenuTrigger>
      <MenuContent align={align} className="w-[295px]">
        {automatic && (
          <MenuGroup>
            <MenuRadioGroup value={value ?? AUTOMATIC} onValueChange={select}>
              <MenuRadioItem value={AUTOMATIC} description={automatic.description}>
                {automatic.label}
              </MenuRadioItem>
            </MenuRadioGroup>
            {groups.length > 0 && <MenuSeparator />}
          </MenuGroup>
        )}
        {groups.length === 0 &&
          (account?.role === 'admin' ? (
            <MenuItem icon={Plus} description="Connect Ollama, llama.cpp, Anthropic, OpenAI or any compatible endpoint" onClick={() => openSettings('providers')}>
              Add a provider
            </MenuItem>
          ) : (
            <MenuItem disabled description="Ask an admin to connect a provider.">
              No models available
            </MenuItem>
          ))}
        {groups.map((g, i) => (
          <MenuGroup key={g.providerId}>
            {i > 0 && <MenuSeparator />}
            {(groups.length > 1 || g.offline) && <MenuLabel>{g.offline ? `${g.label} · Not connected` : g.label}</MenuLabel>}
            <MenuRadioGroup value={value ?? ''} onValueChange={select}>
              {g.models.map((m) => (
                <MenuRadioItem key={m.ref} value={m.ref} description={modelSubtitle(m)} disabled={m.available === false && m.ref !== value}>
                  {m.displayName}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ))}
      </MenuContent>
    </Menu>
  );
}
