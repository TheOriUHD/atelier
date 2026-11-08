/**
 * `#/link?code=K7QF-3MZD` (ARCHITECTURE §25): approving a terminal that asked to sign in through the browser. The
 * terminal shows the code and this page's address; someone signed in here sees which computer asked and from where,
 * compares the code, and approves (the terminal is signed in as them) or denies it.
 */
import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { normalizeTerminalCode, type TerminalSignInRequest } from '@atelier/protocol';
import { Button, Field, TextField } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

type Step = { name: 'code' } | { name: 'looking' } | { name: 'ask'; request: TerminalSignInRequest } | { name: 'deciding'; request: TerminalSignInRequest; approve: boolean } | { name: 'approved'; request: TerminalSignInRequest } | { name: 'denied' };

export interface TerminalLinkSearch {
  code?: string;
}

export function TerminalLinkPage() {
  const search = useSearch({ from: '/link' });
  return <TerminalLink initialCode={search.code ?? ''} />;
}

/** "20 seconds ago", "3 minutes ago". */
export function agoText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return s <= 1 ? 'just now' : `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m === 1 ? 'a minute ago' : `${m} minutes ago`;
}

export function TerminalLink({ initialCode }: { initialCode: string }) {
  const navigate = useNavigate();
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState<Step>({ name: 'code' });
  const [error, setError] = useState<string | null>(null);
  const home = () => void navigate({ to: '/' });

  const lookUp = async () => {
    setError(null);
    if (!normalizeTerminalCode(code)) return setError('A code has 8 letters and digits, like K7QF-3MZD.');
    setStep({ name: 'looking' });
    try {
      setStep({ name: 'ask', request: await rpc().call('auth.terminalRequest', { code }) });
    } catch (e) {
      setStep({ name: 'code' });
      setError(describeError(e).message);
    }
  };

  const decide = async (request: TerminalSignInRequest, approve: boolean) => {
    setError(null);
    setStep({ name: 'deciding', request, approve });
    try {
      await rpc().call('auth.terminalDecide', { code: request.code, approve });
      setStep(approve ? { name: 'approved', request } : { name: 'denied' });
    } catch (e) {
      setStep({ name: 'ask', request });
      setError(describeError(e).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="m-auto flex w-full max-w-[448px] flex-col gap-5 rounded-palette bg-raised p-6 shadow-lg inset-ring inset-ring-line-subtle max-md:mx-4">
        {step.name === 'approved' ? (
          <>
            <h1 className="text-title text-fg">Your terminal is signed in</h1>
            <p className="text-body text-fg-secondary">
              Atelier CLI on {step.request.deviceName} is signed in as you. It shows under Settings › Account › Sessions, where you can sign it out.
            </p>
            <Button className="self-end" onClick={home}>
              Done
            </Button>
          </>
        ) : step.name === 'denied' ? (
          <>
            <h1 className="text-title text-fg">Sign-in denied</h1>
            <p className="text-body text-fg-secondary">That terminal is not signed in. If it was yours, start the sign-in there again.</p>
            <Button className="self-end" onClick={home}>
              Done
            </Button>
          </>
        ) : step.name === 'ask' || step.name === 'deciding' ? (
          <>
            <div className="flex flex-col gap-1">
              <h1 className="text-title text-fg">Sign in Atelier CLI on {step.request.deviceName}?</h1>
              <p className="text-body text-fg-secondary">It will work as you: your sessions, your models and the folders you open in it.</p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-body">
              <dt className="text-fg-muted">Code</dt>
              <dd className="font-mono text-fg">{step.request.code}</dd>
              <dt className="text-fg-muted">Computer</dt>
              <dd className="text-fg">
                {step.request.deviceName} · {step.request.platform}
              </dd>
              <dt className="text-fg-muted">From</dt>
              <dd className="font-mono text-fg">{step.request.ip || 'unknown address'}</dd>
              <dt className="text-fg-muted">Asked</dt>
              <dd className="text-fg">{agoText(step.request.createdAt)}</dd>
            </dl>
            <p className="rounded-lg bg-warning-subtle px-3 py-2 text-body text-fg">Only approve a terminal you just started yourself, showing this same code. Someone who sends you a code is asking for your account.</p>
            {error && (
              <p role="alert" className="text-body text-danger-text">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" loading={step.name === 'deciding' && !step.approve} disabled={step.name === 'deciding'} onClick={() => void decide(step.request, false)}>
                Deny
              </Button>
              <Button variant="primary" loading={step.name === 'deciding' && step.approve} disabled={step.name === 'deciding'} onClick={() => void decide(step.request, true)}>
                Approve
              </Button>
            </div>
          </>
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void lookUp();
            }}
          >
            <div className="flex flex-col gap-1">
              <h1 className="text-title text-fg">Sign in a terminal</h1>
              <p className="text-body text-fg-secondary">Enter the code your terminal shows after `atelier login`.</p>
            </div>
            <Field label="Code" error={error ?? undefined}>
              <TextField value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7QF-3MZD" autoComplete="off" spellCheck={false} autoFocus className="font-mono uppercase" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={home}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" loading={step.name === 'looking'}>
                Continue
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
