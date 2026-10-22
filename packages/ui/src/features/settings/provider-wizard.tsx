import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CircleAlert, CircleCheck, Cloud, Plus, Server, X } from 'lucide-react';
import {
  PROVIDER_LABELS,
  PROVIDER_PRESETS,
  type DetectedProvider,
  type ProviderConfig,
  type ProviderPreset,
  type ProviderStatus,
  type ProviderType,
} from '@atelier/protocol';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  Icon,
  IconButton,
  Spinner,
  TextField,
  cn,
  toast,
} from '../../components/ui/index.ts';
import { keys, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import {
  PROVIDER_DESCRIPTIONS,
  formFromConfig,
  formFromDetected,
  formLabel,
  formNeedsKey,
  keyHint,
  newPresetForm,
  newProviderForm,
  renameForm,
  toDraft,
  validateProviderForm,
  type ProviderForm,
} from './provider-form.ts';
import { ChatGptChatSignIn, useChatGptChatAvailable } from './chatgpt-chat-sign-in.tsx';
import { ChatGptSignIn, useChatGptStatus } from './chatgpt-sign-in.tsx';
import { CopilotSignIn } from './copilot-sign-in.tsx';
import { OpenRouterConnect, useOpenRouterStatus } from './openrouter-connect.tsx';
import { detectKey, useSecrets } from './provider-queries.ts';
import { SecretField } from './secret-field.tsx';

const TYPES: ProviderType[] = ['ollama', 'llamacpp', 'openai-compatible', 'anthropic', 'openai'];
const HOSTED = new Set<ProviderType>(['anthropic', 'openai', 'chatgpt', 'copilot']);

export interface WizardRequest {
  /** Edit this provider instead of adding one. */
  existing?: ProviderConfig;
  /** Start on the details step, prefilled from an auto-detected provider. */
  detected?: DetectedProvider;
}

/** Open state for a `ProviderWizard`. Each open gets a fresh form via `key`. */
export function useProviderWizard() {
  const [state, setState] = useState({ open: false, key: 0, request: {} as WizardRequest });
  return {
    key: state.key,
    props: { open: state.open, onOpenChange: (open: boolean) => setState((s) => ({ ...s, open })), ...state.request },
    open: (request: WizardRequest = {}) => setState((s) => ({ open: true, key: s.key + 1, request })),
  };
}

export interface ProviderWizardProps extends WizardRequest {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved?(config: ProviderConfig): void;
}

type TestState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'done'; status: ProviderStatus }
  | { state: 'failed'; message: string };

/**
 * Add or edit a provider: choose a type, fill in the details, optionally test the connection, save.
 * The key goes to the backend only with `providers.test` / `providers.save`; it is stored in the
 * secret store there and only ever comes back as a masked tail.
 */
