/**
 * "Make folders on this computer?": asked once, on the desktop signed in to a server, before the first session started
 * without a folder gets one made here (ARCHITECTURE §21). The answer is this computer's (its `lending.json`), and Settings
 * › System can take it back.
 */
import { useEffect, useState } from 'react';
import { FolderDot } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogFooter, Icon } from '../../components/ui/index.ts';
import { changeLending } from '../../lib/lending.ts';
import { desktop } from '../../lib/platform.ts';

let show: ((resolve: (allowed: boolean) => void) => void) | null = null;

/**
 * Whether the server may make a folder on this computer for a session started without one: asks the first time. True
 * at once outside server mode (the app's own backend makes it), false when the person says no.
 */
export async function lendScratch(): Promise<boolean> {
  if (!desktop?.lending) return true;
  const now = await desktop.lending.get();
  if (!now || now.scratch) return true;
  const allowed = await new Promise<boolean>((resolve) => (show ? show(resolve) : resolve(false)));
  if (allowed) await changeLending({ kind: 'scratch', allowed: true });
  return allowed;
}

/** Mounted once, in the app shell. */
export function LendScratchHost() {
  const [waiting, setWaiting] = useState<((allowed: boolean) => void)[]>([]);
  useEffect(() => {
    show = (resolve) => setWaiting((w) => [...w, resolve]);
    return () => {
      show = null;
    };
  }, []);
  if (!waiting.length) return null;
  const answer = (allowed: boolean) => {
    for (const resolve of waiting) resolve(allowed);
    setWaiting([]);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent
        title="Make folders on this computer?"
        description="Sessions you start without a folder get a new, empty one on this computer. Atelier's agent works in it as you: it can read, write and run commands there."
      >
        <p className="flex items-start gap-2 text-footnote text-fg-muted">
          <Icon icon={FolderDot} className="mt-0.5 shrink-0" />
          You can turn this off again in Settings › System.
        </p>
        <DialogFooter className="mt-4">
          <Button onClick={() => answer(false)}>Cancel</Button>
          <Button variant="primary" autoFocus onClick={() => answer(true)}>
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
