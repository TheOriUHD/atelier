import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Cloud, Image as ImageIcon, Plus, Server, X } from 'lucide-react';
import type { ImageModelInfo, ImagePreset, ImageProviderConfig, ImageProviderDraft } from '@atelier/protocol';
import { Button, Dialog, DialogClose, DialogContent, Field, Icon, IconButton, Select, Spinner, Switch, TextField, toast, type SelectOption } from '../../components/ui/index.ts';
import { blobUrl, openExternal } from '../../lib/platform.ts';
import { keys, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { isLocal } from '../auth/screen-lock.ts';
import {
  IMAGE_PRESET_GROUPS,
  gpuPartners,
  hasTypedModels,
  imageFormFromConfig,
  keySources,
  mayCostMoney,
  newImageProviderForm,
  renameImageForm,
  runsLocally,
  toImageDraft,
  validateImageProviderForm,
  type ImageProviderForm,
} from './image-provider-form.ts';
import { keyHint } from './provider-form.ts';
import { detectImageKey, useSecrets } from './provider-queries.ts';
import { TestResult, type TestState } from './provider-wizard.tsx';
import { SecretField } from './secret-field.tsx';

/** Open state for an `ImageProviderWizard`. Each open gets a fresh form via `key`. */
export function useImageProviderWizard() {
  const [state, setState] = useState<{ open: boolean; key: number; existing?: ImageProviderConfig }>({ open: false, key: 0 });
  return {
    key: state.key,
    props: { open: state.open, onOpenChange: (open: boolean) => setState((s) => ({ ...s, open })), ...(state.existing ? { existing: state.existing } : {}) },
    open: (existing?: ImageProviderConfig) => setState((s) => ({ open: true, key: s.key + 1, ...(existing ? { existing } : {}) })),
  };
}

export interface ImageProviderWizardProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Edit this provider instead of adding one. */
  existing?: ImageProviderConfig;
}

const NO_PARTNER = 'none';

/**
 * Add or edit an image provider: choose a service, fill in the details, test it, save. The key goes to the backend only
 * with `imageProviders.test` / `.save`; it is stored there and only ever comes back as a masked tail.
 */
