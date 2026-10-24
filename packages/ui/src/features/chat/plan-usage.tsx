/**
 * A line above the message box once a ChatGPT subscription's limit is nearly used up (every mode); the limits
 * themselves are in the context ring's popover. Only admins can read them.
 */
import { useEffect, useRef, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { ProviderType } from '@atelier/protocol';
import { Icon, IconButton, cn } from '../../components/ui/index.ts';
import { useAccount } from '../../lib/queries.ts';
import { resetsText, useExactResets, usePlanWindows, windowName } from '../code/context-popover.tsx';

/** From this share of a window on, the line above the message box warns. */
export const NEAR_LIMIT = 90;

function useShown(provider: ProviderType | null): boolean {
  const { account } = useAccount();
  return provider === 'chatgpt' && account?.role === 'admin';
}

const DISMISSED_KEY = 'atelier.planWarningDismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * "You've used 92% of your ChatGPT 5-hour limit. Resets in 1 hr 10 min." above the message box, from 90% of a window
 * on; dismissed, it stays away until that window resets. `busy`: the session's run, after which ChatGPT has reported
 * the limits again.
 */
export function PlanLimitWarning({ provider, busy, className }: { provider: ProviderType | null; busy: boolean; className?: string }) {
  return useShown(provider) ? <NearLimit busy={busy} className={className} /> : null;
}

function NearLimit({ busy, className }: { busy: boolean; className?: string }) {
  const { status, windows, now } = usePlanWindows();
  const { refetch } = status;
  const [exact] = useExactResets();
  const [dismissed, setDismissed] = useState(readDismissed);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void refetch();
    wasBusy.current = busy;
  }, [busy, refetch]);
  const near = windows.filter((w) => w.usedPercent >= NEAR_LIMIT).sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!near) return null;
  const key = `${near.windowMinutes}:${near.resetsAt}`;
  if (dismissed === key) return null;
  const pct = Math.min(100, Math.round(near.usedPercent));
  const limit = windowName(near.windowMinutes).toLowerCase();
  const resets = resetsText(near.resetsAt, now, exact);
  const dismiss = () => {
    setDismissed(key);
    try {
      localStorage.setItem(DISMISSED_KEY, key);
    } catch {
      // Storage unavailable: it stays dismissed while the page is open.
    }
  };
  return (
    <div
      role="status"
      className={cn(
        'mx-auto mb-2 flex w-full items-center gap-2 rounded-lg py-1 pr-1 pl-2.5 text-footnote',
        pct >= 100 ? 'bg-danger-subtle text-danger-text' : 'bg-warning-subtle text-warning-text',
        className ?? 'max-w-(--at-layout-composer-width-chat)',
      )}
    >
      <Icon icon={TriangleAlert} className="shrink-0" />
      <span className="min-w-0 flex-1">
        {pct >= 100 ? `You’ve reached your ChatGPT ${limit}.` : `You’ve used ${pct}% of your ChatGPT ${limit}.`}
        {resets && ` ${resets}.`}
      </span>
      <IconButton icon={X} label="Dismiss" size="xs" className="text-current" onClick={dismiss} />
    </div>
  );
}
