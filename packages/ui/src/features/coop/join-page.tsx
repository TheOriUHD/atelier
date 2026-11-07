/**
 * `#/join/<fragment>` (design/components.md › Co-op › Join card): an invite to someone else's session. The desktop app
 * opens it from `atelier://join#…` links (apps/desktop/src/main.ts). The card says whose session it is, where it runs
 * and what the guest shares; Join connects through the relay and waits for the host to let them in.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { MessageSquare, Plug, UserRound, type LucideIcon } from 'lucide-react';
import { parseInviteFragment, type InviteMeta, type ModelsChoice } from '@atelier/protocol';
import { Button, Icon, SegmentedControl, Spinner } from '../../components/ui/index.ts';
import { SESSION_ROUTE } from '../../app/navigation.ts';
import { surface } from '../../lib/platform.ts';
import { useAppInfo } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Avatar } from './avatar.tsx';
import { possessive } from './coop.ts';

type Step = { name: 'ask' } | { name: 'joining' } | { name: 'waiting'; sessionId: string; fingerprint: string[] | null } | { name: 'declined' } | { name: 'error'; message: string };

export function JoinPage() {
  const { fragment } = useParams({ from: '/join/$fragment' });
  return <JoinCard fragment={fragment} />;
}

export function JoinCard({ fragment }: { fragment: string }) {
  const invite = parseInviteFragment(fragment);
  const meta = invite?.meta ?? null;
  const host = meta?.hostName ?? 'the host';
  const navigate = useNavigate();
  const { data: info } = useAppInfo();
  const [models, setModels] = useState<ModelsChoice>('host');
  const [step, setStep] = useState<Step>({ name: 'ask' });
  const open = (sessionId: string) => void navigate({ to: SESSION_ROUTE[meta?.mode ?? 'chat'], params: { sessionId }, replace: true });
  const home = () => void navigate({ to: '/' });

  const join = async () => {
    setStep({ name: 'joining' });
    try {
      const result = await rpc().call('coop.join', { invite: fragment, models });
      if (result.waiting) setStep({ name: 'waiting', sessionId: result.sessionId, fingerprint: result.fingerprint ?? null });
      else open(result.sessionId);
    } catch (e) {
      setStep({ name: 'error', message: describeError(e).message });
    }
  };

  // While the host decides: the session's summary changes when they let the guest in (its co-op state can then be
  // read), and it goes when they decline.
  const waitingFor = step.name === 'waiting' ? step.sessionId : null;
  useEffect(() => {
    if (!waitingFor) return;
    let done = false;
    const check = () =>
      void rpc()
        .call('coop.state', { sessionId: waitingFor })
        .then((state) => {
          if (state && !done) {
            done = true;
            open(waitingFor);
          }
        })
        .catch(() => undefined);
    const offChanged = rpc().on('sessions.changed', (summary) => summary.id === waitingFor && check());
    const offRemoved = rpc().on('sessions.removed', ({ id }) => {
      if (id === waitingFor && !done) {
        done = true;
        setStep({ name: 'declined' });
      }
    });
    const timer = setInterval(check, 4000);
    return () => {
      done = true;
      offChanged();
      offRemoved();
      clearInterval(timer);
    };
    // `open` is the same navigation each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingFor]);

  const cancel = () => {
    if (step.name === 'waiting') void rpc().call('coop.leave', { sessionId: step.sessionId }).catch(() => undefined);
    home();
  };

  // Joining runs on this computer's own backend: a browser, or a desktop app signed in to a server, can't.
  const needsDesktop = surface === 'web' || info?.surface === 'web';

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="m-auto flex w-full max-w-[448px] flex-col gap-5 rounded-palette bg-raised p-6 shadow-lg inset-ring inset-ring-line-subtle max-md:mx-4">
        {!invite ? (
          <>
            <h1 className="text-title text-fg">This invite link doesn’t work</h1>
            <p className="text-body text-fg-secondary">It may be cut short or mistyped. Ask for a new link.</p>
            <Button className="self-end" onClick={home}>
              Back
            </Button>
          </>
        ) : step.name === 'waiting' ? (
          <Waiting host={host} fingerprint={step.fingerprint} onCancel={cancel} />
        ) : step.name === 'declined' ? (
          <>
            <h1 className="text-title text-fg">{host} didn’t let you in</h1>
            <p className="text-body text-fg-secondary">Ask them for a new link if that was a mistake.</p>
            <Button className="self-end" onClick={home}>
              Back
            </Button>
          </>
        ) : (
          <>
            <Question meta={meta} host={host} />
            {needsDesktop ? (
              <>
                <p className="text-body text-fg-secondary">
                  {surface === 'web'
                    ? 'Joining a session on someone else’s computer needs the Atelier desktop app, running on this computer. Open the link there.'
                    : 'This app is connected to a server. Joining a session on someone else’s computer needs Atelier to run on this computer.'}
                </p>
                <Button className="self-end" onClick={home}>
                  Back
                </Button>
              </>
            ) : (
              <>
                <Shares />
                <div className="flex flex-col gap-2">
                  <h2 id="join-models" className="text-footnote text-fg-muted">
                    Answer my messages with
                  </h2>
                  <SegmentedControl
                    aria-labelledby="join-models"
                    size="sm"
                    items={[
                      { value: 'host', label: `${possessive(host)} models` },
                      { value: 'own', label: 'My models' },
                    ]}
                    value={models}
                    onValueChange={setModels}
                    className="self-start"
                  />
                  <p className="text-footnote text-fg-muted">
                    {models === 'host' ? `${host} pays for them, up to what they share each day.` : 'You choose which of your models once you’re in. Your keys stay on this computer.'}
                  </p>
                </div>
                {step.name === 'error' && (
                  <p role="alert" className="text-body text-danger-text">
                    {step.message}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={home}>
                    Not now
                  </Button>
                  <Button variant="primary" loading={step.name === 'joining'} onClick={() => void join()}>
                    Join
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Question({ meta, host }: { meta: InviteMeta | null; host: string }) {
  return (
    <div className="flex items-start gap-3">
      <Avatar name={host} avatar={null} size="md" className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-title break-words text-fg">
          {meta ? (
            <>
              Join {possessive(host)} session <strong className="font-semibold">{meta.title || 'Untitled'}</strong>?
            </>
          ) : (
            'Join this session?'
          )}
        </h1>
        <p className="text-body text-fg-secondary">It runs on {possessive(host)} computer.</p>
      </div>
    </div>
  );
}

/** What the guest shares: their name and messages always, their models and connectors only when they choose them. */
function Shares() {
  const rows: { icon: LucideIcon; text: string }[] = [
    { icon: UserRound, text: 'Your name and picture' },
    { icon: MessageSquare, text: 'The messages you send' },
    { icon: Plug, text: 'Your models and connectors, only if you choose them' },
  ];
  return (
    <section aria-label="What you share" className="flex flex-col gap-2">
      <h2 className="text-footnote text-fg-muted">What you share</h2>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.text} className="flex items-center gap-2.5 text-body text-fg">
            <Icon icon={r.icon} className="shrink-0 text-fg-muted" />
            {r.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Knocked: the host lets them in after comparing the fingerprint. */
function Waiting({ host, fingerprint, onCancel }: { host: string; fingerprint: string[] | null; onCancel(): void }) {
  return (
    <>
      <div className="flex items-center gap-2.5">
        <Spinner size="sm" className="text-fg-muted" />
        <h1 className="text-title text-fg">Waiting for {host} to let you in…</h1>
      </div>
      <div className="flex flex-col items-center gap-2 rounded-xl bg-fill-ghost-hover p-4">
        {fingerprint ? (
          <p aria-label={`Fingerprint: ${fingerprint.join(' ')}`} className="text-[32px]/[40px] tracking-[0.2em]">
            {fingerprint.join(' ')}
          </p>
        ) : (
          <span aria-label="Fingerprint not known yet" className="flex gap-3">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-10 rounded-lg bg-skeleton" />
            ))}
          </span>
        )}
        <p className="text-center text-footnote text-fg-muted">The same three emoji show on {possessive(host)} screen. Compare them over a call or a chat, so you both know it’s you.</p>
      </div>
      <Button className="self-end" onClick={onCancel}>
        Cancel
      </Button>
    </>
  );
}
