import { useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { CircleAlert, Cloud, RefreshCw, Server } from 'lucide-react';
import type { DetectedProvider, Settings, SettingsSnapshot } from '@atelier/protocol';
import { Button, Icon, Spinner, toast } from '../../components/ui/index.ts';
import { BrandMark } from '../../components/brand-mark.tsx';
import { keys, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { formFromDetected, toDraft } from '../settings/provider-form.ts';
import { useDetectedProviders } from '../settings/provider-queries.ts';
import { ProviderWizard, plural, useProviderWizard } from '../settings/provider-wizard.tsx';
import { detectedWhere } from '../settings/providers-page.tsx';

/**
 * First run (no providers configured): scan for local servers and API keys, connect one in a click
 * or add one by hand. Once a provider is saved, the home page shows the composer again.
 */
export function Onboarding() {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const { data: detected, isFetching, refetch } = useDetectedProviders();
  const wizard = useProviderWizard();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});

  /** Tests first, so a provider that can't serve a reply is never saved; then saves and picks a default model. */
  const connect = async (d: DetectedProvider) => {
    const key = keyOf(d);
    setConnecting(key);
    setFailures(({ [key]: _, ...rest }) => rest);
    try {
      const draft = toDraft(formFromDetected(d, new Set(settings?.providers.map((p) => p.id))));
      const { status } = await rpc().call('providers.test', draft);
      if (!status.ok) throw new Error(status.error ?? `Could not reach ${d.label}.`);
      if (!status.modelCount) throw new Error(`${d.label} is running but has no models yet.${d.type === 'ollama' ? ' Pull one, for example with “ollama pull qwen3”, then try again.' : ''}`);
      await rpc().call('providers.save', draft);
      toast.success(`Connected ${d.label} · ${plural(status.modelCount, 'model')}`);
      await chooseDefaultModel(qc, draft.id);
    } catch (e) {
      setFailures((f) => ({ ...f, [key]: describeError(e).message }));
    } finally {
      setConnecting(null);
    }
  };

  return (
    <>
      <div className="app-drag h-(--at-layout-header-height) shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-[14vh]">
        <div className="w-full max-w-[560px]">
          <h1 className="flex items-center gap-3 font-chat text-greeting text-fg">
            <BrandMark className="size-9" />
            Welcome to Atelier
          </h1>
          <p className="mt-3 text-body text-fg-secondary">
            Connect a model provider to start chatting: a local server such as Ollama, or an API key for Anthropic or OpenAI.
          </p>
          <div aria-live="polite" className="mt-8 rounded-2xl bg-raised px-4 inset-ring inset-ring-line">
            {!detected ? (
              <p className="flex h-14 items-center gap-3 text-body text-fg-muted">
                <Spinner />
                Looking for providers on this machine…
              </p>
            ) : detected.length === 0 ? (
              <p className="py-4 text-body text-fg-muted">
                Nothing found on the usual ports (Ollama 11434, llama.cpp 8080, LM Studio 1234), and no ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment.
              </p>
            ) : (
              detected.map((d) => {
                const key = keyOf(d);
                return (
                  <div key={key} className="flex items-center gap-3 border-b border-line-subtle py-3 last:border-b-0">
                    <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg text-fg-secondary inset-ring inset-ring-line">
                      <Icon icon={d.via === 'env' ? Cloud : Server} size="md" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-body-strong text-fg">{d.label}</p>
                      <p className="truncate text-footnote text-fg-muted">{detectedWhere(d)}</p>
                      {failures[key] && (
                        <p className="mt-1 flex items-start gap-1.5 text-footnote text-danger-text">
                          <Icon icon={CircleAlert} className="mt-px size-3.5" />
                          <span>
                            {failures[key]}{' '}
                            <button
                              type="button"
                              onClick={() => wizard.open({ detected: d })}
                              className="text-interactive-text underline-offset-2 outline-none hover:underline focus-ring"
                            >
                              Edit details
                            </button>
                          </span>
                        </p>
                      )}
                    </div>
                    <Button variant="primary" size="sm" loading={connecting === key} disabled={connecting !== null && connecting !== key} onClick={() => void connect(d)}>
                      Connect
                    </Button>
                  </div>
                );
              })
            )}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button onClick={() => wizard.open()}>Add manually</Button>
            <Button
              variant="ghost"
              leadingIcon={RefreshCw}
              loading={isFetching && !!detected}
              onClick={() => {
                setFailures({});
                void refetch();
              }}
            >
              Scan again
            </Button>
          </div>
        </div>
      </div>
      <ProviderWizard key={wizard.key} {...wizard.props} onSaved={(config) => void chooseDefaultModel(qc, config.id)} />
    </>
  );
}

function keyOf(d: DetectedProvider): string {
  return `${d.type}|${d.baseUrl}|${d.envVar ?? ''}`;
}

/** Points the chat default at the new provider's first model, unless a default is already set. */
async function chooseDefaultModel(qc: QueryClient, providerId: string): Promise<void> {
  const settings = qc.getQueryData<SettingsSnapshot>(keys.settings)?.effective as Settings | undefined;
  if (settings?.models.defaults.chat) return;
  try {
    const first = (await rpc().call('models.list', {})).find((m) => m.providerId === providerId && !m.hidden);
    if (first) await rpc().call('settings.set', { layer: 'global', path: ['models', 'defaults', 'chat'], value: first.ref });
  } catch (e) {
    toast.error(describeError(e).message);
  }
}
