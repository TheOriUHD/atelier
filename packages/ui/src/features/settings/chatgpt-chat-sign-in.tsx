import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_BASE_URLS, type ProviderConfig } from '@atelier/protocol';
import { Button } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

/** Whether this backend can drive a ChatGPT window: only the desktop app can, so a server never offers ChatGPT Chat. */
export function useChatGptChatAvailable(enabled = true) {
  return useQuery({
    queryKey: ['chatgptChat', 'available'],
    queryFn: async () => (await rpc().call('chatgptChat.status', {})).available,
    enabled,
    staleTime: Infinity,
  }).data === true;
}

/** Seconds before "Continue" can be pressed: long enough to read what ChatGPT Chat is. */
export const WARNING_SECONDS = 5;

/** Said before anything else when ChatGPT Chat is added: it is an unofficial way in, and it can cost the person their account. */
function ExperimentalWarning({ onBack, onContinue }: { onBack(): void; onContinue(): void }) {
  const [left, setLeft] = useState(WARNING_SECONDS);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return <>
    <div role="alert" aria-labelledby="chatgpt-chat-warning" className="rounded-xl border border-danger bg-danger-subtle p-5">
      <p className="mb-2 text-footnote font-medium text-danger-text">EXPERIMENTAL</p>
      <h3 id="chatgpt-chat-warning" className="text-section-heading text-danger-text">ChatGPT Chat is not an official way to use ChatGPT</h3>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-body text-danger-text">
        <li>Atelier types into a hidden browser window that is signed in to chatgpt.com. OpenAI offers no API for this, and automated use of ChatGPT can go against its terms: OpenAI could limit or suspend the account you sign in with.</li>
        <li>It stops working whenever ChatGPT’s page changes, without notice.</li>
        <li>Every message counts against your ChatGPT plan’s own limits, and it handles one conversation at a time.</li>
        <li>For work you depend on, use an API key or a local model.</li>
      </ul>
    </div>
    <div className="mt-5 flex items-center justify-between gap-3">
      <Button variant="ghost" onClick={onBack}>Back</Button>
      <Button variant="danger" disabled={left > 0} onClick={onContinue}>{left > 0 ? `Continue in ${left}` : 'I understand, continue'}</Button>
    </div>
  </>;
}

export function ChatGptChatSignIn({ onBack, onAdded }: { onBack(): void; onAdded(config: ProviderConfig): void }) {
  const [understood, setUnderstood] = useState(false);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['chatgptChat'], queryFn: () => rpc().call('chatgptChat.status', {}), enabled: opened, refetchInterval: opened ? 2000 : false });
  useEffect(() => () => { void rpc().call('chatgptChat.hide', {}).catch(() => {}); }, []);
  const open = async () => {
    setBusy(true); setError(null);
    try { await rpc().call('chatgptChat.open', {}); setOpened(true); }
    catch (error) { setError(describeError(error).message); }
    finally { setBusy(false); }
  };
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const config = await rpc().call('providers.save', { id: 'chatgpt-chat', type: 'chatgpt-chat', name: 'ChatGPT Chat', baseUrl: DEFAULT_BASE_URLS['chatgpt-chat'], headers: {}, enabled: true });
      await rpc().call('chatgptChat.hide', {});
      onAdded(config);
    }
    catch (error) { setError(describeError(error).message); }
    finally { setBusy(false); }
  };
  if (!understood) return <ExperimentalWarning onBack={onBack} onContinue={() => setUnderstood(true)} />;
  return <>
    <div className="rounded-xl border border-line p-5">
      <p className="mb-2 text-footnote text-fg-muted">EXPERIMENTAL · DESKTOP</p>
      <h3 className="text-section-heading text-fg">Your ChatGPT, without the setup</h3>
      <p className="mt-2 text-body text-fg-secondary">Sign in directly to ChatGPT in a private window managed by Atelier. No API key, token copying, or separate service to install.</p>
      <div className="mt-4 border-t border-line pt-4 text-body text-fg-secondary">
        <p>{data?.signedIn ? 'ChatGPT session connected. Ready to add.' : opened ? 'Finish signing in in the ChatGPT window. Atelier will detect it here.' : 'A separate browser sign-in is needed. Your ChatGPT Plan connection stays unchanged.'}</p>
      </div>
    </div>
    <p className="mt-3 text-footnote text-fg-muted">Atelier sends your messages, images and PDFs through that window and reads the model and thinking level from ChatGPT’s own picker. It runs on your ChatGPT limits, which can end sooner than you expect. Browser changes can interrupt this unofficial connection; automated access may conflict with OpenAI’s terms.</p>
    {error && <p role="alert" className="mt-3 text-body text-danger-text">{error}</p>}
    <div className="mt-5 flex items-center justify-between gap-3">
      <Button variant="ghost" onClick={onBack}>Back</Button>
      <div className="flex gap-2">
        <Button variant={data?.signedIn ? 'secondary' : 'primary'} loading={busy} onClick={() => void open()}>{opened ? 'Open ChatGPT session' : 'Sign in to ChatGPT'}</Button>
        {data?.signedIn && <Button variant="primary" loading={busy} onClick={() => void connect()}>Add ChatGPT Chat</Button>}
      </div>
    </div>
  </>;
}