export function ImageProviderWizard({ open, onOpenChange, existing }: ImageProviderWizardProps) {
  const { settings } = useSettings();
  const { data: secrets } = useSecrets();
  const qc = useQueryClient();
  const text = useMemo(() => settings?.providers ?? [], [settings?.providers]);
  // Usage and prices are keyed on the id, so it can't be a text provider's either.
  const taken = useMemo(() => new Set([...text, ...(settings?.imageProviders ?? [])].map((p) => p.id)), [text, settings?.imageProviders]);
  const [form, setForm] = useState<ImageProviderForm | null>(() => (existing ? imageFormFromConfig(existing) : null));
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [tested, setTested] = useState<{ run: number; models: ImageModelInfo[] }>({ run: 0, models: [] });
  // Models the admin hid here, applied once the provider is saved.
  const [hidden, setHidden] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [attempted, setAttempted] = useState(false);
  // From the moment it is being saved its id can be among the taken ones: that must not read as an error while the dialog closes.
  const [written, setWritten] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Results of a test for a form that has since changed are dropped.
  const run = useRef(0);

  const stored = keyHint(existing?.apiKey, secrets);
  const errors = form ? validateImageProviderForm(form, { taken, editing: !!existing, hasStoredKey: !!stored }) : {};
  const valid = Object.keys(errors).length === 0;
  const shown = attempted && !written && !saving ? errors : {};

  const update = (change: (form: ImageProviderForm) => ImageProviderForm | null) => {
    run.current++;
    setForm((f) => f && change(f));
    setTest({ state: 'idle' });
    setSaveError(null);
  };

  const runTest = async () => {
    setAttempted(true);
    if (!form || !valid) return;
    const id = ++run.current;
    setTest({ state: 'testing' });
    setHidden(new Map());
    try {
      const { status, models } = await rpc().call('imageProviders.test', toImageDraft(form));
      if (id !== run.current) return;
      setTest({ state: 'done', status });
      setTested({ run: id, models });
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
      const config = await rpc().call('imageProviders.save', toImageDraft(form));
      setWritten(true);
      for (const [ref, value] of hidden) await rpc().call('settings.set', { layer: 'global', path: ['imageModels', 'overrides', ref, 'hidden'], value });
      void qc.invalidateQueries({ queryKey: keys.secrets });
      void qc.invalidateQueries({ queryKey: detectImageKey });
      toast.success(existing ? `Saved ${config.name}` : `Added ${config.name}`);
      onOpenChange(false);
    } catch (e) {
      setSaveError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  const partners = form ? gpuPartners(form.baseUrl, text) : [];
  const sources = form ? keySources(form.preset, text) : [];
  const models = test.state === 'done' && test.status.ok ? tested.models : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={existing ? `Edit ${existing.name}` : form ? `Add ${form.preset.label}` : 'Add image provider'} description={form ? undefined : 'Choose the service that makes your images.'}>
        {!form ? (
          <div className="-mx-2 flex flex-col gap-4">
            {IMAGE_PRESET_GROUPS.map(({ group, label, presets }) => (
              <section key={group} aria-label={label}>
                <h3 className="px-2 pb-1 text-footnote text-fg-muted">{label}</h3>
                <div className="grid grid-cols-2 max-md:grid-cols-1">
                  {presets.map((preset) => (
                    <PresetChoice key={preset.id} preset={preset} onChoose={() => setForm(newImageProviderForm(preset, taken))} />
                  ))}
                </div>
              </section>
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
              {form.preset.help && <p className="text-body text-fg-secondary">{form.preset.help}</p>}
              <Field label="Name" error={shown.name}>
                <TextField autoFocus value={form.name} onChange={(e) => update((f) => renameImageForm(f, e.target.value, taken))} />
              </Field>
              <Field label="ID" description={`Models are referenced as ${form.id || 'id'}/model-name.`} error={shown.id} disabled={!!existing}>
                <TextField value={form.id} spellCheck={false} onChange={(e) => update((f) => ({ ...f, id: e.target.value, idEdited: true }))} />
              </Field>
              <Field label="Base URL" error={shown.baseUrl}>
                <TextField value={form.baseUrl} inputMode="url" spellCheck={false} onChange={(e) => update((f) => ({ ...f, baseUrl: e.target.value }))} />
              </Field>
              {form.preset.key !== 'none' && (
                <div className="flex flex-col gap-2">
                  <Field label="API key" description={<KeyHelp preset={form.preset} />} error={shown.apiKey}>
                    <SecretField
                      value={form.apiKey}
                      onValueChange={(apiKey) => update((f) => ({ ...f, apiKey }))}
                      stored={stored}
                      copiedFrom={text.find((p) => p.id === form.keyFrom)?.name}
                      onDropCopy={() => update((f) => ({ ...f, keyFrom: null }))}
                      placeholder={form.preset.key === 'required' ? 'Paste your API key' : 'Optional'}
                      invalid={!!shown.apiKey}
                    />
                  </Field>
                  {!form.keyFrom && sources.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {sources.map((p) => (
                        <Button key={p.id} size="xs" onClick={() => update((f) => ({ ...f, keyFrom: p.id, apiKey: '' }))}>
                          Use the key from {p.name}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {hasTypedModels(form.preset) && <TypedModels form={form} error={shown.models} update={update} />}
              <Field label="Requests at once" error={shown.parallelRequests} description="What the server can take; Atelier queues the rest. Automatic: one at a time on this computer or your network.">
                <TextField inputMode="numeric" placeholder="Automatic" value={form.parallelRequests} onChange={(e) => update((f) => ({ ...f, parallelRequests: e.target.value }))} />
              </Field>
              {runsLocally(form.preset) && <GpuOptions form={form} partners={partners} update={update} />}
            </div>
            <TestResult test={test} />
            {models.length > 0 && !isLocal() && (
              <TestedModels
                models={models}
                isHidden={(m) => hidden.get(m.ref) ?? m.hidden}
                onHiddenChange={(m, value) => setHidden((h) => new Map(h).set(m.ref, value))}
              />
            )}
            {models.length > 0 && <TestImage key={tested.run} draft={toImageDraft(form)} preset={form.preset} models={models} />}
            {saveError && (
              <p role="alert" className="mt-4 text-body text-danger-text">
                {saveError}
              </p>
            )}
            {/* A phone can't fit all four on a line: the group that finishes wraps as one. */}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button loading={test.state === 'testing'} onClick={() => void runTest()}>
                Test connection
              </Button>
              <div className="ml-auto flex items-center gap-3">
                {!existing && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      update(() => null);
                      setAttempted(false);
                    }}
                  >
                    Back
                  </Button>
                )}
                <DialogClose render={<Button />}>Cancel</DialogClose>
                <Button type="submit" variant="primary" loading={saving}>
                  {existing ? 'Save' : 'Add provider'}
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PresetChoice({ preset, onChoose }: { preset: ImagePreset; onChoose(): void }) {
  return (
    <button type="button" onClick={onChoose} className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none focus-ring hover:bg-fill-ghost-hover">
      <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg text-fg-secondary inset-ring inset-ring-line">
        <Icon icon={preset.group === 'local' || preset.group === 'custom' ? Server : Cloud} size="md" />
      </span>
      <span className="min-w-0 flex-1 truncate text-body-strong text-fg">{preset.label}</span>
      <Icon icon={ChevronRight} className="text-fg-muted" />
    </button>
  );
}

/** Where the key is kept, and where to get one. */
function KeyHelp({ preset }: { preset: ImagePreset }) {
  if (preset.key === 'optional') return 'Optional. Only needed if the server asks for one.';
  return (
    <>
      Stored encrypted by Atelier, never in settings files.
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

/** A service that reports no models: the ids to offer, as a small list. */
function TypedModels({ form, error, update }: { form: ImageProviderForm; error: string | undefined; update(change: (form: ImageProviderForm) => ImageProviderForm): void }) {
  const [draft, setDraft] = useState('');
  const azure = form.preset.id === 'azure';
  const add = () => {
    const id = draft.trim();
    if (!id) return;
    if (!form.models.includes(id)) update((f) => ({ ...f, models: [...f.models, id] }));
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2">
      <span id="image-typed-models" className="text-[14px]/[14px] font-medium text-fg">
        {azure ? 'Deployments' : 'Models'}
      </span>
      {form.models.length > 0 && (
        <ul aria-labelledby="image-typed-models" className="flex flex-col gap-1">
          {form.models.map((id) => (
            <li key={id} className="flex items-center gap-2 pl-3">
              <span className="min-w-0 flex-1 truncate font-mono text-code text-fg-secondary">{id}</span>
              <IconButton icon={X} size="xs" label={`Remove ${id}`} onClick={() => update((f) => ({ ...f, models: f.models.filter((m) => m !== id) }))} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <TextField
          aria-label={azure ? 'Deployment name to add' : 'Model id to add'}
          placeholder={azure ? 'Deployment name' : 'Model id'}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Enter adds to the list here; it doesn't save the provider.
            e.preventDefault();
            add();
          }}
          className="flex-1 font-mono"
        />
        <Button leadingIcon={Plus} onClick={add}>
          Add
        </Button>
      </div>
      {error && <p className="text-footnote text-danger-text">{error}</p>}
    </div>
  );
}

function GpuOptions({ form, partners, update }: { form: ImageProviderForm; partners: ReturnType<typeof gpuPartners>; update(change: (form: ImageProviderForm) => ImageProviderForm): void }) {
  const options: SelectOption[] = [{ value: NO_PARTNER, label: 'Nothing else' }, ...partners.map(({ provider }) => ({ value: provider.id, label: provider.name }))];
  if (form.sharesGpuWith && !partners.some((p) => p.provider.id === form.sharesGpuWith)) options.push({ value: form.sharesGpuWith, label: `${form.sharesGpuWith} (unavailable)` });
  return (
    <section aria-label="GPU" className="flex flex-col gap-3 rounded-xl border border-line bg-fill-control p-4">
      {options.length > 1 && (
        <Field label="Shares a GPU with">
          <Select
            variant="field"
            options={options}
            value={form.sharesGpuWith ?? NO_PARTNER}
            onValueChange={(value) => update((f) => ({ ...f, sharesGpuWith: value === NO_PARTNER ? null : value }))}
            renderOption={(o) => (
              <>
                {o.label}
                {partners.some((p) => p.sameHost && p.provider.id === o.value) && <span className="text-fg-muted"> · same computer</span>}
              </>
            )}
          />
        </Field>
      )}
      <div className="flex items-center justify-between gap-3">
        <span id="image-free-after-run" className="text-body text-fg">
          Unload after each image
        </span>
        <Switch aria-labelledby="image-free-after-run" checked={form.freeAfterRun} onCheckedChange={(freeAfterRun) => update((f) => ({ ...f, freeAfterRun }))} />
      </div>
      <p className="text-footnote text-fg-secondary">
        {form.sharesGpuWith ? 'The text model unloads for each image and reloads afterwards, so the next reply starts later.' : 'Unloading frees the GPU for other work, and the next image loads its model again.'}
      </p>
    </section>
  );
}

/** What the test found. On a server an admin can keep some of it from other accounts before anyone sees it. */
function TestedModels({ models, isHidden, onHiddenChange }: { models: ImageModelInfo[]; isHidden(model: ImageModelInfo): boolean; onHiddenChange(model: ImageModelInfo, hidden: boolean): void }) {
  return (
    <section aria-label="Models found" className="mt-4">
      <p className="text-footnote text-fg-muted">Turn off a model to keep it from other accounts. Admins can still use it.</p>
      <ul className="mt-2 flex max-h-48 flex-col overflow-y-auto">
        {models.map((m) => (
          <li key={m.ref} className="flex min-h-8 items-center justify-between gap-3">
            <span className="min-w-0 truncate text-body text-fg">{m.displayName}</span>
            <Switch size="sm" aria-label={`Show ${m.displayName} to everyone`} checked={!isHidden(m)} onCheckedChange={(on) => onHiddenChange(m, !on)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const seconds = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;

type TryState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; image: { blob: string; width: number; height: number; durationMs: number } }
  | { state: 'failed'; message: string };

/** One small real image. It can cost money, so only this button ever asks for it. */
function TestImage({ draft, preset, models }: { draft: ImageProviderDraft; preset: ImagePreset; models: ImageModelInfo[] }) {
  const [modelId, setModelId] = useState(() => (models.find((m) => !m.hidden) ?? models[0]!).modelId);
  const [result, setResult] = useState<TryState>({ state: 'idle' });
  const make = async () => {
    setResult({ state: 'running' });
    try {
      setResult({ state: 'done', image: await rpc().call('imageProviders.tryImage', { draft, modelId }) });
    } catch (e) {
      setResult({ state: 'failed', message: describeError(e).message });
    }
  };
  return (
    <section aria-label="Test image" className="mt-4 flex flex-col gap-3 rounded-xl border border-line bg-fill-control p-4">
      <div className="flex flex-wrap items-end gap-3">
        {models.length > 1 && (
          <Field label="Model" className="min-w-40 flex-1">
            <Select variant="field" options={models.map((m) => ({ value: m.modelId, label: m.displayName }))} value={modelId} onValueChange={setModelId} />
          </Field>
        )}
        <Button leadingIcon={ImageIcon} loading={result.state === 'running'} aria-describedby="image-test-note" onClick={() => void make()}>
          Make a test image
        </Button>
      </div>
      <p id="image-test-note" className="text-footnote text-fg-secondary">
        {mayCostMoney(preset) ? `This is a real request to ${preset.label} and may cost money.` : 'Makes one small image. The first one takes longer while the model loads.'}
      </p>
      <div aria-live="polite">
        {result.state === 'running' && (
          <p className="flex items-center gap-2 text-body text-fg-secondary">
            <Spinner />
            Making an image…
          </p>
        )}
        {result.state === 'failed' && <p className="text-body text-danger-text">{result.message}</p>}
        {result.state === 'done' && (
          <figure>
            <img src={blobUrl(result.image.blob)} alt="What the test made" className="max-h-64 max-w-full rounded-lg" />
            <figcaption className="mt-2 text-footnote text-fg-secondary tabular-nums">
              Made in {seconds(result.image.durationMs)} · {result.image.width}×{result.image.height}
            </figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}