export function ProviderWizard({ open, onOpenChange, existing, detected, onSaved }: ProviderWizardProps) {
  const { settings } = useSettings();
  const { data: secrets } = useSecrets();
  const qc = useQueryClient();
  const taken = useMemo(() => new Set(settings?.providers.map((p) => p.id)), [settings?.providers]);
  const [form, setForm] = useState<ProviderForm | null>(() =>
    existing ? formFromConfig(existing) : detected ? formFromDetected(detected, taken) : null,
  );
  // The ChatGPT subscription has no form: its own step signs in, in the browser on the desktop and with a device code
  // on a server. It is offered where signing in works (both), until it is added.
  const [chatgptStep, setChatgptStep] = useState(false);
  const [chatgptChatStep, setChatgptChatStep] = useState(false);
  const chatgpt = useChatGptStatus(open && !existing && !detected);
  const chatgptChatAvailable = useChatGptChatAvailable(open && !existing && !detected);
  // GitHub Copilot signs in with a code, which works on every backend: it is offered until it is added.
  const [copilotStep, setCopilotStep] = useState(false);
  const has = (type: ProviderType) => !!settings?.providers.some((p) => p.type === type);
  const types: ProviderType[] = [...TYPES, ...(chatgpt.data?.available && !has('chatgpt') ? ['chatgpt' as const] : []), ...(has('copilot') ? [] : ['copilot' as const])];
  if (chatgptChatAvailable && !has('chatgpt-chat')) types.push('chatgpt-chat');
  const step = chatgptChatStep ? 'chatgpt-chat' : chatgptStep ? 'chatgpt' : copilotStep ? 'copilot' : null;
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [attempted, setAttempted] = useState(false);
  // From the moment it is being saved, the provider's id can be among the taken ones (the backend announces it before the
  // save answers): that must not read as an error while it saves and the dialog closes.
  const [written, setWritten] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Results of a test for a form that has since changed are dropped.
  const run = useRef(0);

  const stored = keyHint(existing?.apiKey, secrets);
  const errors = form ? validateProviderForm(form, { taken, editing: !!existing, hasStoredKey: !!stored }) : {};
  const valid = Object.keys(errors).length === 0;
  // Connecting OpenRouter saves the provider in the backend, so the same holds while it runs and once it saved this one.
  const openrouter = useOpenRouterStatus(form?.preset === 'openrouter' && !existing).data;
  const connecting = !!openrouter?.connecting || (!!form && openrouter?.provider?.id === form.id);
  const shown = attempted && !written && !saving && !connecting ? errors : {};

  const update = (change: (form: ProviderForm) => ProviderForm | null) => {
    run.current++;
    setForm((f) => f && change(f));
    setTest({ state: 'idle' });
    setSaveError(null);
  };

  const runTest = async () => {
    setAttempted(true);
    if (!form || !valid) return;
    if (formNeedsKey(form) && !form.apiKey.trim() && !form.apiKeyFromEnv) {
      return setTest({ state: 'failed', message: 'Enter the key again to test it. Saving re-checks the connection with the stored key.' });
    }
    const id = ++run.current;
    setTest({ state: 'testing' });
    try {
      const { status } = await rpc().call('providers.test', toDraft(form));
      if (id === run.current) setTest({ state: 'done', status });
    } catch (e) {
      if (id === run.current) setTest({ state: 'failed', message: describeError(e).message });
    }
  };

  const saved = (config: ProviderConfig) => {
    setWritten(true);
    void qc.invalidateQueries({ queryKey: keys.models });
    void qc.invalidateQueries({ queryKey: keys.providers });
    void qc.invalidateQueries({ queryKey: keys.secrets });
    void qc.invalidateQueries({ queryKey: detectKey });
    toast.success(existing ? `Saved ${config.name}` : `Added ${config.name}`);
    onOpenChange(false);
    onSaved?.(config);
  };

  const save = async () => {
    setAttempted(true);
    if (!form || !valid) return;
    setSaving(true);
    setSaveError(null);
    try {
      saved(await rpc().call('providers.save', toDraft(form)));
    } catch (e) {
      setSaveError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={existing ? `Edit ${existing.name}` : form ? `Add ${formLabel(form)}` : step ? `Add ${PROVIDER_LABELS[step]}` : 'Add provider'}
        description={form || step ? undefined : 'Choose where your models run.'}
      >
        {chatgptChatStep ? <ChatGptChatSignIn onBack={() => setChatgptChatStep(false)} onAdded={(config) => { onOpenChange(false); onSaved?.(config); }} /> : copilotStep ? (
          <CopilotSignIn
            onBack={() => setCopilotStep(false)}
            onAdded={(config) => {
              onOpenChange(false);
              onSaved?.(config);
            }}
          />
        ) : chatgptStep ? (
          <ChatGptSignIn
            onBack={() => setChatgptStep(false)}
            onAdded={(config) => {
              onOpenChange(false);
              onSaved?.(config);
            }}
          />
        ) : !form ? (
          <div className="-mx-2 flex flex-col">
            {types.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => (type === 'chatgpt-chat' ? setChatgptChatStep(true) : type === 'chatgpt' ? setChatgptStep(true) : type === 'copilot' ? setCopilotStep(true) : setForm(newProviderForm(type, taken)))}
                className="flex items-center gap-3 rounded-xl px-2 py-2 text-left outline-none focus-ring hover:bg-fill-ghost-hover"
              >
                <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg text-fg-secondary inset-ring inset-ring-line">
                  <Icon icon={HOSTED.has(type) ? Cloud : Server} size="md" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body-strong text-fg">{PROVIDER_LABELS[type]}</span>
                  <span className="text-footnote text-fg-muted">{PROVIDER_DESCRIPTIONS[type]}</span>
                </span>
                <Icon icon={ChevronRight} className="text-fg-muted" />
              </button>
            ))}
            {PROVIDER_PRESETS.map((preset) => (
              <PresetChoice key={preset.id} preset={preset} onChoose={() => setForm(newPresetForm(preset.id, taken))} />
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
              {form.preset && (
                <PresetIntro
                  form={form}
                  onInvalid={() => setAttempted(true)}
                  connectDraft={Object.keys(errors).every((k) => k === 'apiKey') ? connectDraft(form) : null}
                  onConnected={saved}
                />
              )}
              <Field label="Name" error={shown.name}>
                <TextField autoFocus value={form.name} onChange={(e) => update((f) => renameForm(f, e.target.value, taken))} />
              </Field>
              <Field
                label="ID"
                description={`Models are referenced as ${form.id || 'id'}/model-name.`}
                error={shown.id}
                disabled={!!existing}
              >
                <TextField
                  value={form.id}
                  spellCheck={false}
                  onChange={(e) => update((f) => ({ ...f, id: e.target.value, idEdited: true }))}
                />
              </Field>
              <Field label="Base URL" error={shown.baseUrl}>
                <TextField
                  value={form.baseUrl}
                  inputMode="url"
                  spellCheck={false}
                  onChange={(e) => update((f) => ({ ...f, baseUrl: e.target.value }))}
                />
              </Field>
              <Field
                label="API key"
                description={formNeedsKey(form) ? 'Stored encrypted by Atelier, never in settings files.' : 'Optional. Only needed if the server asks for one.'}
                error={shown.apiKey}
              >
                <SecretField
                  value={form.apiKey}
                  onValueChange={(apiKey) => update((f) => ({ ...f, apiKey }))}
                  stored={stored}
                  envVar={form.apiKeyFromEnv}
                  onDropEnv={() => update(({ apiKeyFromEnv: _, ...f }) => f)}
                  placeholder={formNeedsKey(form) ? 'Paste your API key' : 'Optional'}
                  invalid={!!shown.apiKey}
                />
              </Field>
              <HeadersEditor form={form} error={shown.headers} update={update} />
              {!HOSTED.has(form.type) && !form.preset && (
                <section className="flex flex-col gap-3 rounded-xl border border-line bg-fill-control p-4" aria-label="Memory budget">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-body-strong text-fg">Memory budget</span>
                  <span className="text-footnote text-fg-muted">{form.vramGB.trim() ? `${form.vramGB.trim()} GB available` : 'Server defaults'}</span>
                </div>
                <Field
                  label="Available VRAM (GB)"
                  error={shown.vramGB}
                  description={form.type === 'ollama'
                    ? 'Automatically balances each model’s context against available memory. On Apple Silicon, use available unified memory.'
                    : 'Automatic memory-based context is currently supported for Ollama only. Other servers keep their reported context limits; configure context and GPU memory on the server itself.'}
                >
                  <TextField inputMode="decimal" placeholder="Optional, e.g. 24" value={form.vramGB} onChange={(e) => update((f) => ({ ...f, vramGB: e.target.value }))} />
                </Field>
                <details className="text-footnote text-fg-muted">
                  <summary className="cursor-pointer hover:text-fg">How allocation works</summary>
                  <p className="mt-2">Weight size and KV cache determine the estimate, with runtime headroom reserved. Missing metadata keeps the server default. Model-specific context overrides take priority. Saving refreshes the model list; this does not change server concurrency or GPU offloading.</p>
                </details>
                </section>
              )}
              <div className="flex flex-col gap-1.5">
                <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                  <Field label="Requests at once" error={shown.parallelRequests}>
                    <TextField inputMode="numeric" placeholder="Automatic" value={form.parallelRequests} onChange={(e) => update((f) => ({ ...f, parallelRequests: e.target.value }))} />
                  </Field>
                  <Field label="Models at once" error={shown.modelsAtOnce}>
                    <TextField inputMode="numeric" placeholder="Automatic" value={form.modelsAtOnce} onChange={(e) => update((f) => ({ ...f, modelsAtOnce: e.target.value }))} />
                  </Field>
                </div>
                <p className="text-footnote text-fg-muted">
                  What the server’s GPU can take. Atelier queues the rest, lets sub-agents take turns and keeps helper work on the loaded model instead
                  of swapping. Automatic: what the server reports, else one of each on this computer or your network.
                </p>
              </div>
            </div>
            <TestResult test={test} />
            {saveError && (
              <p role="alert" className="mt-4 text-body text-danger-text">
                {saveError}
              </p>
            )}
            <div className="mt-6 flex items-center gap-3">
              <Button loading={test.state === 'testing'} onClick={() => void runTest()}>
                Test connection
              </Button>
              <span className="flex-1" />
              {!existing && !detected && (
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
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PresetChoice({ preset, onChoose }: { preset: ProviderPreset; onChoose(): void }) {
  return (
    <button type="button" onClick={onChoose} className="flex items-center gap-3 rounded-xl px-2 py-2 text-left outline-none focus-ring hover:bg-fill-ghost-hover">
      <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg text-fg-secondary inset-ring inset-ring-line">
        <Icon icon={Cloud} size="md" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-strong text-fg">{preset.name}</span>
        <span className="text-footnote text-fg-muted">{preset.description}</span>
      </span>
      <Icon icon={ChevronRight} className="text-fg-muted" />
    </button>
  );
}

const connectDraft = (form: ProviderForm) => {
  const { apiKey: _key, apiKeyFromEnv: _env, ...draft } = toDraft(form);
  return draft;
};

/** What a preset needs, and OpenRouter's one-click connect. */
function PresetIntro({
  form,
  connectDraft: draft,
  onInvalid,
  onConnected,
}: {
  form: ProviderForm;
  connectDraft: ReturnType<typeof connectDraft> | null;
  onInvalid(): void;
  onConnected(config: ProviderConfig): void;
}) {
  if (form.preset === 'opencode-zen') {
    return (
      <p className="text-body text-fg-secondary">
        Needs an OpenCode Console key from opencode.ai, where billing may be required. Its free models may only work inside OpenCode itself.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-fg-secondary">
        Connect your OpenRouter account and it creates a key for Atelier, or paste a key from openrouter.ai/keys below. Models marked free cost
        nothing but are limited to 50 requests a day (1,000 once you’ve bought at least 10 credits).
      </p>
      <OpenRouterConnect draft={draft} onInvalid={onInvalid} onConnected={onConnected} />
    </div>
  );
}

function HeadersEditor({
  form,
  error,
  update,
}: {
  form: ProviderForm;
  error: string | undefined;
  update(change: (form: ProviderForm) => ProviderForm): void;
}) {
  const setHeader = (index: number, patch: Partial<ProviderForm['headers'][number]>) =>
    update((f) => ({ ...f, headers: f.headers.map((h, i) => (i === index ? { ...h, ...patch } : h)) }));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-6 items-center justify-between">
        <span className="text-[14px]/[14px] font-medium text-fg">Custom headers</span>
        <Button size="xs" variant="ghost" leadingIcon={Plus} onClick={() => update((f) => ({ ...f, headers: [...f.headers, { name: '', value: '' }] }))}>
          Add header
        </Button>
      </div>
      {form.headers.map((h, i) => (
        <div key={i} className="flex items-center gap-2">
          <TextField aria-label={`Header ${i + 1} name`} placeholder="Name" spellCheck={false} value={h.name} className="w-44" onChange={(e) => setHeader(i, { name: e.target.value })} />
          <TextField aria-label={`Header ${i + 1} value`} placeholder="Value or ${secret:id}" spellCheck={false} value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} />
          <IconButton icon={X} label="Remove header" onClick={() => update((f) => ({ ...f, headers: f.headers.filter((_, j) => j !== i) }))} />
        </div>
      ))}
      {error && <p className="text-footnote text-danger-text">{error}</p>}
    </div>
  );
}

function TestResult({ test }: { test: TestState }) {
  return (
    <div aria-live="polite">
      {test.state === 'testing' && (
        <p className="mt-4 flex items-center gap-2 text-body text-fg-muted">
          <Spinner />
          Testing the connection…
        </p>
      )}
      {test.state === 'failed' && <Outcome ok={false}>{test.message}</Outcome>}
      {test.state === 'done' && (
        <>
          <Outcome ok={test.status.ok}>
            {test.status.ok ? connectedSummary(test.status) : (test.status.error ?? 'Could not connect.')}
          </Outcome>
          {test.status.warnings.map((w) => (
            <p key={w} className="mt-1 pl-6 text-footnote text-warning-text">
              {w}
            </p>
          ))}
        </>
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

/** "Connected · 12 models · 34 ms". */
export function connectedSummary(status: ProviderStatus): string {
  return ['Connected', plural(status.modelCount, 'model'), status.latencyMs != null ? `${Math.round(status.latencyMs)} ms` : null]
    .filter(Boolean)
    .join(' · ');
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
