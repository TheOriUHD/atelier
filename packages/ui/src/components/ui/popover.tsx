import { Popover as BasePopover } from '@base-ui/react/popover';
import { cn } from './cn.ts';
import { popupMotionClass, popupSurfaceClass, positionerClass } from './styles.ts';

/** Popover root. Holds open state; renders no element. */
export const Popover = BasePopover.Root;

/** Opens the popover. Compose with a button via `render`. */
export const PopoverTrigger = BasePopover.Trigger;

type PositionerProps = BasePopover.Positioner.Props;

export interface PopoverContentProps extends Omit<BasePopover.Popup.Props, 'className'> {
  className?: string;
  side?: PositionerProps['side'];
  align?: PositionerProps['align'];
  sideOffset?: number;
  alignOffset?: number;
}

/** Floating panel on the menu surface (pad 4, r12, popover background and shadow) with arbitrary content. */
export function PopoverContent({
  className,
  side = 'bottom',
  align = 'center',
  sideOffset = 4,
  alignOffset = 0,
  ...props
}: PopoverContentProps) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={positionerClass}
      >
        <BasePopover.Popup {...props} className={cn(popupSurfaceClass, popupMotionClass, className)} />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
