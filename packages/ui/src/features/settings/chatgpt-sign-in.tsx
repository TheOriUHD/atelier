import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_BASE_URLS, PROVIDER_LABELS, type ProviderConfig } from '@atelier/protocol';
import { Button, DialogClose, Spinner, toast } from '../../components/ui/index.ts';
import { openExternal } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { CopyButton } from '../chat/copy-button.tsx';

/** Who is signed in with ChatGPT; watched while browser or device sign-in is pending. */
export function useChatGptStatus(enabled = true) {
  return useQuery({
    queryKey: keys.chatgpt,
    queryFn: () => rpc().call('chatgpt.status', {}),
    enabled,
    refetchInterval: (query) => (query.state.data?.signingIn ? 1000 : false),
  });
}

/**
 * The wizard's step for the ChatGPT subscription: sign in in the browser the way OpenAI's Codex does, and the provider
 * is added when it finishes. Leaving the step with the browser sign-in still open cancels it.
 */
export function ChatGptSignIn({ onBack, onAdded }: { onBack(): void; onAdded(config: ProviderConfig): void }) {
  const qc = useQueryClient();
  const { data } = useChatGptStatus();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adding = useRef(false);
  const waiting = useRef(false);
  const mounted = useRef(true);
  const signedIn = !!data?.signedIn;
  const signingIn = !!data?.signingIn;
  useEffect(() => {
    waiting.current = signingIn;
  }, [signingIn]);

  // Signed in (the browser flow finished): add the provider, once.
  useEffect(() => {
    if (!signedIn || adding.current) return;
    adding.current = true;
    rpc()
      .call('providers.save', { id: 'chatgpt', type: 'chatgpt', name: PROVIDER_LABELS.chatgpt, baseUrl: DEFAULT_BASE_URLS.chatgpt, headers: {}, enabled: true })
      .then((config) => {
        toast.success(`Added ${config.name}`);
        onAdded(config);
      })
      .catch((e: unknown) => {
        adding.current = false;
        setError(describeError(e).message);
      });
  }, [signedIn, onAdded]);

  // Closing the dialog (or going back) while the browser sign-in is open ends it.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (waiting.current) void rpc().call('chatgpt.cancel', {}).then(() => qc.invalidateQueries({ queryKey: keys.chatgpt })).catch(() => undefined);
    };
  }, [qc]);

  const signIn = async () => {
    setStarting(true);
    setError(null);
    waiting.current = true;
    try {
      const { url, userCode } = await rpc().call('chatgpt.signIn', {});
      if (!mounted.current) return;
      if (!userCode) openExternal(url);
      await qc.invalidateQueries({ queryKey: keys.chatgpt });
    } catch (e) {
      if (mounted.current) setError(describeError(e).message);
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const device = signingIn ? data?.device : undefined;
  const problem = error ?? data?.error ?? null;
  return (
    <>
      <div className="flex flex-col gap-3 text-body text-fg-secondary">
        <p>Use the models in your ChatGPT plan, signed in the way OpenAI’s Codex does. Your plan’s own limits apply instead of per-token billing.</p>
        <p className="text-footnote text-fg-muted">
          Unofficial: it isn’t a documented API, so it can change or stop working. Everyone who can use this provider uses your plan.
        </p>
      </div>
      <div aria-live="polite">
        {device && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-body text-fg-secondary">
              Enter this code at{' '}
              <a href={device.url} target="_blank" rel="noreferrer" className="text-interactive-text underline-offset-2 hover:underline">
                {device.url.replace(/^https:\/\//, '')}
              </a>:
            </p>
            <div className="flex items-center gap-2">
              <code aria-label="Your code" className="rounded-lg px-3 py-1.5 font-mono text-title tracking-widest text-fg inset-ring inset-ring-line">
                {device.userCode}
              </code>
              <CopyButton text={device.userCode} size="sm" label="Copy code" />
            </div>
            <p className="text-footnote text-fg-muted">The code expires in 15 minutes. If OpenAI asks, enable device code login in your ChatGPT security settings or ask your workspace admin.</p>
          </div>
        )}
        {signingIn && (
          <p className="mt-4 flex items-center gap-2 text-body text-fg-muted">
            <Spinner />
            {device ? 'Waiting for you to approve the code on OpenAI…' : 'Finish signing in in your browser…'}
          </p>
        )}
        {signedIn && <p className="mt-4 text-body text-fg-muted">Signed in{data?.email ? ` as ${data.email}` : ''}. Adding it…</p>}
        {problem && !signedIn && (
          <p role="alert" className="mt-4 text-body text-danger-text">
            {problem}
          </p>
        )}
      </div>
      <div className="mt-6 flex items-center gap-3">
        <span className="flex-1" />
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <DialogClose render={<Button />}>Cancel</DialogClose>
        {device ? (
          <Button variant="primary" onClick={() => openExternal(device.url)}>Open OpenAI</Button>
        ) : (
          <Button variant="primary" loading={starting || signedIn} disabled={signingIn} onClick={() => void signIn()}>
            Sign in with ChatGPT
          </Button>
        )}
      </div>
    </>
  );
}
