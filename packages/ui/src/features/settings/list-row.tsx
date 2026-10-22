import { useState } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton, TextField } from '../../components/ui/index.ts';
import type { SettingId } from './search-index.ts';
import { SettingRow } from './setting-row.tsx';
import type { Setting } from './use-setting.ts';

export interface ListRowProps {
  id: SettingId;
  setting: Setting<string[]>;
  /** Why a new entry can't be added, or null. */
  validate(entry: string): string | null;
  /** Accessible name of the add field, e.g. “New allow rule”. */
  fieldLabel: string;
  placeholder: string;
  /** Shown instead of the list while it is empty. */
  empty?: string;
}

/**
 * A setting that holds a list of strings (permission rules, directories): the entries in mono with
 * remove buttons, then a field that adds one. Entries are checked before they are written, and
 * every change writes the whole list.
 */
export function ListRow({ id, setting, validate, fieldLabel, placeholder, empty }: ListRowProps) {
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const entries = setting.value;

  const add = async () => {
    const entry = draft.trim();
    const error = entries.includes(entry) ? 'That is in the list already.' : validate(entry);
    setInvalid(error);
    if (!error && (await setting.set([...entries, entry]))) setDraft('');
  };

  return (
    <SettingRow id={id} setting={setting} error={invalid} stacked>
      {(label) => (
        <div className="flex flex-col gap-2">
          {entries.length > 0 ? (
            <ul {...label} className="rounded-lg border border-line-subtle">
              {entries.map((entry, i) => (
                <li key={`${i}:${entry}`} className="flex h-9 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 last:border-b-0">
                  <span title={entry} className="min-w-0 flex-1 truncate font-mono text-code text-fg">
                    {entry}
                  </span>
                  <IconButton icon={X} size="xs" label={`Remove ${entry}`} onClick={() => void setting.set(entries.filter((_, j) => j !== i))} />
                </li>
              ))}
            </ul>
          ) : (
            empty && <p className="text-body text-fg-muted">{empty}</p>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <TextField
              aria-label={fieldLabel}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setInvalid(null);
              }}
              invalid={!!invalid}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 font-mono"
            />
            <Button type="submit" disabled={!draft.trim()}>
              Add
            </Button>
          </form>
        </div>
      )}
    </SettingRow>
  );
}
