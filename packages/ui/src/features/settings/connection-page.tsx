import { useId, useState, type ReactNode } from 'react';
import { Laptop, Server } from 'lucide-react';
import { z } from 'zod';
import { Badge, Button, cn, Field, Icon, TextField } from '../../components/ui/index.ts';
import { useConnection } from '../../lib/lending.ts';
import { useAppInfo } from '../../lib/queries.ts';
import { describeError } from '../../lib/rpc.ts';
import { FoundServers } from '../auth/found-servers.tsx';
import { useFormSubmit } from '../auth/form.ts';
import { isLocal } from '../auth/screen-lock.ts';
import { switchConnection } from '../auth/sign-in.ts';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';
import { ShareSection } from './share-section.tsx';

// The main process normalizes the address (apps/desktop/src/server-url.ts): no scheme tries https://, then http://.
const ServerUrl = z.string().trim().min(1, 'Enter the server’s address, for example atelier.example.com or 192.168.1.20:7340.').max(2048);

/** The host people know a server by: `atelier.home`, `192.168.1.20:7340`. */
const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Settings › Connection, only in the desktop app: where Atelier runs, this computer or an Atelier server, and the switch
 * between them that the first-run choice made. Switching keeps everything: the chats on this computer stay here, the
 * ones on a server stay there.
 */
export function ConnectionPage() {
  const { data: connection } = useConnection();
  const entry = settingEntry('connection.mode');
  // Which option is open: the other one, to switch to it, or the server in use, for another server.
  const [open, setOpen] = useState<'local' | 'server' | null>(null);
  const { data: info } = useAppInfo();
  if (!connection) return null;
  const local = isLocal();
  const host = hostOf(connection.serverUrl);
  return (
    <>
      <SettingsSection id="connection.mode" title={entry.label} description={entry.description}>
        <div className="flex flex-col gap-3">
          <Option
            icon={Laptop}
            title="This computer"
            description="Atelier runs here, with your own models and keys. Your chats and settings stay on this computer."
            current={local}
            action={local ? null : 'Switch…'}
            open={open === 'local'}
            onSelect={() => setOpen(local || open === 'local' ? null : 'local')}
          >
            {!local && <SwitchToLocal host={host} onCancel={() => setOpen(null)} />}
          </Option>
          <Option
            icon={Server}
            title="An Atelier server"
            description={
              !local && host
                ? `Signed in to ${host}. Your chats, models and keys live there, and this computer lends the folders you open.`
                : 'Your chats, models and keys live on a server you or your team run. This computer lends the folders you open.'
            }
            current={!local}
            action={local ? 'Switch…' : 'Change…'}
            open={open === 'server'}
            onSelect={() => setOpen(open === 'server' ? null : 'server')}
          >
            <SwitchToServer another={!local} onCancel={() => setOpen(null)} />
          </Option>
        </div>
      </SettingsSection>
      {local && info?.networkShare && <ShareSection />}
    </>
  );
}

/** One way to run Atelier: a card that says whether it's in use, and opens what switching to it takes. */
function Option({
  icon,
  title,
  description,
  current,
  action,
  open,
  onSelect,
  children,
}: {
  icon: typeof Laptop;
  title: string;
  description: string;
  current: boolean;
  /** What a click does: switch to it, or change the server in use. */
  action: string | null;
  open: boolean;
  onSelect(): void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn('rounded-2xl inset-ring transition-[box-shadow]', current ? 'inset-ring-interactive' : 'inset-ring-line')}>
      <button
        type="button"
        aria-expanded={open}
        aria-labelledby={current ? `${id}-title ${id}-current` : `${id}-title`}
        aria-describedby={`${id}-description`}
        onClick={onSelect}
        className="flex w-full items-start gap-3 rounded-2xl p-4 text-left outline-none focus-ring hover:bg-fill-ghost-hover"
      >
        <Icon icon={icon} size="md" className={cn('mt-0.5', current ? 'text-interactive-text' : 'text-fg-secondary')} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span id={`${id}-title`} className="text-body-strong text-fg">
              {title}
            </span>
            {current && (
              <Badge id={`${id}-current`} tone="accent">
                In use
              </Badge>
            )}
          </span>
          <span id={`${id}-description`} className="mt-1 block text-body text-fg-muted">
            {description}
          </span>
        </span>
        {action && !open && <span className="mt-0.5 shrink-0 text-body text-interactive-text">{action}</span>}
      </button>
      {open && <div className="border-t border-line-subtle px-4 pt-3 pb-4">{children}</div>}
    </div>
  );
}

/** Server mode → this computer: the server's sign-in ends, its chats stay there. */
function SwitchToLocal({ host, onCancel }: { host: string | null; onCancel(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = () => {
    setBusy(true);
    setError(undefined);
    // The window reloads onto this computer's own backend, so only a failure comes back.
    switchConnection({ mode: 'local' }).catch((e: unknown) => {
      setError(describeError(e).message);
      setBusy(false);
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-fg-muted">
        This app logs out of {host ?? 'the server'} and runs Atelier itself. Your chats on the server stay there; switch back any time.
      </p>
      {error && (
        <p role="alert" className="text-body text-danger-text">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={busy} onClick={run}>
          Switch to this computer
        </Button>
      </div>
    </div>
  );
}

/** This computer (or the server in use) → a server: its address, or one found on the network. */
function SwitchToServer({ another, onCancel }: { another: boolean; onCancel(): void }) {
  const [url, setUrl] = useState('');
  const form = useFormSubmit(z.object({ url: ServerUrl }), {}, ({ url }) => switchConnection({ mode: 'server', serverUrl: url.replace(/\/+$/, '') }));
  const pick = (found: string) => {
    setUrl(found);
    void form.submit({ url: found });
  };
  return (
    <form noValidate onSubmit={form.onSubmit({ url })} className="flex flex-col gap-4">
      <p className="text-body text-fg-muted">
        {another
          ? 'This app logs out of the server it uses now and asks you to sign in to the other one.'
          : 'This app connects to the server and asks you to sign in there. Your chats on this computer stay here; switch back any time.'}
      </p>
      <Field label="Server address" error={form.errors.url ?? form.errors.form}>
        <TextField
          type="text"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="atelier.example.com or 192.168.1.20:7340"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>
      <FoundServers disabled={form.pending} onPick={pick} />
      <div className="flex justify-end gap-2">
        <Button disabled={form.pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={form.pending}>
          {another ? 'Switch server' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}
