/**
 * Settings › Keyboard shortcuts: each changeable shortcut with its keys, Change (records the next key combination),
 * Turn off and Reset; Reset all. Only changes are stored (`prefs.shortcuts`); the defaults are `SHORTCUTS`'.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import { bindingOf, bindingProblem, SHORTCUTS, type ShortcutBindings, type ShortcutId, type ShortcutInfo } from '@atelier/protocol';
import { Button, Kbd } from '../../components/ui/index.ts';
import { FIXED_SHORTCUTS, shortcutsHere } from '../../app/shortcuts-dialog.tsx';
import { desktop, isMac } from '../../lib/platform.ts';
import { usePrefs, useResetPref, useSetPref } from '../../lib/queries.ts';
import { keysOf, useShortcutBindings } from '../../lib/shortcuts.ts';
import { describeError } from '../../lib/rpc.ts';
import { SettingsSection } from './setting-row.tsx';

const ROW = 'flex min-h-14 items-center gap-4 border-b border-line-subtle py-3 last:border-b-0 max-md:flex-wrap';

/** All of them off: the native menu mustn't act on the keys while a new shortcut is being recorded. */
const NONE = Object.fromEntries(SHORTCUTS.map((s) => [s.id, null])) as ShortcutBindings;

export function ShortcutsPage() {
  const bindings = useShortcutBindings();
  const { prefs } = usePrefs();
  const setPref = useSetPref();
  const resetPref = useResetPref();
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<{ id: ShortcutId; message: string } | null>(null);
  // A server older than this page sends no `shortcuts` at all.
  const changed = (id: ShortcutId) => prefs?.shortcuts?.[id] !== undefined;
  const anyChanged = SHORTCUTS.some((s) => changed(s.id));

  // While one is recorded the menu lets go of its keys; it gets them back after.
  useEffect(() => {
    if (!recording) return;
    desktop?.setShortcuts?.(NONE);
    return () => desktop?.setShortcuts?.(bindings);
  }, [recording, bindings]);

  const write = (id: ShortcutId, run: () => Promise<unknown>) => {
    setError(null);
    run().catch((e: unknown) => setError({ id, message: describeError(e).message }));
  };
  const save = (info: ShortcutInfo, binding: string | null) =>
    write(info.id, () =>
      // The default again is no change at all, so a later default reaches it.
      binding === info.binding ? resetPref.mutateAsync({ path: ['shortcuts', info.id] }) : setPref.mutateAsync({ path: ['shortcuts', info.id], value: binding }),
    );

  const row = (info: ShortcutInfo) => (
    <ShortcutRow
      key={info.id}
      info={info}
      binding={bindings[info.id]}
      changed={changed(info.id)}
      recording={recording === info.id}
      error={error?.id === info.id ? error.message : null}
      onRecord={() => {
        setError(null);
        setRecording(info.id);
      }}
      onPress={(binding) => {
        const problem = bindingProblem(info.id, binding, bindings, isMac);
        if (problem) return setError({ id: info.id, message: problem });
        setRecording(null);
        save(info, binding);
      }}
      onCancel={() => {
        setError(null);
        setRecording(null);
      }}
      onTurnOff={() => save(info, null)}
      onReset={() => write(info.id, () => resetPref.mutateAsync({ path: ['shortcuts', info.id] }))}
    />
  );
  const here = shortcutsHere();

  return (
    <>
      <SettingsSection
        id="shortcuts.app"
        title="App"
        action={
          <Button size="sm" variant="ghost" disabled={!anyChanged} onClick={() => write(SHORTCUTS[0]!.id, () => resetPref.mutateAsync({ path: ['shortcuts'] }))}>
            Reset all
          </Button>
        }
      >
        {here.filter((s) => s.group === 'App').map(row)}
      </SettingsSection>
      <SettingsSection id="shortcuts.messageBox" title="Message box" description="Send, new line, stop, / and @ always work the same, so typing keeps working.">
        {here.filter((s) => s.group === 'Message box').map(row)}
        {FIXED_SHORTCUTS.map(([label, keys]) => (
          <div key={label} role="group" aria-label={label} className={ROW}>
            <span className="min-w-0 flex-1 text-body text-fg-secondary">{label}</span>
            <Keys keys={keys} />
          </div>
        ))}
      </SettingsSection>
    </>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex gap-1">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

function ShortcutRow({
  info,
  binding,
  changed,
  recording,
  error,
  onRecord,
  onPress,
  onCancel,
  onTurnOff,
  onReset,
}: {
  info: ShortcutInfo;
  binding: string | null;
  changed: boolean;
  recording: boolean;
  error: string | null;
  onRecord(): void;
  /** A key combination was pressed while recording. */
  onPress(binding: string): void;
  onCancel(): void;
  onTurnOff(): void;
  onReset(): void;
}) {
  const labelId = `shortcut-${info.id}`;
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    // Nothing else hears the keys meanwhile: not the app's shortcuts, not the dialog's Esc.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return onCancel();
    const pressed = bindingOf(e, isMac);
    if (pressed) onPress(pressed);
  };
  return (
    <div role="group" aria-labelledby={labelId} className={ROW}>
      <div className="min-w-0 flex-1">
        <span id={labelId} className="text-body text-fg">
          {info.label}
        </span>
        {changed && binding !== null && <p className="mt-1 text-body text-fg-muted">Default: {keysOf(info.binding).join(' ')}</p>}
        {error && (
          <p role="alert" className="mt-1 text-body text-danger-text">
            {error}
          </p>
        )}
      </div>
      {recording ? (
        <span className="flex items-center gap-2">
          <button
            type="button"
            // The keys go here: it takes the focus as recording starts.
            autoFocus
            aria-labelledby={labelId}
            aria-describedby={`${labelId}-hint`}
            onKeyDown={onKeyDown}
            onBlur={onCancel}
            className="flex h-7 items-center rounded-md px-2.5 text-body text-fg-secondary outline-none inset-ring inset-ring-interactive focus-ring"
          >
            <span id={`${labelId}-hint`}>Press the new shortcut</span>
          </button>
          <Button size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>
            Cancel
          </Button>
        </span>
      ) : (
        <span className="flex items-center gap-2">
          {binding ? <Keys keys={keysOf(binding)} /> : <span className="text-body text-fg-muted">Off</span>}
          <Button size="sm" aria-label={`Change the shortcut for ${info.label}`} onClick={onRecord}>
            Change
          </Button>
          {binding && (
            <Button size="sm" variant="ghost" aria-label={`Turn off the shortcut for ${info.label}`} onClick={onTurnOff}>
              Turn off
            </Button>
          )}
          {changed && (
            <Button size="sm" variant="ghost" aria-label={`Reset the shortcut for ${info.label}`} onClick={onReset}>
              Reset
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
