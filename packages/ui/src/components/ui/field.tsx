import type { ReactNode } from 'react';
import { Field as BaseField } from '@base-ui/react/field';
import { cn } from './cn.ts';

export interface FieldProps extends Omit<BaseField.Root.Props, 'className' | 'children'> {
  /** 14/14 medium label, 8px above the control. */
  label?: ReactNode;
  /** Muted help text under the control. */
  description?: ReactNode;
  /** Error message under the control. Setting it marks the field invalid. */
  error?: ReactNode;
  className?: string;
  /** The control: `TextField`, `TextArea`, `Select`, `Switch`… */
  children: ReactNode;
}

/** Labels a control and wires description and error to it (aria-labelledby / aria-describedby). */
export function Field({ label, description, error, invalid, className, children, ...props }: FieldProps) {
  const hasError = error != null && error !== false;
  return (
    <BaseField.Root {...props} invalid={invalid ?? hasError} className={cn('flex flex-col', className)}>
      {label != null && (
        <BaseField.Label className="mb-2 text-[14px]/[14px] font-medium text-fg">{label}</BaseField.Label>
      )}
      {children}
      {description != null && (
        <BaseField.Description className="mt-1.5 text-footnote text-fg-muted">{description}</BaseField.Description>
      )}
      {hasError && (
        <BaseField.Error match className="mt-1.5 text-footnote text-danger-text">
          {error}
        </BaseField.Error>
      )}
    </BaseField.Root>
  );
}
