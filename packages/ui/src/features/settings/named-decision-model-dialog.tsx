/**
 * Settings › Admin › Decision models: a model of a provider set up already, named by hand. For a server that can't say
 * which of its models decide (an older listing, an OpenAI-compatible server elsewhere), or to use one that Automatic
 * wouldn't pick. Try asks it a yes-or-no question first, so a server without decision models says so before it's used.
 */
import { useMemo, useState } from 'react';
import type { DecisionStatus } from '@atelier/protocol';
import { Button, Dialog, DialogClose, DialogContent, Field, Select, TextField, cn } from '../../components/ui/index.ts';
import { useModels } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

type Outcome = { state: 'idle' } | { state: 'trying' } | { state: 'ok'; ms: number } | { state: 'failed'; message: string };

export function NamedDecisionModelDialog({
  open,
  onOpenChange,
  providers,
  onUse,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  providers: NonNullable<DecisionStatus['providers']>;
  onUse(source: string): Promise<void>;
}) {
  const [provider, setProvider] = useState(providers[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const { data: models } = useModels();
  // The provider's models as it lists them, those matching what is typed first: a decision model is often among them.
  const suggestions = useMemo(() => {
    const mine = (models ?? []).filter((m) => m.providerId === provider).map((m) => m.modelId);
    const typed = model.trim().toLowerCase();
    return (typed ? mine.filter((m) => m.toLowerCase().includes(typed) && m !== model.trim()) : mine).slice(0, 8);
  }, [models, provider, model]);
  const source = provider && model.trim() ? `text:${provider}:${model.trim()}` : null;
  const reset = () => setOutcome({ state: 'idle' });

  const tryIt = async () => {
    if (!source) return;
    setOutcome({ state: 'trying' });
    try {
      const result = await rpc().call('decisions.decide', { source, state: 'The sky is blue.', questions: [{ name: 'probe', type: 'yesno', instructions: 'Is this sentence about the sky?' }] });
      setOutcome({ state: 'ok', ms: result.ms });
    } catch (e) {
      setOutcome({ state: 'failed', message: describeError(e).message });
    }
  };

  const use = async () => {
    if (!source) return;
    setSaving(true);
    try {
      await onUse(source);
      onOpenChange(false);
    } catch (e) {
      setOutcome({ state: 'failed', message: describeError(e).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="A model of a provider" description="Name a decision model of a provider set up already, as its server calls it: LM Studio, llama.cpp, Ollama or another OpenAI-compatible server.">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void use();
          }}
        >
          <div className="flex flex-col gap-4">
            <Field label="Provider">
              <Select
                variant="field"
                options={providers.map((p) => ({ value: p.id, label: p.name }))}
                value={provider}
                onValueChange={(v) => {
                  setProvider(v);
                  reset();
                }}
              />
            </Field>
            <Field label="Model" description="Its name on the server, such as nimble or bespokelabs/nimble.">
              <TextField
                autoFocus
                value={model}
                spellCheck={false}
                className="font-mono"
                placeholder="nimble"
                onChange={(e) => {
                  setModel(e.target.value);
                  reset();
                }}
              />
            </Field>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5" aria-label="Models of this provider">
                {suggestions.map((m) => (
                  <Button
                    key={m}
                    size="xs"
                    variant="ghost"
                    className="font-mono"
                    onClick={() => {
                      setModel(m);
                      reset();
                    }}
                  >
                    {m}
                  </Button>
                ))}
              </div>
            )}
            {outcome.state === 'ok' && <p className="text-body text-fg-secondary">It answered in {outcome.ms} ms.</p>}
            {outcome.state === 'failed' && (
              <p role="alert" className={cn('text-body text-danger-text')}>
                {outcome.message}
              </p>
            )}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button disabled={!source} loading={outcome.state === 'trying'} onClick={() => void tryIt()}>
              Try
            </Button>
            <div className="ml-auto flex items-center gap-3">
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" disabled={!source} loading={saving}>
                Use it
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
