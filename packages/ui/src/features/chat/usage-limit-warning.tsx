import { useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { LimitWarning } from '@atelier/protocol';
import { Icon, IconButton, cn } from '../../components/ui/index.ts';
import { useOpenSettings } from '../../app/navigation.ts';

/**
 * "You've used 82% of your limit of 1,000,000 tokens (tokens per day)." above the message box, once per limit and
 * period (the backend decides when), until the person's next turn or until they dismiss it.
 */
export function UsageLimitWarning({ warning, className }: { warning: LimitWarning | null | undefined; className?: string }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const openSettings = useOpenSettings();
  if (!warning || dismissed === warning.message) return null;
  return (
    <div
      role="status"
      className={cn('mx-auto mb-2 flex w-full items-center gap-2 rounded-lg bg-warning-subtle py-1 pr-1 pl-2.5 text-footnote text-warning-text', className ?? 'max-w-(--at-layout-composer-width-chat)')}
    >
      <Icon icon={TriangleAlert} className="shrink-0" />
      <span className="min-w-0 flex-1">{warning.message}</span>
      <button type="button" onClick={() => openSettings('usage')} className="shrink-0 rounded-xs underline underline-offset-2 outline-none focus-ring">
        Usage
      </button>
      <IconButton icon={X} label="Dismiss" size="xs" className="text-current" onClick={() => setDismissed(warning.message)} />
    </div>
  );
}
