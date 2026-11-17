import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import qrcode from 'qrcode-generator';
import { Smartphone } from 'lucide-react';
import { pairingLink } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';
import { useDialog } from './use-dialog.ts';

/** A QR code as one path of squares, one unit each, with its quiet zone: scanners want dark on light, whatever the theme. */
export function qrModules(text: string): { size: number; path: string } {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 3;
  let path = '';
  for (let row = 0; row < count; row++)
    for (let column = 0; column < count; column++)
      if (qr.isDark(row, column)) path += `M${column + margin} ${row + margin}h1v1h-1z`;
  return { size: count + margin * 2, path };
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => qrModules(text), [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-60 rounded-lg bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

/** Asks for a code each time it opens, shows it until it runs out, and asks again on request. */
function PairBody({ onDone }: { onDone(): void }) {
  const [now, setNow] = useState(() => Date.now());
  const pair = useQuery({
    queryKey: ['account', 'pairStart'],
    queryFn: () => rpc().call('account.pairStart', {}),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ask = () => void pair.refetch();

  if (pair.isFetching) return <p className="py-10 text-center text-body text-fg-muted">Making a code…</p>;
  if (pair.error || !pair.data) {
    return (
      <>
        <p className="text-body text-danger">{describeError(pair.error).message}</p>
        <DialogFooter>
          <Button onClick={ask}>Try again</Button>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }
  const left = pair.data.expiresAt - now;
  return (
    <>
      <div className="flex flex-col items-center gap-3">
        {left > 0 ? (
          <QrCode text={pairingLink(pair.data.addresses, pair.data.pollToken)} label="QR code to sign in your phone" />
        ) : (
          <div className="grid size-60 place-items-center rounded-lg bg-sunken text-body text-fg-muted">The code ran out.</div>
        )}
        <p className="text-body text-fg-muted">{left > 0 ? `Works once, for ${clock(left)} more.` : 'Show a new code to try again.'}</p>
        <p className="text-center text-caption text-fg-muted">Anyone who scans it before it runs out signs in as you. Show it only to your own phone.</p>
      </div>
      <DialogFooter>
        <Button onClick={ask}>Show a new code</Button>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

/** Account › Sign in your phone: the QR code that the Atelier app on a phone scans to sign in as this person. */
export function PhoneSignInSection() {
  const entry = settingEntry('account.phone');
  const dialog = useDialog();
  return (
    <SettingsSection
      id="account.phone"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" leadingIcon={Smartphone} onClick={dialog.show}>
          Show QR code
        </Button>
      }
    >
      <p className="pb-3 text-body text-fg-muted">
        On your phone, open Atelier and choose Scan QR code on the sign-in screen.
      </p>
      <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
        <DialogContent
          key={dialog.key}
          title="Sign in your phone"
          description="Open Atelier on your phone, choose Scan QR code and point the camera here."
          width={440}
        >
          <PairBody onDone={() => dialog.onOpenChange(false)} />
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
