import type { ReactNode } from 'react';
import { Badge, cn } from '../../components/ui/index.ts';
import { settingEntry, type SettingId } from './search-index.ts';
import type { Setting } from './use-setting.ts';

/** Background flash when search lands on a row: shown instantly, then fades over 1.2s (see `flashRow`). */
const FLASH_CLASS = 'transition-[background-color] duration-[1200ms] ease-out data-flash:bg-interactive-subtle data-flash:transition-none';

export interface SettingsSectionProps {
  title: ReactNode;
  /** Makes the whole section a search target. */
  id?: SettingId;
  description?: ReactNode;
  /** Right-aligned next to the heading. */
  action?: ReactNode;
  children: ReactNode;
}

/** Bold 15/20 heading, 36 above (none for the first section) and 12 below. Narrow screens wrap the action under it when it doesn't fit. */
export function SettingsSection({ title, id, description, action, children }: SettingsSectionProps) {
  return (
    <section data-setting-row={id} className={cn('mt-9 first:mt-0', id && FLASH_CLASS)}>
      <div className="mb-3 flex min-h-5 items-center justify-between gap-4 max-md:flex-wrap">
        <h2 className="text-section-heading text-fg">{title}</h2>
        {/* Overlaps the heading's margins so a button doesn't push the heading down. */}
        {action != null && <div className="-my-1.5">{action}</div>}
      </div>
      {description != null && <p className="-mt-1 mb-3 text-body text-fg-muted">{description}</p>}
      {children}
    </section>
  );
}

export interface SettingRowProps {
  id: SettingId;
  /** The setting the control writes: adds the Project badge with Reset, and its inline error. */
  setting?: Pick<Setting<unknown>, 'origin' | 'error' | 'reset'>;
  /** Inline error from something other than `setting`. */
  error?: string | null;
  /** A line under the description that follows the row's state (an update's progress, a folder's path). */
  detail?: ReactNode;
  /** Puts the control under the text, full width (text areas). */
  stacked?: boolean;
  /** The control, or a function that receives the props naming it after the row label. */
  children: ReactNode | ((label: { 'aria-labelledby': string }) => ReactNode);
}

/**
 * Label and muted description on the left, the control on the right; pad 12 0, gap 28, a subtle
 * divider between rows. Label and description come from the search index entry. Narrow screens
 * put the control under the text, right-aligned (stacked rows: full width).
 */
export function SettingRow({ id, setting, error, detail, stacked = false, children }: SettingRowProps) {
  const entry = settingEntry(id);
  const labelId = `setting-${id}`;
  const message = error ?? setting?.error;
  return (
    <div
      data-setting-row={id}
      className={cn(
        'flex min-h-14 gap-7 border-b border-line-subtle py-3 last:border-b-0',
        stacked ? 'flex-col gap-3' : 'items-center max-md:flex-col max-md:items-end max-md:gap-3',
        FLASH_CLASS,
      )}
    >
      <div className="min-w-0 flex-1 max-md:self-stretch">
        <div className="flex items-center gap-2">
          <span id={labelId} className="text-body text-fg">
            {entry.label}
          </span>
          {setting?.origin && <OriginBadge origin={setting.origin} onReset={() => void setting.reset()} />}
        </div>
        {entry.description && <p className="mt-1 text-body text-fg-muted">{entry.description}</p>}
        {detail != null && <p className="mt-1 text-body text-fg-muted">{detail}</p>}
        {message && (
          <p role="alert" className="mt-1 text-body text-danger-text">
            {message}
          </p>
        )}
      </div>
      {typeof children === 'function' ? children({ 'aria-labelledby': labelId }) : children}
    </div>
  );
}

/** The effective value comes from the project (or local) settings file; Reset deletes it there. */
function OriginBadge({ origin, onReset }: { origin: 'project' | 'local'; onReset(): void }) {
  return (
    <>
      <Badge>{origin === 'local' ? 'Local' : 'Project'}</Badge>
      <button
        type="button"
        onClick={onReset}
        className="rounded-xs text-footnote text-interactive-text outline-none focus-ring hover:underline"
      >
        Reset
      </button>
    </>
  );
}
