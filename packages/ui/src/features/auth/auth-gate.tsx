/**
 * The sign-in gate at the app root: the app renders only for a signed-in user whose password is their
 * own. Before that it shows the desktop's first-run connection choice, first-account setup, an invite code or link,
 * sign-up, waiting for approval, sign-in or a forced password change. On "Run on this computer" there is
 * no password: setup asks for a name, the owner is signed in by themselves, and the optional screen lock
 * replaces the whole app while it is locked.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { APP, type AuthStatus, type ScreenLockStatus, type UserSummary } from '@atelier/protocol';
import { Button, Spinner, toast } from '../../components/ui/index.ts';
import { desktop, getTransport, openExternal, type ConnectionProblem } from '../../lib/platform.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, onSignInLost, rpc } from '../../lib/rpc.ts';
import {
  ChangePasswordScreen,
  ConnectionSetup,
  InviteScreen,
  LinkButton,
  LocalSetupScreen,
  LoginScreen,
  PendingScreen,
  SetupScreen,
  SignupScreen,
} from './auth-screens.tsx';
import { InviteCodeScreen } from './invite-code-screen.tsx';
import { LockScreen } from './lock-screen.tsx';
import { setLocal, useAutoLock } from './screen-lock.ts';
import { localSignIn } from './sign-in.ts';

type Screen =
  | { name: 'loading' }
  | { name: 'connection' }
  | { name: 'setup' }
  | { name: 'localSetup' }
  | { name: 'invite'; token: string }
  | { name: 'inviteCode' }
  | { name: 'login' }
  | { name: 'signup' }
  | { name: 'pending' }
  | { name: 'changePassword'; user: UserSummary }
  | { name: 'app'; user: UserSummary };

/** The invite token of an `#/invite/<token>` link; servers made these before invite codes, and they work until they expire. */
export function inviteToken(hash: string): string | null {
  return /^#\/invite\/([^/?#]+)/.exec(hash)?.[1] ?? null;
}

function userScreen(user: UserSummary): Screen {
  return user.mustChangePassword ? { name: 'changePassword', user } : { name: 'app', user };
}

/** Where a sign-in status leads. */
export function screenFor(status: AuthStatus, invite: string | null): Screen {
  if (status.user) return userScreen(status.user);
  if (status.setupRequired) return status.local ? { name: 'localSetup' } : { name: 'setup' };
  return invite ? { name: 'invite', token: invite } : { name: 'login' };
}

type Connection = Awaited<ReturnType<NonNullable<typeof desktop>['connection']['get']>>;

