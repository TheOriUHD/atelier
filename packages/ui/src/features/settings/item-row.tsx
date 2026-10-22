import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../../components/ui/index.ts';

/** A list row in a section (providers, skills, plugins): tile, text, then its controls, with subtle dividers. */
export const ITEM_ROW_CLASS = 'flex min-h-14 items-center gap-4 border-b border-line-subtle py-3 last:border-b-0';

/** The 34px icon tile (r8, 1px ring) that leads a list row; `children` sit on top of it, like a status dot. */
export function ItemTile({ icon, children }: { icon: LucideIcon; children?: ReactNode }) {
  return (
    <span className="relative flex size-[34px] shrink-0 items-center justify-center rounded-lg text-fg-secondary inset-ring inset-ring-line">
      <Icon icon={icon} size="md" />
      {children}
    </span>
  );
}
