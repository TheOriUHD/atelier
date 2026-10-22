import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_BASE_URLS, PROVIDER_LABELS, type ProviderConfig } from '@atelier/protocol';
import { Button, DialogClose, Spinner, toast } from '../../components/ui/index.ts';
import { openExternal } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { CopyButton } from '../chat/copy-button.tsx';

/** Who is signed in to GitHub Copilot, and the code to enter while a sign-in waits; watched while it does. */
export function useCopilotStatus(enabled = true) {
  return useQuery({
    queryKey: keys.copilot,
    queryFn: () => rpc().call('copilot.status', {}),
    enabled,
    refetchInterval: (query) => (query.state.data?.signingIn ? 1000 : false),
  });
}

/**
 * The wizard's step for GitHub Copilot: GitHub's device sign-in, where the person enters a code on github.com while the
 * backend waits for it, and the provider is added when it finishes. Leaving the step with the sign-in open cancels it.
 */
export function CopilotSignIn({ onBack, onAdded }: { onBack(): void; onAdded(config: ProviderConfig): void }) {
  const qc = useQueryClient();
  const { data } = useCopilotStatus();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const adding = useRef(false);
  const waiting = useRef(false);
  const signedIn = !!data?.signedIn;
  const signingIn = !!data?.signingIn;
  useEffect(() => {
    waiting.current = signingIn;
  }, [signingIn]);

  // Signed in (the code was entered on GitHub): add the provider, once.
  useEffect(() => {
    if (!signedIn || adding.current) return;
    adding.current = true;
    rpc()
      .call('providers.save', { id: 'copilot', type: 'copilot', name: PROVIDER_LABELS.copilot, baseUrl: DEFAULT_BASE_URLS.copilot, headers: {}, enabled: true })
      .then((config) => {
        toast.success(`Added ${config.name}`);
        onAdded(config);
      })
      .catch((e: unknown) => {
        adding.current = false;
        setError(describeError(e).message);
      });
  }, [signedIn, onAdded]);

  // Closing the dialog (or going back) while the sign-in waits for its code ends it.
  useEffect(
    () => () => {
      if (waiting.current) void rpc().call('copilot.cancel', {}).then(() => qc.invalidateQueries({ queryKey: keys.copilot })).catch(() => undefined);
    },
    [qc],
  );

  const signIn = async () => {
    setStarting(true);
    setError(null);
    try {
      await rpc().call('copilot.signIn', {});
      await qc.invalidateQueries({ queryKey: keys.copilot });
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setStarting(false);
    }
  };

  const code = signingIn ? data?.userCode : undefined;
  const link = data?.verificationUri ?? 'https://github.com/login/device';
  const problem = error ?? data?.error ?? null;
  return (
    <>
      <div className="flex flex-col gap-3 text-body text-fg-secondary">
        <p>Use the models in your GitHub Copilot plan, signed in with your GitHub account. Your plan’s own limits apply instead of per-token billing.</p>
        <p className="text-footnote text-fg-muted">
          Unofficial: Copilot’s API is documented for GitHub’s own editors, so it can change or stop working. Everyone who can use this provider uses your plan.
        </p>
      </div>
      <div aria-live="polite">
        {code && (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-body text-fg-secondary">
              Enter this code at{' '}
              <a href={link} target="_blank" rel="noreferrer" className="text-interactive-text underline-offset-2 hover:underline">
                {link.replace(/^https:\/\//, '')}
              </a>
              :
            </p>
            <div className="flex items-center gap-2">
              <code aria-label="Your code" className="rounded-lg px-3 py-1.5 font-mono text-title tracking-widest text-fg inset-ring inset-ring-line">
                {code}
              </code>
              <CopyButton text={code} size="sm" label="Copy code" />
            </div>
            <p className="flex items-center gap-2 text-body text-fg-muted">
              <Spinner />
              Waiting for you to enter the code on GitHub…
            </p>
          </div>
        )}
        {signedIn && <p className="mt-4 text-body text-fg-muted">Signed in{data?.login ? ` as ${data.login}` : ''}. Adding it…</p>}
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
        {code ? (
          <Button variant="primary" onClick={() => openExternal(link)}>
            Open GitHub
          </Button>
        ) : (
          <Button variant="primary" loading={starting || signedIn} onClick={() => void signIn()}>
            Sign in with GitHub
          </Button>
        )}
      </div>
    </>
  );
}
