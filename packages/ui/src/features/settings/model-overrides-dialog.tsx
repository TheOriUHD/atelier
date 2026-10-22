import { useState } from 'react';
import { ModelOverride, type ModelInfo } from '@atelier/protocol';
import { Button, Dialog, DialogClose, DialogContent, DialogFooter, Field, Select, TextField, type SelectOption } from '../../components/ui/index.ts';
import { useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

/** Select value for "use what was detected". */
const AUTO = 'auto';

const TOOL_OPTIONS: SelectOption[] = [
  { value: AUTO, label: 'Automatic' },
  { value: 'native', label: 'Native' },
  { value: 'prompted', label: 'Prompted' },
  { value: 'none', label: 'None' },
];
const VISION_OPTIONS: SelectOption[] = [
  { value: AUTO, label: 'Automatic' },
  { value: 'yes', label: 'Supported' },
  { value: 'no', label: 'Not supported' },
];
const TIER_OPTIONS: SelectOption[] = [
  { value: AUTO, label: 'Automatic' },
  { value: 'full', label: 'Full' },
  { value: 'compact', label: 'Compact' },
];

const FIELDS = ['contextLength', 'maxOutputTokens', 'temperature', 'toolCalling', 'vision', 'promptTier'] as const;
type OverrideField = (typeof FIELDS)[number];
type Form = Record<OverrideField, string>;

const NUMBER_ERRORS: Partial<Record<OverrideField, string>> = {
  contextLength: 'Enter a whole number of tokens.',
  maxOutputTokens: 'Enter a whole number of tokens.',
  temperature: 'Enter a number from 0 to 2.',
};

function toForm(o: ModelOverride): Form {
  return {
    contextLength: o.contextLength?.toString() ?? '',
    maxOutputTokens: o.maxOutputTokens?.toString() ?? '',
    temperature: o.temperature?.toString() ?? '',
    toolCalling: o.toolCalling ?? AUTO,
    vision: o.vision === undefined ? AUTO : o.vision ? 'yes' : 'no',
    promptTier: o.promptTier ?? AUTO,
  };
}

function fromForm(f: Form): Record<OverrideField, unknown> {
  const num = (text: string) => (text.trim() ? Number(text) : undefined);
  const pick = (value: string) => (value === AUTO ? undefined : value);
  return {
    contextLength: num(f.contextLength),
    maxOutputTokens: num(f.maxOutputTokens),
    temperature: num(f.temperature),
    toolCalling: pick(f.toolCalling),
    vision: f.vision === AUTO ? undefined : f.vision === 'yes',
    promptTier: pick(f.promptTier),
  };
}

export interface ModelOverridesDialogProps {
  model: ModelInfo;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** Overrides what was detected about a model. Each changed field writes (or deletes) its own settings path. */
export function ModelOverridesDialog({ model, open, onOpenChange }: ModelOverridesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={model.displayName} description="Override what Atelier detected about this model. Empty fields keep the detected value.">
        <OverridesForm model={model} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function OverridesForm({ model, onDone }: { model: ModelInfo; onDone(): void }) {
  const { settings } = useSettings();
  const current = settings?.models.overrides[model.ref] ?? {};
  const [form, setForm] = useState(() => toForm(current));
  const [invalid, setInvalid] = useState<ReadonlySet<OverrideField>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = (key: OverrideField) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
    invalid: invalid.has(key),
  });
  const choose = (key: OverrideField) => ({ value: form[key], onValueChange: (value: string) => setForm((f) => ({ ...f, [key]: value })) });
  /** The detected value as a hint, unless an override hides it. */
  const detected = (key: OverrideField, value: number) => (current[key] === undefined ? String(value) : 'Automatic');

  const save = async () => {
    const parsed = ModelOverride.safeParse(fromForm(form));
    if (!parsed.success) return setInvalid(new Set(parsed.error.issues.map((i) => i.path[0] as OverrideField)));
    setInvalid(new Set());
    setSaving(true);
    setError(null);
    try {
      for (const key of FIELDS) {
        const value = parsed.data[key];
        if (value === current[key]) continue;
        const path = ['models', 'overrides', model.ref, key];
        if (value === undefined) await rpc().call('settings.reset', { layer: 'global', path });
        else await rpc().call('settings.set', { layer: 'global', path, value });
      }
      onDone();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  const errorFor = (key: OverrideField) => (invalid.has(key) ? NUMBER_ERRORS[key] : undefined);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-3 gap-x-3 gap-y-4">
        <Field label="Context length" error={errorFor('contextLength')}>
          <TextField inputMode="numeric" placeholder={detected('contextLength', model.contextLength)} {...field('contextLength')} />
        </Field>
        <Field label="Max output" error={errorFor('maxOutputTokens')}>
          <TextField inputMode="numeric" placeholder={detected('maxOutputTokens', model.maxOutput)} {...field('maxOutputTokens')} />
        </Field>
        <Field label="Temperature" error={errorFor('temperature')}>
          <TextField inputMode="decimal" placeholder="Default" {...field('temperature')} />
        </Field>
        <Field label="Tool calling">
          <Select variant="field" options={TOOL_OPTIONS} {...choose('toolCalling')} />
        </Field>
        <Field label="Vision">
          <Select variant="field" options={VISION_OPTIONS} {...choose('vision')} />
        </Field>
        <Field label="Prompt tier">
          <Select variant="field" options={TIER_OPTIONS} {...choose('promptTier')} />
        </Field>
      </div>
      <p className="mt-4 text-footnote text-fg-muted">
        Prompted tool calling describes tools in the prompt for models without native support. The compact prompt tier suits smaller local models.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-body text-danger-text">
          {error}
        </p>
      )}
      <DialogFooter>
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" loading={saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
