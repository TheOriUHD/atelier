/**
 * Add or edit a decision service (Settings › Admin › Decision models): pick TypeSafe Jev, Decision Models or another
 * System One server, fill in its address and key, test it, save it. The key goes to the backend only with
 * `decisions.testService` / `.saveService`; it is stored there and only ever comes back as a masked tail.
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CircleAlert, CircleCheck, Cloud, Server } from 'lucide-react';
import { DECISION_SERVICE_PRESETS, type DecisionServiceConfig, type DecisionServiceDraft, type DecisionServicePreset, type DecisionServiceTest } from '@atelier/protocol';
import { Button, Dialog, DialogClose, DialogContent, Field, Icon, Spinner, TextField, cn, toast } from '../../components/ui/index.ts';
import { openExternal } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { keyHint } from './provider-form.ts';
import { useSecrets } from './provider-queries.ts';
import { SecretField } from './secret-field.tsx';

const CUSTOM = DECISION_SERVICE_PRESETS.find((p) => p.key === 'custom')!;

/** The preset a saved service came from; one added another way counts as "another System One server". */
export function presetOf(config: Pick<DecisionServiceConfig, 'preset'>): DecisionServicePreset {
  return DECISION_SERVICE_PRESETS.find((p) => p.key === config.preset) ?? CUSTOM;
}

export interface ServiceForm {
  preset: DecisionServicePreset;
  name: string;
  baseUrl: string;
  /** A new key; empty keeps the saved one. */
  apiKey: string;
  /** Comma-separated. */
  models: string;
}

export const newServiceForm = (preset: DecisionServicePreset): ServiceForm => ({ preset, name: preset.key === 'custom' ? '' : preset.name, baseUrl: preset.baseUrl, apiKey: '', models: preset.models?.join(', ') ?? '' });

export const serviceFormFrom = (config: DecisionServiceConfig): ServiceForm => ({ preset: presetOf(config), name: config.name, baseUrl: config.baseUrl, apiKey: '', models: config.models?.join(', ') ?? '' });

/** "a, b , ,c" → ["a", "b", "c"], each once. */
export function parseModels(text: string): string[] {
  return [...new Set(text.split(',').map((m) => m.trim()).filter(Boolean))];
}

/** The address as the backend wants it: no trailing slash, no `/v1`. */
export const normalizeAddress = (url: string): string => url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');

function isWebAddress(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateServiceForm(form: ServiceForm): { name?: string; baseUrl?: string; models?: string } {
  const errors: { name?: string; baseUrl?: string; models?: string } = {};
  if (!form.name.trim()) errors.name = 'Give it a name.';
  else if (form.name.trim().length > 80) errors.name = 'Up to 80 characters.';
  if (!isWebAddress(normalizeAddress(form.baseUrl))) errors.baseUrl = 'Enter its address, such as https://api.example.com.';
  const models = parseModels(form.models);
  if (models.length > 50) errors.models = 'Up to 50 models.';
  else if (models.some((m) => m.length > 200)) errors.models = 'A model’s name is up to 200 characters.';
  return errors;
}

/** What the backend gets: the id of the one being edited, and a key only when one was typed. */
export function toServiceDraft(form: ServiceForm, existing?: DecisionServiceConfig): DecisionServiceDraft {
  const models = parseModels(form.models);
  return {
    ...(existing ? { id: existing.id } : {}),
    name: form.name.trim(),
    type: existing?.type ?? form.preset.type,
    baseUrl: normalizeAddress(form.baseUrl),
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    ...(models.length ? { models } : {}),
    preset: existing?.preset ?? form.preset.key,
  };
}

/** "It answered in 84 ms. Models: s1-fast, s1-pro." or why it didn't. */
export function testSummary(test: DecisionServiceTest): string {
  if (!test.ok) return test.error ?? 'It didn’t answer.';
  const time = test.ms != null ? `It answered in ${Math.round(test.ms)} ms.` : 'It answered.';
  if (!test.models.length) return `${time} It lists no models: type the ones to use.`;
  return `${time} ${test.models.length === 1 ? 'Model' : 'Models'}: ${test.models.join(', ')}.`;
}

export type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'failed'; message: string } | { state: 'done'; result: DecisionServiceTest };

export function TestOutcome({ test }: { test: TestState }) {
  return (
    <div aria-live="polite">
      {test.state === 'testing' && (
        <p className="mt-4 flex items-center gap-2 text-body text-fg-muted">
          <Spinner />
          Testing…
        </p>
      )}
      {(test.state === 'failed' || test.state === 'done') && (
        <Outcome ok={test.state === 'done' && test.result.ok}>{test.state === 'failed' ? test.message : testSummary(test.result)}</Outcome>
      )}
    </div>
  );
}

