import type { ComponentPropsWithRef, MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';
import { Spinner } from './spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  /** Control height: xs 24, sm 28, md 32 (default), lg 40. */
  size?: ButtonSize;
  /** Square button sized to the control height; pass the icon as children. */
  iconOnly?: boolean;
  leadingIcon?: LucideIcon;
  trailingIcon?: LucideIcon;
  /** Shows a spinner in place of the content, keeps the width, and ignores presses. */
  loading?: boolean;
}

const BASE_CLASS = [
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-sans outline-none',
  // Box-shadow eases in 60ms (standard); the press scale settles on the spring curve.
  '[transition:box-shadow_var(--at-duration-fast)_var(--at-ease-standard),scale_var(--at-duration-base)_var(--at-ease-spring)]',
  'active:scale-99 focus-ring',
  'disabled:pointer-events-none disabled:opacity-40',
  'aria-disabled:pointer-events-none aria-disabled:not-aria-busy:opacity-40',
].join(' ');

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-fill-primary font-medium text-on-primary hover:bg-fill-primary-hover',
  secondary:
    'bg-fill-secondary text-fg inset-ring inset-ring-fill-secondary-ring hover:bg-fill-secondary-hover data-popup-open:bg-fill-secondary-hover',
  ghost: 'bg-transparent text-fg hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover',
  danger: 'bg-danger font-medium text-[color:white] hover:bg-danger-hover',
  brand: 'bg-accent font-medium text-on-accent hover:bg-accent-hover',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1.5 rounded-sm px-2 text-control-sm',
  sm: 'h-7 gap-1.5 rounded-md px-2.5 text-body',
  md: 'h-8 gap-2 rounded-lg px-3 text-body',
  lg: 'h-10 gap-2 rounded-xl px-4 text-body',
};

const ICON_ONLY_CLASS: Record<ButtonSize, string> = {
  xs: 'size-6 rounded-sm text-control-sm',
  sm: 'size-7 rounded-md text-body',
  md: 'size-8 rounded-lg text-body',
  lg: 'size-10 rounded-xl text-body',
};

function preventPress(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

export function Button({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  leadingIcon,
  trailingIcon,
  loading = false,
  className,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const ariaDisabled = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  const blocked = loading || ariaDisabled;

  return (
    <button
      type="button"
      {...props}
      aria-busy={loading || undefined}
      aria-disabled={blocked || undefined}
      onClick={blocked ? preventPress : onClick}
      className={cn(
        BASE_CLASS,
        VARIANT_CLASS[variant],
        iconOnly ? ICON_ONLY_CLASS[size] : SIZE_CLASS[size],
        // Positioned only while the spinner overlay needs it, so callers can place the button absolutely.
        loading && 'relative',
        className,
      )}
    >
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size="sm" />
        </span>
      )}
      <span className={cn('contents', loading && 'invisible')}>
        {leadingIcon && <Icon icon={leadingIcon} size="sm" />}
        {children}
        {trailingIcon && <Icon icon={trailingIcon} size="sm" />}
      </span>
    </button>
  );
}