export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [changingConnection, setChangingConnection] = useState(false);
  // Why the server can't be reached, once the app knows (it says so after a second failed attempt, then keeps trying).
  const [problem, setProblem] = useState<ConnectionProblem | null>(null);
  // "Run on this computer" only: null elsewhere, and until the backend said.
  const [lock, setLock] = useState<ScreenLockStatus | null>(null);

  const show = useCallback(
    (next: Screen) => {
      if (next.name === 'app') {
        qc.setQueryData(keys.account, next.user);
        // The invite link has served its purpose; the router starts at home.
        if (inviteToken(location.hash)) history.replaceState(null, '', '#/');
      }
      setScreen(next);
    },
    [qc],
  );

  const refresh = useCallback(async () => {
    const next = await rpc().call('auth.status', {});
    setLocal(next.local);
    setStatus(next);
    if (next.local) setLock(await rpc().call('lock.status', {}));
    // The owner of this computer has no password: without a kept sign-in they are signed in again by themselves.
    if (next.local && !next.user && !next.setupRequired) {
      try {
        return show(userScreen(await localSignIn()));
      } catch {
        // No active owner (an install whose admin was disabled): the password sign-in still works.
      }
    }
    show(screenFor(next, inviteToken(location.hash)));
  }, [show]);

  // Nothing cached outlives a sign-in: the next one may be someone else.
  useEffect(() => {
    if (screen.name !== 'app') qc.clear();
  }, [qc, screen.name]);

  useEffect(() => {
    void (async () => {
      if (desktop) {
        const choice = await desktop.connection.get();
        setConnection(choice);
        if (choice.mode === null) return setScreen({ name: 'connection' });
      }
      await refresh();
    })();
  }, [refresh]);

  useEffect(() => {
    if (!desktop) return;
    void desktop.connection.problem().then(setProblem);
    return desktop.connection.onProblem(setProblem);
  }, []);

  useEffect(() => rpc().on('lock.changed', setLock), []);
  const locked = lock?.locked === true;

  // Calls made while locked were refused: what the app shows is read again.
  const wasLocked = useRef(false);
  useEffect(() => {
    if (wasLocked.current && !locked) void qc.invalidateQueries();
    wasLocked.current = locked;
  }, [qc, locked]);
  useAutoLock(lock?.enabled ? lock.autoLockMinutes : 0, screen.name === 'app' && !locked);

  // Signed out elsewhere (logout, password reset, account disabled) or a call found no sign-in.
  useEffect(() => {
    const signedOut = () => {
      void desktop?.session.clear();
      if (status?.local) void refresh();
      else setScreen({ name: 'login' });
    };
    const offEvent = rpc().on('auth.signedOut', signedOut);
    const offLost = onSignInLost(signedOut);
    return () => {
      offEvent();
      offLost();
    };
  }, [status?.local, refresh]);

  // The desktop app lends this machine to its user's sessions. The server keeps the device per connection, so every new
  // connection (after sleep, a network change, a server restart) registers again; without it a server refuses the
  // folders of this computer.
  useEffect(() => {
    if (!desktop || screen.name !== 'app' || locked) return;
    const register = () =>
      void rpc()
        .call('devices.register', desktop!.device)
        .catch((e: unknown) => toast.error(describeError(e).message));
    register();
    return getTransport().onReconnect(register);
  }, [screen.name, locked]);

  // Events the backend sent while the connection was down are lost (a device coming back online while the server
  // restarted left its folders marked Offline): everything shown is read again.
  useEffect(() => {
    if (screen.name !== 'app') return;
    return getTransport().onReconnect(() => void qc.invalidateQueries());
  }, [screen.name, qc]);

  const signedIn = (user: UserSummary) => show(userScreen(user));
  const toLogin = () => setScreen({ name: 'login' });
  const server = connection?.mode === 'server' ? connection.serverUrl : null;

  // Before anything else: while locked the app isn't rendered at all.
  if (lock?.locked) return <LockScreen status={lock} name={screen.name === 'app' ? screen.user.name : undefined} />;
  if (screen.name === 'app') return children;
  if (screen.name === 'connection' || changingConnection) return <ConnectionSetup initialUrl={server ?? undefined} />;

  // On desktop the server can be changed from any signed-out screen, without any RPC: while an
  // unreachable server is retried, calls just wait.
  const serverFooter = server && (
    <p>
      {server} · <LinkButton onClick={() => setChangingConnection(true)}>Change server</LinkButton>
    </p>
  );

  // Running on this computer is a choice, not a trap: the way to a server stays on the screens before sign-in.
  const thisComputerFooter = desktop && connection?.mode === 'local' && (
    <p>
      On this computer · <LinkButton onClick={() => setChangingConnection(true)}>Use a server instead</LinkButton>
    </p>
  );

  // In a browser the first account needs the setup token from the server's log; the guide says where it is.
  const setupTokenFooter = !desktop && (
    <p>
      <LinkButton onClick={() => openExternal(`${APP.docs}/self-hosting/#run-it`)}>Where do I find the setup token?</LinkButton>
    </p>
  );

  switch (screen.name) {
    case 'loading':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg px-6 text-center text-body text-fg-muted">
          <Spinner size="md" label={server ? `Connecting to ${server}` : 'Loading'} />
          {server && !problem && <p>Connecting to {server}…</p>}
          {server && problem && (
            <div role="status" className="flex max-w-md flex-col items-center gap-2">
              <p className="text-fg">Can’t reach {server} yet</p>
              <p>{problem.message}</p>
              <p className="text-footnote">Atelier keeps trying, and continues by itself once it can.</p>
              {problem.localNetwork && (
                <Button variant="secondary" onClick={() => void desktop?.connection.openNetworkSettings()}>
                  Open Local Network settings
                </Button>
              )}
            </div>
          )}
          {server && <LinkButton onClick={() => setChangingConnection(true)}>Change server</LinkButton>}
        </div>
      );
    case 'setup':
      return <SetupScreen withSetupToken={!desktop || !!server} onSignedIn={signedIn} footer={thisComputerFooter || serverFooter || setupTokenFooter} />;
    case 'localSetup':
      return <LocalSetupScreen onSignedIn={signedIn} footer={thisComputerFooter} />;
    case 'invite':
      return <InviteScreen token={screen.token} onSignedIn={signedIn} />;
    case 'inviteCode':
      return <InviteCodeScreen onSignedIn={signedIn} onBack={toLogin} />;
    case 'signup':
      return <SignupScreen onBack={toLogin} onDone={() => setScreen({ name: 'pending' })} />;
    case 'pending':
      return <PendingScreen onBack={toLogin} />;
    case 'changePassword':
      return (
        <ChangePasswordScreen
          user={screen.user}
          onDone={() => {
            // The server refused this computer's device link until now: it lends its folders once it reconnects.
            void desktop?.session.relink?.().catch(() => undefined);
            void refresh();
          }}
        />
      );
    case 'login':
      return (
        <LoginScreen
          onSignedIn={signedIn}
          onPending={() => setScreen({ name: 'pending' })}
          footer={
            (!status?.local || serverFooter || thisComputerFooter) && (
              <>
                {status?.signup === 'open' && (
                  <p>
                    New here? <LinkButton onClick={() => setScreen({ name: 'signup' })}>Create an account</LinkButton>
                  </p>
                )}
                {status && !status.local && (
                  <p>
                    Invited? <LinkButton onClick={() => setScreen({ name: 'inviteCode' })}>I have a code</LinkButton>
                  </p>
                )}
                {serverFooter}
                {thisComputerFooter}
              </>
            )
          }
        />
      );
  }
}
