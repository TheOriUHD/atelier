/**
 * The message box's microphone (ARCHITECTURE §27): a click starts and stops dictating; with "Hold to record" on, holding
 * it records until it is let go. The arrow beside it opens the microphone, the language and that switch.
 */
import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, Mic, Search } from 'lucide-react';
import { DICTATION_LANGUAGES, dictationLanguageLabel } from '@atelier/protocol';
import { Icon, Menu, MenuContent, MenuGroup, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSubmenu, MenuSwitchItem, MenuTrigger, Spinner, Tooltip, cn } from '../../components/ui/index.ts';
import { shortcutText } from '../../lib/shortcuts.ts';
import { saveMicrophone, useMicrophones, useSavedMicrophone } from './microphones.ts';
import type { DictationPhase } from './use-dictation.ts';

/** A press held this long records until it is let go; a shorter one is a click. */
export const HOLD_MS = 350;

export interface DictateButtonProps {
  phase: DictationPhase;
  holdToRecord: boolean;
  /** The shortcut that does the same, for the tooltip. */
  shortcut: string | null;
  onStart(): void;
  onStop(): void;
  language: string;
  onLanguage(code: string): void;
  onHoldToRecord(on: boolean): void;
}

export function DictateButton({ phase, holdToRecord, shortcut, onStart, onStop, language, onLanguage, onHoldToRecord }: DictateButtonProps) {
  const active = phase !== 'idle';
  const keys = shortcutText(shortcut);
  // Read when a press ends, which may be after this render: the latest values.
  const now = useRef({ holdToRecord, onStop });
  useLayoutEffect(() => {
    now.current = { holdToRecord, onStop };
  });

  /**
   * The mouse and touch work on the press itself, not the click: starting re-renders the button, after which a browser
   * may never send the click. Pressed while it runs, it stops; pressed to start, it records until let go if that took
   * long enough ("Hold to record"), else it keeps listening until the next press.
   */
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    // The focus stays in the message box, where Enter sends and Escape cancels.
    e.preventDefault();
    if (phase !== 'idle') {
      if (phase === 'listening' || phase === 'starting') onStop();
      return;
    }
    const pressedAt = performance.now();
    const release = () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      if (now.current.holdToRecord && performance.now() - pressedAt >= HOLD_MS) now.current.onStop();
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    onStart();
  };
  // Enter or Space on the focused button (a click with no pointer behind it, `detail` 0) starts and stops.
  const onClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0) return;
    if (phase === 'idle') onStart();
    else if (phase === 'listening' || phase === 'starting') onStop();
  };

  const label = active ? 'Stop dictation' : 'Dictate';
  const tip = active ? 'Stop dictation' : holdToRecord ? 'Dictate: click, or hold to talk' : 'Dictate';
  return (
    <span className="group/dictate flex shrink-0 items-center">
      <Tooltip content={keys ? `${tip}  ${keys}` : tip}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onPointerDown={onPointerDown}
          onClick={onClick}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-(--at-duration-fast) focus-ring',
            active ? 'bg-interactive text-on-interactive hover:bg-interactive-hover' : 'text-fg-secondary hover:bg-fill-ghost-hover hover:text-fg',
          )}
        >
          {phase === 'starting' || phase === 'finishing' ? <Spinner size="sm" className="text-current" /> : <Icon icon={Mic} size="sm" />}
        </button>
      </Tooltip>
      <DictationMenu language={language} onLanguage={onLanguage} holdToRecord={holdToRecord} onHoldToRecord={onHoldToRecord} />
    </span>
  );
}

function DictationMenu({ language, onLanguage, holdToRecord, onHoldToRecord }: { language: string; onLanguage(code: string): void; holdToRecord: boolean; onHoldToRecord(on: boolean): void }) {
  const [open, setOpen] = useState(false);
  const microphones = useMicrophones(open);
  const saved = useSavedMicrophone();
  const chosen = saved && microphones.list.some((m) => m.id === saved) ? saved : '';
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip content="Microphone and language" disabled={open}>
        <MenuTrigger
          aria-label="Dictation settings"
          className="flex h-8 w-4 shrink-0 items-center justify-center rounded-sm text-fg-muted opacity-0 outline-none transition-opacity duration-(--at-duration-fast) group-hover/dictate:opacity-100 hover:text-fg focus-visible:opacity-100 focus-ring data-popup-open:opacity-100"
        >
          <Icon icon={ChevronDown} size="sm" className="size-3" />
        </MenuTrigger>
      </Tooltip>
      <MenuContent side="top" align="end" className="w-72">
        <MenuRadioGroup value={chosen} onValueChange={(value: string) => saveMicrophone(value || null)}>
          <MenuLabel>Microphone</MenuLabel>
          <MenuRadioItem value="" closeOnClick={false}>
            {microphones.defaultLabel ?? 'System default'}
          </MenuRadioItem>
          {microphones.list.map((m) => (
            <MenuRadioItem key={m.id} value={m.id} closeOnClick={false}>
              {m.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuSubmenu label="Language" hint={dictationLanguageLabel(language)} className="w-64">
          <LanguageList language={language} onLanguage={onLanguage} />
        </MenuSubmenu>
        <MenuGroup>
          <MenuSwitchItem checked={holdToRecord} onCheckedChange={(on: boolean) => onHoldToRecord(on)} closeOnClick={false}>
            Hold to record
          </MenuSwitchItem>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

/** Auto, then every language, narrowed by what is typed (its English or its own name, or its code). */
function LanguageList({ language, onLanguage }: { language: string; onLanguage(code: string): void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = DICTATION_LANGUAGES.filter((l) => !q || l.label.toLowerCase().includes(q) || l.native.toLowerCase().includes(q) || l.code === q);
  return (
    <>
      <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5">
        <Icon icon={Search} size="sm" className="shrink-0 text-fg-muted" />
        <input
          autoFocus
          value={query}
          aria-label="Search languages"
          placeholder="Search languages"
          onChange={(e) => setQuery(e.target.value)}
          // Typing is for the search, not the menu's jump-to-item.
          onKeyDown={(e) => {
            if (e.key !== 'Escape' && e.key !== 'Tab' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') e.stopPropagation();
          }}
          className="h-7 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-muted"
        />
      </div>
      <div className="max-h-80 overflow-y-auto">
        <MenuRadioGroup value={language} onValueChange={(code: string) => onLanguage(code)}>
          {/* Picking one closes the menu, as a language is picked once. */}
          {(!q || 'auto'.includes(q)) && (
            <MenuRadioItem value="auto" closeOnClick>
              Auto
            </MenuRadioItem>
          )}
          {shown.map((l) => (
            <MenuRadioItem key={l.code} value={l.code} closeOnClick>
              {l.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {shown.length === 0 && !'auto'.includes(q) && <p className="px-2.5 py-2 text-footnote text-fg-muted">No language by that name.</p>}
      </div>
    </>
  );
}
