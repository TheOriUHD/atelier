/**
 * What an SSH connection asks the person, wherever it happens (adding a connection, opening a folder, a session's runner
 * reconnecting): trust a new host's key (with its fingerprint), or give a password, with the option to keep it.
 */
import { useEffect, useState } from 'react';
import { KeyRound, ShieldQuestion } from 'lucide-react';
import type { SshPrompt } from '@atelier/protocol';
import { Button, Checkbox, Dialog, DialogContent, DialogFooter, Field, Icon, TextField, toast } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

/** Mounted once, in the app shell: the oldest waiting question first. */
export function SshPrompts() {
  const [queue, setQueue] = useState<SshPrompt[]>([]);
  useEffect(() => {
    const offAsk = rpc().on('ssh.prompt', (prompt) => setQueue((q) => (q.some((p) => p.id === prompt.id) ? q : [...q, prompt])));
    const offClosed = rpc().on('ssh.promptClosed', ({ id }) => setQueue((q) => q.filter((p) => p.id !== id)));
    return () => {
      offAsk();
      offClosed();
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  return <PromptDialog key={current.id} prompt={current} onDone={() => setQueue((q) => q.filter((p) => p.id !== current.id))} />;
}

function PromptDialog({ prompt, onDone }: { prompt: SshPrompt; onDone(): void }) {
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(false);
  const [sending, setSending] = useState(false);
  const answer = async (body: { accept?: boolean; password?: string; save?: boolean }) => {
    setSending(true);
    try {
      await rpc().call('ssh.answer', { id: prompt.id, ...body });
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      onDone();
    }
  };

  if (prompt.kind === 'hostkey') {
    return (
      <Dialog open onOpenChange={(open) => !open && void answer({ accept: false })}>
        <DialogContent title={`Trust ${prompt.connection}?`} description={`Atelier can't tell that ${prompt.host} is the machine you mean. Check its fingerprint if you can before you trust it.`}>
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-body text-fg-secondary">
              <Icon icon={ShieldQuestion} className="text-fg-muted" />
              {prompt.keyType} key fingerprint
            </p>
            <code data-selectable className="rounded-lg bg-code-background px-3 py-2 font-mono text-code break-all text-fg inset-ring inset-ring-line">
              {prompt.fingerprint}
            </code>
            <p className="text-footnote text-fg-muted">Trusting it records the key in your ~/.ssh/known_hosts, and the connection goes on.</p>
          </div>
          <DialogFooter className="mt-4">
            <Button disabled={sending} onClick={() => void answer({ accept: false })}>
              Cancel
            </Button>
            <Button variant="primary" loading={sending} onClick={() => void answer({ accept: true })}>
              Trust and connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && void answer({})}>
      <DialogContent title={`Sign in to ${prompt.connection}`} description={prompt.retry ? 'That was refused. Try again.' : prompt.prompt}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (password) void answer({ password, save: save && prompt.canSave });
          }}
          className="flex flex-col gap-4"
        >
          <Field label={/passphrase/i.test(prompt.prompt) ? 'Passphrase' : 'Password'}>
            <TextField
              autoFocus
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              placeholder={prompt.host}
            />
          </Field>
          {prompt.canSave && (
            <div className="flex items-center gap-2 text-body text-fg">
              <Checkbox aria-label="Save password" checked={save} onCheckedChange={(checked) => setSave(checked === true)} />
              <span aria-hidden className="flex items-center gap-1.5">
                <Icon icon={KeyRound} className="text-fg-muted" />
                Save password
              </span>
            </div>
          )}
          <DialogFooter className="mt-2">
            <Button disabled={sending} onClick={() => void answer({})}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={sending} disabled={!password}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
