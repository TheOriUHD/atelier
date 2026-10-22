import { useState } from 'react';
import { Button, TextArea, cn } from '../../components/ui/index.ts';

/**
 * Instructions every session reads (the system AGENTS.md, the administrator's instructions): edited as a draft and
 * saved explicitly, with a character count against the backend's limit. `onSave` resolves to false when it failed.
 */
export function InstructionsField({
  label,
  saved,
  max,
  disabled = false,
  placeholder,
  monospace = false,
  onSave,
}: {
  label: { 'aria-labelledby': string };
  saved: string;
  max: number;
  disabled?: boolean;
  placeholder: string;
  monospace?: boolean;
  onSave(value: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const tooLong = value.length > max;

  const save = async () => {
    setSaving(true);
    if (await onSave(value)) setDraft(null);
    setSaving(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <TextArea
        {...label}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        invalid={tooLong}
        rows={monospace ? 12 : 8}
        spellCheck={!monospace}
        placeholder={placeholder}
        className={cn(monospace && 'font-mono text-code')}
      />
      <div className="flex items-center gap-2">
        <span className={cn('flex-1 text-footnote tabular-nums', tooLong ? 'text-danger-text' : 'text-fg-muted')}>
          {value.length.toLocaleString('en')} / {max.toLocaleString('en')} characters{dirty && ' · Unsaved changes'}
        </span>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </Button>
        )}
        <Button variant="primary" disabled={!dirty || tooLong} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
