import type { ReactElement, ReactNode } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { cn } from './cn.ts';

/** Hover delay before a tooltip opens (components.md: ~500ms). */
export const TOOLTIP_DELAY = 500;

export type TooltipProviderProps = BaseTooltip.Provider.Props;

/**
 * Shares the open delay between tooltips, so moving from one trigger to the next
 * opens the next tooltip instantly. Mount once near the app root.
 */
export function TooltipProvider({ delay = TOOLTIP_DELAY, ...props }: TooltipProviderProps) {
  return <BaseTooltip.Provider delay={delay} {...props} />;
}

export interface TooltipProps {
  content: ReactNode;
  /** The trigger. Must accept a ref and spread DOM props (any intrinsic element or `Button`). */
  children: ReactElement;
  side?: BaseTooltip.Positioner.Props['side'];
  align?: BaseTooltip.Positioner.Props['align'];
  disabled?: boolean;
  /** Milliseconds the pointer rests on the trigger before it opens. */
  delay?: number;
  className?: string;
}

export function Tooltip({ content, children, side = 'top', align = 'center', disabled, delay = TOOLTIP_DELAY, className }: TooltipProps) {
  return (
    <BaseTooltip.Root disabled={disabled} disableHoverablePopup>
      <BaseTooltip.Trigger delay={delay} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={6} className="z-(--at-layout-z-tooltip)">
          <BaseTooltip.Popup
            className={cn(
              'flex h-6 items-center whitespace-nowrap rounded-sm bg-tooltip-bg px-2 py-[3px] font-sans text-[13px]/[18px] text-tooltip-fg',
              'transition-opacity duration-(--at-duration-snap) ease-out data-starting-style:opacity-0 data-ending-style:opacity-0',
              className,
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
