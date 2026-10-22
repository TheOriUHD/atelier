/**
 * "Trust this workspace?": asked each time a folder new to the person's list is about to be used (a local folder they
 * picked, a folder on an SSH host, a repository's codespace), because the agent may read, write and run
 * commands there and the folder may bring its own settings and hooks. A codespace the backend doesn't trust yet (one added
 * before this question existed) is asked about when a session is about to start in it, and in Settings › Folders.
 */
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { WorkspaceSummary } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Icon } from '../../components/ui/index.ts';
import { desktop } from '../../lib/platform.ts';
import { rpc } from '../../lib/rpc.ts';

interface Request {
  path: string;
  host: string | null;
  resolve(trusted: boolean): void;
}

let show: ((request: Request) => void) | null = null;

/** Asks the person; resolves false when they cancel. True at once when no window can ask (nothing mounted). */
export function requestTrust(path: string, host: string | null = null): Promise<boolean> {
  return new Promise((resolve) => (show ? show({ path, host, resolve }) : resolve(true)));
}

/** How a codespace is named in the question: its own name when it exists, else the kind of place it will be. */
export const codespaceWhere = (name?: string | null): string => (name ? `GitHub codespace ${name}` : 'a GitHub codespace');

/**
 * Asks about a workspace the backend doesn't trust yet and tells it the answer: false when the person says no. Trusted
 * ones (and servers that don't say) pass at once.
 */
export async function trustWorkspace(workspace: WorkspaceSummary): Promise<boolean> {
  if (workspace.trusted !== false) return true;
  if (!(await requestTrust(workspace.root, workspace.kind === 'codespace' ? codespaceWhere(workspace.host) : workspace.host))) return false;
  await rpc().call('workspaces.trust', { id: workspace.id });
  return true;
}

/**
 * Picks a folder on this computer with the native dialog and has it trusted: false (null) when cancelled or the person
 * says no. A folder already in their list isn't asked about again.
 */
export async function chooseLocalFolder(): Promise<string | null> {
  const picked = await desktop!.folders.pick();
  if (!picked) return null;
  const known = (await rpc().call('workspaces.list', {})).some((w) => w.kind === 'local' && !w.host && !w.deviceId && w.root === picked);
  if (!known && !(await requestTrust(picked))) return null;
  return desktop!.folders.trust(picked);
}

/** Mounted once, in the app shell. */
export function TrustWorkspaceHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  useEffect(() => {
    show = (request) => setQueue((q) => [...q, request]);
    return () => {
      show = null;
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const answer = (trusted: boolean) => {
    current.resolve(trusted);
    setQueue((q) => q.slice(1));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent
        title="Trust this workspace?"
        description="Atelier's agent may read, write, or run commands in this folder, as you. Only go on if you trust what is in it."
      >
        <div className="flex flex-col gap-1.5">
          <code data-selectable className="flex items-start gap-2 rounded-lg bg-code-background px-3 py-2 font-mono text-code break-all text-fg inset-ring inset-ring-line">
            <Icon icon={ShieldAlert} className="mt-0.5 shrink-0 text-fg-muted" />
            {current.path}
          </code>
          {current.host && <p className="text-footnote text-fg-muted">on {current.host}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button onClick={() => answer(false)}>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => answer(true)}>
            Trust workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
