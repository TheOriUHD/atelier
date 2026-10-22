import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderConfig, ProviderDraft } from '@atelier/protocol';
import { Button, Spinner } from '../../components/ui/index.ts';
import { openExternal } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

type ConnectDraft = Omit<ProviderDraft, 'apiKey' | 'apiKeyFromEnv'>;

/** Connecting OpenRouter in the browser; watched while it is open. */
export function useOpenRouterStatus(enabled = true) {
  return useQuery({
    queryKey: keys.openrouter,
    queryFn: () => rpc().call('openrouter.status', {}),
    enabled,
    refetchInterval: (query) => (query.state.data?.connecting ? 1000 : false),
  });
}

/**
 * "Connect with OpenRouter": OpenRouter's own page creates a key for Atelier and the backend saves the provider with
 * it, so nothing is pasted. `draft` is null while the rest of the form is invalid. Leaving with the page open cancels it.
 */
export function OpenRouterConnect({ draft, onInvalid, onConnected }: { draft: ConnectDraft | null; onInvalid(): void; onConnected(config: ProviderConfig): void }) {
  const qc = useQueryClient();
  const { data } = useOpenRouterStatus();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only a connect started here finishes this form.
  const [started, setStarted] = useState<string | null>(null);
  const waiting = useRef(false);
  const finished = useRef(false);
  const connecting = !!data?.connecting && started !== null;
  useEffect(() => {
    waiting.current = connecting;
  }, [connecting]);

  const connected = useRef(onConnected);
  useEffect(() => {
    connected.current = onConnected;
  });
  useEffect(() => {
    const provider = data?.provider;
    if (!provider || started !== provider.id || data.connecting || finished.current) return;
    finished.current = true;
    connected.current(provider);
  }, [data, started]);

  useEffect(
    () => () => {
      if (waiting.current) void rpc().call('openrouter.cancel', {}).then(() => qc.invalidateQueries({ queryKey: keys.openrouter })).catch(() => undefined);
    },
    [qc],
  );

  const connect = async () => {
    if (!draft) return onInvalid();
    setStarting(true);
    setError(null);
    try {
      const { url } = await rpc().call('openrouter.connect', draft);
      // What an earlier connect left in the cache must not finish this one.
      qc.setQueryData(keys.openrouter, { connecting: true });
      finished.current = false;
      setStarted(draft.id);
      openExternal(url);
      await qc.invalidateQueries({ queryKey: keys.openrouter });
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setStarting(false);
    }
  };

  const problem = error ?? (started !== null && !data?.connecting ? (data?.error ?? null) : null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button loading={starting || connecting} onClick={() => void connect()}>
          Connect with OpenRouter
        </Button>
        <span aria-live="polite" className="text-footnote text-fg-muted">
          {connecting && (
            <span className="flex items-center gap-2">
              <Spinner />
              Finish connecting in your browser…
            </span>
          )}
        </span>
      </div>
      {problem && (
        <p role="alert" className="text-body text-danger-text">
          {problem}
        </p>
      )}
    </div>
  );
}
