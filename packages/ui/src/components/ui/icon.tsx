import type { LucideIcon, LucideProps } from 'lucide-react';
import { cn } from './cn.ts';

const ICON_PX = { sm: 16, md: 20, lg: 24 } as const;

/** 16 in menus and controls, 20 in nav rows and composer buttons, 24 for large affordances. */
export type IconSize = keyof typeof ICON_PX;

export interface IconProps extends Omit<LucideProps, 'size' | 'strokeWidth'> {
  icon: LucideIcon;
  size?: IconSize;
  /** Accessible name. Without it the icon is decorative and hidden from assistive tech. */
  label?: string;
}

export function Icon({ icon: Glyph, size = 'sm', label, className, ...props }: IconProps) {
  return (
    <Glyph
      {...props}
      size={ICON_PX[size]}
      strokeWidth={1.5}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={cn('shrink-0', className)}
    />
  );
}
