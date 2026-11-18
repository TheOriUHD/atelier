import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import qrcode from 'qrcode-generator';
import { Check, QrCode as QrIcon } from 'lucide-react';
import { pairingLink } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Icon, IconButton } from '../../components/ui/index.ts';
import { cn } from '../../components/ui/cn.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useAccount } from '../../lib/queries.ts';
import { FLASH_CLASS } from './setting-row.tsx';
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

/** Black squares on a white sheet in every theme: the sheet is drawn into the picture itself, so no theme colour can grey it. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => qrModules(text), [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-60 rounded-xl shadow-sm"
      style={{ background: '#ffffff' }}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/** What a phone said about itself when it signed in by QR code (`account.phonePaired`). */
export interface PairedPhone {
  name: string;
  model: string;
  appVersion: string;
}

const GENERIC_NAMES = /^(iphone|ipad|phone|ipod touch)?$/i;

/**
 * "Philipp’s iPhone": the name the phone gave itself, or, when it gave only its kind (iOS hides the name a person gave it from
 * apps that don't hold a special entitlement), the person's first name and what it is.
 */
export function pairedTitle(paired: PairedPhone, accountName: string): string {
  const given = paired.name.trim();
  if (!GENERIC_NAMES.test(given)) return given;
  const kind = /ipad/i.test(`${given} ${paired.model}`) ? 'iPad' : /iphone/i.test(`${given} ${paired.model}`) ? 'iPhone' : 'phone';
  const first = accountName.trim().split(/\s+/)[0] ?? '';
  return first ? `${first}’s ${kind}` : kind[0]!.toUpperCase() + kind.slice(1);
}

/** "iPhone 17 Pro · Atelier 1.0", with whatever of it the phone said. */
export function pairedDetail(paired: PairedPhone): string {
  return [paired.model.trim(), paired.appVersion.trim() ? `Atelier ${paired.appVersion.trim()}` : ''].filter(Boolean).join(' · ');
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

/** Asks for a code each time it opens, shows it until it runs out, and asks again on request. */
function PairBody({ onDone }: { onDone(): void }) {
  const [now, setNow] = useState(() => Date.now());
  const { account } = useAccount();
  // The phone that scans the code says so: the dialog turns into a confirmation.
  const [paired, setPaired] = useState<PairedPhone | null>(null);
  useEffect(() => rpc().on('account.phonePaired', (phone) => setPaired(phone)), []);
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

  if (paired) return <PairedBody paired={paired} accountName={account?.name ?? ''} onDone={onDone} />;
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

/** The confirmation that replaces the code: which phone signed in, and what it is. */
function PairedBody({ paired, accountName, onDone }: { paired: PairedPhone; accountName: string; onDone(): void }) {
  const detail = pairedDetail(paired);
  return (
    <>
      <div className="flex flex-col items-center gap-3 py-6 text-center" role="status">
        <span className="grid size-16 place-items-center rounded-full bg-success-subtle text-success-text motion-safe:animate-[pairedpop_0.45s_cubic-bezier(0.2,1.4,0.4,1)_both]">
          <Icon icon={Check} size="lg" />
        </span>
        <p className="text-section-heading text-fg">{pairedTitle(paired, accountName)} is logged in!</p>
        <p className="text-body text-fg-muted">{detail || 'Signed in with the QR code.'}</p>
      </div>
      <DialogFooter>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The QR icon in the Profile heading's row (Account, at the top): shows the code that the Atelier app on a phone scans to
 * sign in as this person. Its tooltip names it; the settings search finds it as "Sign in your phone".
 */
export function PairPhoneButton() {
  const dialog = useDialog();
  return (
    <span data-setting-row="account.phone" className={cn('inline-flex rounded-md', FLASH_CLASS)}>
      <IconButton icon={QrIcon} label="Pair mobile app" onClick={dialog.show} />
      <Dialog open={dialog.open} onOpenChange={dialog.onOpenChange}>
        <DialogContent
          key={dialog.key}
          title="Pair mobile app"
          description="Open Atelier on your phone, choose Scan QR code and point the camera here."
          width={440}
        >
          <PairBody onDone={() => dialog.onOpenChange(false)} />
        </DialogContent>
      </Dialog>
    </span>
  );
}
