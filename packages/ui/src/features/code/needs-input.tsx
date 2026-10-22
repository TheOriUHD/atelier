/**
 * "Needs your input": at the end of the transcript while the run waits on an ask (a permission, a question, a plan, a
 * folder). The ask itself is docked at the message box; this says why the run is quiet and takes the person there.
 */
import { ChevronRight } from 'lucide-react';
import { Icon } from '../../components/ui/index.ts';

export function NeedsInput() {
  return (
    <button
      type="button"
      onClick={() => {
        const ask = document.querySelector<HTMLElement>('[data-ask]');
        ask?.focus();
        ask?.scrollIntoView({ block: 'nearest' });
      }}
      className="inline-flex items-center gap-2 self-start rounded-sm text-body text-warning-text outline-none focus-ring"
    >
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-current">
        <span className="size-1.5 rounded-full bg-current" />
      </span>
      Needs your input
      <Icon icon={ChevronRight} />
    </button>
  );
}
