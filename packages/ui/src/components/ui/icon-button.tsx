import type { LucideIcon } from 'lucide-react';
import { Button, type ButtonProps } from './button.tsx';
import { Icon, type IconSize } from './icon.tsx';
import { Tooltip } from './tooltip.tsx';

export interface IconButtonProps extends Omit<
  ButtonProps,
  'iconOnly' | 'leadingIcon' | 'trailingIcon' | 'children' | 'aria-label'
> {
  icon: LucideIcon;
  /** Accessible name, also shown as the tooltip. */
  label: string;
  /** Glyph size: 16 in controls (default), 20 in nav rows and composer buttons. */
  iconSize?: IconSize;
}

/** Square icon-only button (ghost by default) labelled by a tooltip. */
export function IconButton({ icon, label, iconSize = 'sm', variant = 'ghost', ...props }: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <Button {...props} variant={variant} iconOnly aria-label={label}>
        <Icon icon={icon} size={iconSize} />
      </Button>
    </Tooltip>
  );
}
