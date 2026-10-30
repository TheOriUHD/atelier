/** The signed-out screens: centered cards. */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowLeft, KeyRound, Laptop, LogIn, Server } from 'lucide-react';
import { z } from 'zod';
import { APP, Password, Username, type OidcSignInOption, type UserSummary } from '@atelier/protocol';
import { Button, Field, Icon, Spinner, TextField } from '../../components/ui/index.ts';
import { BrandMark } from '../../components/brand-mark.tsx';
import { useAppearance } from '../../lib/appearance.ts';
import { desktop, surface } from '../../lib/platform.ts';
import { describeError, errorCode } from '../../lib/rpc.ts';
import { ChangePasswordForm } from './change-password-form.tsx';
import { FoundServers } from './found-servers.tsx';
import { useFormSubmit } from './form.ts';
import { passkeySignIn, passkeysAvailable } from './passkeys.ts';
import { acceptInvite, clearOidcError, login, oidcError, oidcStart, setup, setupLocal, signup, type NewAccount } from './sign-in.ts';

export function AuthLayout({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useAppearance(undefined);
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg text-fg">
      {/* The wordmark sits in the middle of the title bar row (which is also where the window is dragged from). */}
      <header className="app-drag flex h-16 shrink-0 items-center justify-center px-6">
        <span className="flex items-center gap-2.5 font-serif text-[28px] leading-8 font-semibold tracking-[-0.3px] select-none">
          <BrandMark className="size-8" />
          Atelier
        </span>
      </header>
      {/* The bottom padding is the header's height, so the content is centered in the window itself; `my-auto` (not
          justify-center) keeps a tall form scrollable from its top. */}
      <main className="flex flex-1 flex-col items-center px-4 pb-16">
        <div className="my-auto flex w-full flex-col items-center py-8">
          <h1 className="max-w-[560px] text-center font-serif text-[40px] leading-[48px] tracking-[-0.5px] text-balance sm:text-[52px] sm:leading-[60px]">
            {title}
          </h1>
          {subtitle != null && (
            <p className="mt-3 max-w-[448px] text-center font-serif text-[18px] leading-7 text-pretty text-fg-secondary">
              {subtitle}
            </p>
          )}
          <div className="mt-8 w-full max-w-[448px] rounded-palette bg-raised p-6 shadow-lg inset-ring inset-ring-line-subtle sm:p-7">
            {children}
          </div>
          {footer && <div className="mt-6 flex flex-col items-center gap-2 text-body text-fg-secondary">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** Auth forms use 40px fields. */
const INPUT_CLASS = 'h-10';

function FormError({ message }: { message: string | undefined }) {
  return message ? (
    <p role="alert" className="text-footnote text-danger-text">
      {message}
    </p>
  ) : null;
}

/** A text button under the card ("Create an account", "Back to sign in"). */
export function LinkButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xs text-body text-interactive-text outline-none focus-ring hover:underline"
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ desktop first run

// The desktop's main process normalizes the address (apps/desktop/src/server-url.ts): no scheme tries https://, then http://.
const ServerUrl = z.string().trim().min(1, 'Enter the server’s address, for example atelier.example.com or 192.168.1.20:7340.').max(2048);

/**
 * Desktop first run: use the built-in backend, or an Atelier server. A saved choice reloads the app, so
 * the call never settles then; it rejects with a message to show (bad address, no server answered).
 */
export function ConnectionSetup({ initialUrl }: { initialUrl?: string }) {
  const [server, setServer] = useState(initialUrl !== undefined);
  const [url, setUrl] = useState(initialUrl ?? '');
  const form = useFormSubmit(z.object({ url: ServerUrl }), {}, ({ url }) =>
    desktop!.connection.set({ mode: 'server', serverUrl: url.replace(/\/+$/, '') }),
  );
  const pick = (found: string) => {
    setUrl(found);
    form.submit({ url: found });
  };
  const [starting, setStarting] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const runLocally = () => {
    setStarting(true);
    setLocalError(undefined);
    desktop!.connection.set({ mode: 'local' }).catch((e: unknown) => {
      setLocalError(describeError(e).message);
      setStarting(false);
    });
  };

  return (
    <AuthLayout
      title="Welcome to Atelier"
      subtitle="Where should Atelier keep your chats?"
      footer={
        <p>
          New to Atelier? <LinkButton onClick={() => desktop!.openExternal(`${APP.docs}/getting-started/`)}>Get started</LinkButton>
        </p>
      }
    >
      {server ? (
        <form noValidate onSubmit={form.onSubmit({ url })} className="flex flex-col gap-4">
          <Field label="Server URL" error={form.errors.url ?? form.errors.form}>
            <TextField
              type="text"
              inputMode="url"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              placeholder="atelier.example.com or 192.168.1.20:7340"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={INPUT_CLASS}
            />
          </Field>
          <FoundServers disabled={form.pending} onPick={pick} />
          <Button type="submit" variant="primary" size="lg" loading={form.pending}>
            Connect
          </Button>
          <Button variant="ghost" leadingIcon={ArrowLeft} disabled={form.pending} onClick={() => setServer(false)}>
            Back
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <ChoiceButton
            icon={Laptop}
            title="Run on this computer"
            description="Atelier runs its own backend here. Your chats and settings stay on this computer."
            busy={starting}
            onClick={runLocally}
          />
          <ChoiceButton
            icon={Server}
            title="Connect to a server"
            description="Use an Atelier server, for example in your home lab, and sign in with your account there."
            disabled={starting}
            onClick={() => setServer(true)}
          />
          <FormError message={localError} />
        </div>
      )}
    </AuthLayout>
  );
}

/** A large choice: named by its title, described by the line under it. */
function ChoiceButton({
  icon,
  title,
  description,
  busy = false,
  disabled = busy,
  onClick,
}: {
  icon: typeof Laptop;
  title: string;
  description: string;
  busy?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  const id = useId();
  return (
    <button
      type="button"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
      className="flex items-start gap-3 rounded-2xl p-4 text-left inset-ring inset-ring-line outline-none focus-ring hover:bg-fill-ghost-hover disabled:pointer-events-none disabled:not-aria-busy:opacity-40"
    >
      {busy ? <Spinner size="md" className="mt-0.5 text-fg-secondary" /> : <Icon icon={icon} size="md" className="mt-0.5 text-fg-secondary" />}
      <span>
        <span id={`${id}-title`} className="block text-body-strong text-fg">
          {title}
        </span>
        <span id={`${id}-description`} className="mt-1 block text-body text-fg-muted">
          {description}
        </span>
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ accounts

const NewAccountSchema = z.object({
  username: Username,
  name: z.string().trim().min(1, 'Enter your name.').max(80),
  password: Password,
});

type NewAccountField = keyof NewAccount | 'setupToken';

/** Username, full name and password; the shared body of setup, invite and sign-up. */
function NewAccountForm({
  submitLabel,
  withSetupToken = false,
  onSubmit,
}: {
  submitLabel: string;
  withSetupToken?: boolean;
  onSubmit(values: NewAccount & { setupToken?: string }): Promise<unknown>;
}) {
  const [values, setValues] = useState({ username: '', name: '', password: '', setupToken: '' });
  const schema: z.ZodType<NewAccount & { setupToken?: string }> = withSetupToken
    ? NewAccountSchema.extend({ setupToken: z.string().trim().min(1, 'Enter the setup token from the server log.') })
    : NewAccountSchema;
  // A wrong setup token comes back as `invalid_setup_token` over RPC and `invalid_credentials` over HTTP.
  const fieldFor: Partial<Record<string, NewAccountField>> = withSetupToken
    ? { exists: 'username', invalid_setup_token: 'setupToken', invalid_credentials: 'setupToken' }
    : { exists: 'username' };
  const form = useFormSubmit(schema, fieldFor, onSubmit);
  const bind = (key: keyof typeof values) => ({
    value: values[key],
    onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value })),
    className: INPUT_CLASS,
  });

  return (
    <form noValidate onSubmit={form.onSubmit(values)} className="flex flex-col gap-4">
      {withSetupToken && (
        <Field
          label="Setup token"
          description="Printed in the server log when it starts without any accounts."
          error={form.errors.setupToken}
        >
          <TextField autoFocus autoComplete="off" spellCheck={false} {...bind('setupToken')} />
        </Field>
      )}
      <Field label="Full name" error={form.errors.name}>
        <TextField autoFocus={!withSetupToken} autoComplete="name" {...bind('name')} />
      </Field>
      <Field label="Username" description="Letters, digits, dots, dashes or underscores." error={form.errors.username}>
        <TextField autoComplete="username" autoCapitalize="none" spellCheck={false} {...bind('username')} />
      </Field>
      <Field label="Password" description="At least 8 characters." error={form.errors.password}>
        <TextField type="password" autoComplete="new-password" {...bind('password')} />
      </Field>
      <FormError message={form.errors.form} />
      <Button type="submit" variant="primary" size="lg" loading={form.pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function SetupScreen({
  withSetupToken,
  onSignedIn,
  footer,
}: {
  withSetupToken: boolean;
  onSignedIn(user: UserSummary): void;
  footer?: ReactNode;
}) {
  return (
    <AuthLayout
      title="Set up Atelier"
      subtitle="Create the first account. It becomes the admin, who can add everyone else."
      footer={footer}
    >
      <NewAccountForm
        submitLabel="Create account"
        withSetupToken={withSetupToken}
        onSubmit={async (v) => onSignedIn(await setup(v))}
      />
    </AuthLayout>
  );
}

const LocalName = z.object({ name: z.string().trim().min(1, 'Enter your name.').max(80) });

/** "Run on this computer": only a name. There is no password; a screen lock can be set later in Settings › Account. */
export function LocalSetupScreen({ onSignedIn, footer }: { onSignedIn(user: UserSummary): void; footer?: ReactNode }) {
  const [name, setName] = useState('');
  const form = useFormSubmit(LocalName, {}, async (v) => onSignedIn(await setupLocal(v.name)));
  return (
    <AuthLayout title="Set up Atelier" subtitle="What should Atelier call you?" footer={footer}>
      <form noValidate onSubmit={form.onSubmit({ name })} className="flex flex-col gap-4">
        <Field
          label="Your name"
          description="Only you use Atelier on this computer, so there’s no password. You can add a screen lock in Settings later."
          error={form.errors.name ?? form.errors.form}
        >
          <TextField autoFocus autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={INPUT_CLASS} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={form.pending}>
          Continue
        </Button>
      </form>
    </AuthLayout>
  );
}

export function InviteScreen({ token, onSignedIn, footer }: { token: string; onSignedIn(user: UserSummary): void; footer?: ReactNode }) {
  return (
    <AuthLayout title="You’re invited" subtitle="Create your account to join this Atelier." footer={footer}>
      <NewAccountForm submitLabel="Create account" onSubmit={async (v) => onSignedIn(await acceptInvite(token, v))} />
    </AuthLayout>
  );
}

export function SignupScreen({ onBack, onDone }: { onBack(): void; onDone(): void }) {
  return (
    <AuthLayout
      title="Create an account"
      subtitle="An admin approves new accounts before they can sign in."
      footer={<LinkButton onClick={onBack}>Back to sign in</LinkButton>}
    >
      <NewAccountForm
        submitLabel="Request account"
        onSubmit={async (v) => {
          await signup(v);
          onDone();
        }}
      />
    </AuthLayout>
  );
}

export function PendingScreen({ onBack }: { onBack(): void }) {
  return (
    <AuthLayout title="Waiting for approval" footer={<LinkButton onClick={onBack}>Back to sign in</LinkButton>}>
      <p className="text-body text-fg-secondary">
        Your account is waiting for an admin to approve it. Once they do, sign in with your username and password.
      </p>
    </AuthLayout>
  );
}

const Credentials = z.object({ username: Username, password: z.string().min(1, 'Enter your password.') });

export function LoginScreen({
  footer,
  providers = [],
  onSignedIn,
  onPending,
}: {
  footer?: ReactNode;
  /** The server's identity providers; browsers only, the desktop app signs in with a password. */
  providers?: OidcSignInOption[] | undefined;
  onSignedIn(user: UserSummary): void;
  onPending(): void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const form = useFormSubmit(Credentials, {}, async (v) => {
    try {
      onSignedIn(await login(v));
    } catch (e) {
      if (errorCode(e) !== 'pending') throw e;
      onPending();
    }
  });
  const passkey = useFormSubmit(z.object({}), {}, () =>
    passkeySignIn().catch((e: unknown) => {
      if (errorCode(e) !== 'pending') throw e;
      onPending();
    }),
  );
  const offered = surface === 'web' ? providers : [];
  const [provider, setProvider] = useState<string>();
  const [providerError, setProviderError] = useState(oidcError);
  useEffect(clearOidcError, []);
  const continueWith = (id: string) => {
    setProvider(id);
    setProviderError(undefined);
    oidcStart(id).catch((e: unknown) => {
      setProvider(undefined);
      setProviderError(describeError(e).message);
    });
  };
  const others = offered.length > 0 || passkeysAvailable();
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to continue to Atelier." footer={footer}>
      <form noValidate onSubmit={form.onSubmit({ username, password })} className="flex flex-col gap-4">
        <Field label="Username" error={form.errors.username}>
          <TextField
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Password" error={form.errors.password}>
          <TextField
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT_CLASS}
          />
        </Field>
        <FormError message={form.errors.form} />
        <Button type="submit" variant="primary" size="lg" loading={form.pending}>
          Sign in
        </Button>
      </form>
      {others && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex items-center gap-3 text-footnote text-fg-muted" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          {offered.map((p) => (
            <Button key={p.id} size="lg" leadingIcon={LogIn} loading={provider === p.id} disabled={!!provider} onClick={() => continueWith(p.id)}>
              Continue with {p.name}
            </Button>
          ))}
          <FormError message={providerError} />
          {passkeysAvailable() && (
            <form noValidate onSubmit={passkey.onSubmit({})} className="flex flex-col gap-4">
              <Button type="submit" size="lg" leadingIcon={KeyRound} loading={passkey.pending}>
                Sign in with a passkey
              </Button>
              <FormError message={passkey.errors.form} />
            </form>
          )}
        </div>
      )}
    </AuthLayout>
  );
}

export function ChangePasswordScreen({ user, onDone }: { user: UserSummary; onDone(): void }) {
  return (
    <AuthLayout
      title="Choose a new password"
      subtitle={`${user.name}, an admin gave you a temporary password. Replace it with one only you know.`}
    >
      <ChangePasswordForm
        currentLabel="Temporary password"
        onDone={onDone}
        actions={(pending) => (
          <Button type="submit" variant="primary" size="lg" loading={pending}>
            Save and continue
          </Button>
        )}
      />
    </AuthLayout>
  );
}