function Outcome({ ok, children }: { ok: boolean; children: string }) {
  return (
    <p className={cn('mt-4 flex items-start gap-2 text-body', ok ? 'text-success-text' : 'text-danger-text')}>
      <Icon icon={ok ? CircleCheck : CircleAlert} className="mt-0.5" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

export interface DecisionServiceDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Edit this service instead of adding one. */
  existing?: DecisionServiceConfig | undefined;
}

export function DecisionServiceDialog({ open, onOpenChange, existing }: DecisionServiceDialogProps) {
  const qc = useQueryClient();
  const { data: secrets } = useSecrets();
  const [form, setForm] = useState<ServiceForm | null>(() => (existing ? serviceFormFrom(existing) : null));
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A test of a form that has changed since says nothing about it.
  const run = useRef(0);

  const stored = keyHint(existing?.apiKey, secrets);
  const errors = form ? validateServiceForm(form) : {};
  const valid = Object.keys(errors).length === 0;
  const shown = attempted ? errors : {};

  const update = (patch: Partial<ServiceForm>) => {
    run.current++;
    setForm((f) => f && { ...f, ...patch });
    setTest({ state: 'idle' });
    setSaveError(null);
  };

  const runTest = async () => {
    setAttempted(true);
    if (!form || !valid) return;
    const id = ++run.current;
    setTest({ state: 'testing' });
    try {
      const result = await rpc().call('decisions.testService', toServiceDraft(form, existing));
      if (id === run.current) setTest({ state: 'done', result });
    } catch (e) {
      if (id === run.current) setTest({ state: 'failed', message: describeError(e).message });
    }
  };

  const save = async () => {
    setAttempted(true);
    if (!form || !valid) return;
    setSaving(true);
    setSaveError(null);
    try {
      const status = await rpc().call('decisions.saveService', toServiceDraft(form, existing));
      qc.setQueryData(keys.decisions, status);
      void qc.invalidateQueries({ queryKey: keys.settings });
      void qc.invalidateQueries({ queryKey: keys.secrets });
      toast.success(existing ? `Saved ${form.name.trim()}` : `Added ${form.name.trim()}`);
      onOpenChange(false);
    } catch (e) {
      setSaveError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={existing ? `Edit ${existing.name}` : form ? `Add ${form.preset.name}` : 'Add decision service'}
        description={form ? undefined : 'Choose the service that answers. Decision models of the providers set up already need none of this.'}
      >
        {!form ? (
          <div className="-mx-2 flex flex-col">
            {DECISION_SERVICE_PRESETS.map((preset) => (
              <PresetChoice key={preset.key} preset={preset} onChoose={() => setForm(newServiceForm(preset))} />
            ))}
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="flex flex-col gap-4">
              <p className="text-body text-fg-secondary">{form.preset.help}</p>
              <Field label="Name" error={shown.name}>
                <TextField autoFocus value={form.name} onChange={(e) => update({ name: e.target.value })} />
              </Field>
              <Field label="Address" description="Without /v1." error={shown.baseUrl}>
                <TextField value={form.baseUrl} inputMode="url" spellCheck={false} placeholder="https://decisions.example.com" onChange={(e) => update({ baseUrl: e.target.value })} />
              </Field>
              <Field label="API key" description={<KeyHelp preset={form.preset} stored={!!stored} />}>
                <SecretField value={form.apiKey} onValueChange={(apiKey) => update({ apiKey })} stored={stored} placeholder={form.preset.keyUrl ? 'Paste your API key' : 'Optional'} />
              </Field>
              <Field label="Models" description="Optional, separated by commas. Left empty, the service lists its own." error={shown.models}>
                <TextField value={form.models} spellCheck={false} placeholder="Asked of the service" className="font-mono" onChange={(e) => update({ models: e.target.value })} />
              </Field>
            </div>
            <TestOutcome test={test} />
            {saveError && (
              <p role="alert" className="mt-4 text-body text-danger-text">
                {saveError}
              </p>
            )}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button loading={test.state === 'testing'} onClick={() => void runTest()}>
                Test
              </Button>
              <div className="ml-auto flex items-center gap-3">
                {!existing && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      update({});
                      setForm(null);
                      setAttempted(false);
                    }}
                  >
                    Back
                  </Button>
                )}
                <DialogClose render={<Button />}>Cancel</DialogClose>
                <Button type="submit" variant="primary" loading={saving}>
                  {existing ? 'Save' : 'Add service'}
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PresetChoice({ preset, onChoose }: { preset: DecisionServicePreset; onChoose(): void }) {
  return (
    <button type="button" onClick={onChoose} className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left outline-none focus-ring hover:bg-fill-ghost-hover">
      <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg text-fg-secondary inset-ring inset-ring-line">
        <Icon icon={preset.key === 'custom' ? Server : Cloud} size="md" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-strong text-fg">{preset.name}</span>
        <span className="block text-footnote text-fg-muted">{preset.help}</span>
      </span>
      <Icon icon={ChevronRight} className="shrink-0 text-fg-muted" />
    </button>
  );
}

/** Where the key is kept, that a saved one stays, and where to get one. */
function KeyHelp({ preset, stored }: { preset: DecisionServicePreset; stored: boolean }) {
  return (
    <>
      {stored ? 'The saved key stays unless you replace it.' : 'Stored encrypted by Atelier, never in settings files.'}
      {preset.keyUrl && (
        <>
          {' '}
          <button type="button" onClick={() => openExternal(preset.keyUrl!)} className="rounded-xs text-interactive-text outline-none focus-ring hover:underline">
            Get a key
          </button>
        </>
      )}
    </>
  );
}
