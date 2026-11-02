import { useState } from 'react';
import { ImageModelOverride, ImageTuning, type ImageModelInfo } from '@atelier/protocol';
import { Button, Dialog, DialogClose, DialogContent, DialogFooter, Field, Select, TextArea, TextField, type SelectOption } from '../../components/ui/index.ts';
import { useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

/** Select value for "what the model does by itself". */
const AUTO = 'auto';

interface Form {
  displayName: string;
  description: string;
  steps: string;
  guidance: string;
  sampler: string;
  scheduler: string;
}

function toForm(o: ImageModelOverride): Form {
  return {
    displayName: o.displayName ?? '',
    description: o.description ?? '',
    steps: o.tuning?.steps?.toString() ?? '',
    guidance: o.tuning?.guidance?.toString() ?? '',
    sampler: o.tuning?.sampler ?? AUTO,
    scheduler: o.tuning?.scheduler ?? AUTO,
  };
}

/** The tuning as typed, with what's left empty gone, so the model's own setting applies. */
function tuningOf(f: Form): Record<string, unknown> {
  const tuning: Record<string, unknown> = {};
  if (f.steps.trim()) tuning.steps = Number(f.steps);
  if (f.guidance.trim()) tuning.guidance = Number(f.guidance);
  if (f.sampler.trim() && f.sampler !== AUTO) tuning.sampler = f.sampler.trim();
  if (f.scheduler.trim() && f.scheduler !== AUTO) tuning.scheduler = f.scheduler.trim();
  return tuning;
}

export interface ImageModelDialogProps {
  model: ImageModelInfo;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** What an admin says about an image model. Each changed field writes (or deletes) its own settings path. */
export function ImageModelDialog({ model, open, onOpenChange }: ImageModelDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={model.displayName} description="Empty fields keep what Atelier detected.">
        <ImageModelForm model={model} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ImageModelForm({ model, onDone }: { model: ImageModelInfo; onDone(): void }) {
  const { settings } = useSettings();
  const current = settings?.imageModels.overrides[model.ref] ?? {};
  const [form, setForm] = useState(() => toForm(current));
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const caps = model.capabilities;

  const field = (key: keyof Form) => ({ value: form[key], onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })) });
  /** The model's own value as a hint, unless an override hides it. */
  const detected = (key: 'steps' | 'guidance') => (current.tuning?.[key] === undefined && caps.defaults?.[key] !== undefined ? String(caps.defaults[key]) : 'Automatic');

  const save = async () => {
    const tuning = ImageTuning.safeParse(tuningOf(form));
    if (!tuning.success) return setInvalid(new Set(tuning.error.issues.map((i) => String(i.path[0]))));
    setInvalid(new Set());
    setSaving(true);
    setError(null);
    const next: ImageModelOverride = {
      ...(form.displayName.trim() ? { displayName: form.displayName.trim() } : {}),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      ...(Object.keys(tuning.data).length ? { tuning: tuning.data } : {}),
    };
    try {
      for (const key of ['displayName', 'description', 'tuning'] as const) {
        if (JSON.stringify(next[key]) === JSON.stringify(current[key])) continue;
        const path = ['imageModels', 'overrides', model.ref, key];
        if (next[key] === undefined) await rpc().call('settings.reset', { layer: 'global', path });
        else await rpc().call('settings.set', { layer: 'global', path, value: next[key] });
      }
      onDone();
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4"
    >
      <Field label="Name">
        <TextField placeholder={model.modelId} maxLength={100} {...field('displayName')} />
      </Field>
      <Field label="What it’s good at" description="The text model reads this when it chooses a model.">
        <TextArea rows={2} maxLength={200} placeholder="Photos of people, fast drafts, posters with text…" {...field('description')} />
      </Field>
      {caps.tunable && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-4 max-md:grid-cols-1">
          <Field label="Steps" error={invalid.has('steps') ? 'Enter a whole number from 1 to 200.' : undefined}>
            <TextField inputMode="numeric" placeholder={detected('steps')} {...field('steps')} />
          </Field>
          <Field label="Guidance" error={invalid.has('guidance') ? 'Enter a number from 0 to 50.' : undefined}>
            <TextField inputMode="decimal" placeholder={detected('guidance')} {...field('guidance')} />
          </Field>
          <Choice label="Sampler" choices={caps.samplers} own={current.tuning?.sampler ? undefined : caps.defaults?.sampler} value={form.sampler} onChange={(sampler) => setForm((f) => ({ ...f, sampler }))} />
          <Choice label="Scheduler" choices={caps.schedulers} own={current.tuning?.scheduler ? undefined : caps.defaults?.scheduler} value={form.scheduler} onChange={(scheduler) => setForm((f) => ({ ...f, scheduler }))} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-body text-danger-text">
          {error}
        </p>
      )}
      <DialogFooter className="mt-2">
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" loading={saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The model's own list where it has one; otherwise a name typed in. */
function Choice({ label, choices, own, value, onChange }: { label: string; choices: readonly string[] | undefined; own: string | undefined; value: string; onChange(value: string): void }) {
  if (!choices?.length) {
    return (
      <Field label={label}>
        <TextField spellCheck={false} placeholder={own ?? 'Automatic'} value={value === AUTO ? '' : value} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }
  const options: SelectOption[] = [{ value: AUTO, label: own ? `Automatic (${own})` : 'Automatic' }, ...choices.map((c) => ({ value: c, label: c }))];
  if (value !== AUTO && !choices.includes(value)) options.push({ value, label: value });
  return (
    <Field label={label}>
      <Select variant="field" options={options} value={value} onValueChange={onChange} />
    </Field>
  );
}
