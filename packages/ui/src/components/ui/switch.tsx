import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { cn } from './cn.ts';

export type SwitchSize = 'sm' | 'md';

export interface SwitchProps extends Omit<BaseSwitch.Root.Props, 'className' | 'children' | 'render'> {
  /** md 36×20 (settings rows, default), sm 32×18 (menus). */
  size?: SwitchSize;
  className?: string;
}

const SIZE_CLASS: Record<SwitchSize, { root: string; thumb: string }> = {
  md: { root: 'h-5 w-9', thumb: 'size-4 data-checked:translate-x-4' },
  sm: { root: 'h-[18px] w-8', thumb: 'size-3.5 data-checked:translate-x-3.5' },
};

export function Switch({ size = 'md', className, ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root
      {...props}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full bg-switch-track p-0.5 outline-none focus-ring',
        'transition-[background-color] duration-(--at-duration-snap) ease-standard',
        'data-unchecked:hover:bg-switch-track-hover data-checked:bg-interactive',
        'data-disabled:pointer-events-none data-disabled:opacity-40',
        SIZE_CLASS[size].root,
        className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'block rounded-full bg-switch-knob shadow-[0_1px_2px_rgb(0_0_0/0.2)]',
          'transition-[translate] duration-(--at-duration-snap) ease-overshoot',
          SIZE_CLASS[size].thumb,
        )}
      />
    </BaseSwitch.Root>
  );
}
