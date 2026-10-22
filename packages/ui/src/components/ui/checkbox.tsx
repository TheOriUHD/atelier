import { Check, Minus } from 'lucide-react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';

export interface CheckboxProps extends Omit<BaseCheckbox.Root.Props, 'className' | 'children' | 'render'> {
  className?: string;
}

/** 16px box, r4: a 1px strong ring when off; the interactive (blue) fill with a white check, or a dash when mixed. */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      {...props}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-xs text-on-interactive inset-ring inset-ring-line-strong outline-none focus-ring',
        'data-checked:bg-interactive data-checked:inset-ring-0 data-indeterminate:bg-interactive data-indeterminate:inset-ring-0',
        'data-disabled:pointer-events-none data-disabled:opacity-40',
        className,
      )}
    >
      <BaseCheckbox.Indicator className="flex">
        <Icon icon={props.indeterminate ? Minus : Check} className="size-3" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
