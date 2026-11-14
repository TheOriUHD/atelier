import { useLayoutEffect, useRef, type ComponentPropsWithRef } from 'react';
import { Field as BaseField } from '@base-ui/react/field';
import { Input } from '@base-ui/react/input';
import { cn } from './cn.ts';

/** Shared by input and textarea: r8, field fill with an inset 1px ring, focus = focus shadow, invalid = danger ring. */
const CONTROL_CLASS = [
  'w-full min-w-0 rounded-lg bg-fill-field font-sans text-body text-fg inset-ring inset-ring-fill-field-ring outline-none',
  'placeholder:text-fg-muted focus-ring',
  'transition-[color,background-color,box-shadow] duration-(--at-duration-fast) ease-standard',
  'aria-invalid:inset-ring-danger data-invalid:inset-ring-danger',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ');

export interface TextFieldProps extends Omit<Input.Props, 'className' | 'render'> {
  /** Marks the value invalid (danger ring, aria-invalid). Inside a `Field`, its `error` does this too. */
  invalid?: boolean;
  className?: string;
}

/** Single-line input, 32 tall, pad 0 12. */
export function TextField({ invalid, className, ...props }: TextFieldProps) {
  return (
    <Input
      {...props}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      className={cn(CONTROL_CLASS, 'h-8 px-3', className)}
    />
  );
}

export interface TextAreaProps extends Omit<BaseField.Control.Props, 'className' | 'render'> {
  invalid?: boolean;
  rows?: ComponentPropsWithRef<'textarea'>['rows'];
  className?: string;
}

/** Multi-line input, min 80 tall, pad 8 12, resizes vertically. */
export function TextArea({ invalid, rows, className, ...props }: TextAreaProps) {
  return (
    <BaseField.Control
      {...props}
      render={<textarea rows={rows} />}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      className={cn(CONTROL_CLASS, 'min-h-20 resize-y px-3 py-2', className)}
    />
  );
}

export interface GrowingFieldProps extends Omit<ComponentPropsWithRef<'textarea'>, 'rows'> {
  invalid?: boolean;
  /** The most lines it grows to before it scrolls. */
  maxRows?: number;
}

/** Line height of `text-body`, and the field's vertical padding (one line is as tall as a `TextField`). */
const LINE_PX = 20;
const PAD_Y_PX = 12;

/**
 * A one-line field that grows with what is typed, line by line, up to `maxRows`, then scrolls: answers and revisions
 * that run long stay readable instead of sliding out of a single line. In a form, Enter sends it and Shift+Enter starts
 * a new line; elsewhere Enter starts a new line.
 */
export function GrowingField({ invalid, maxRows = 6, className, onKeyDown, value, ...props }: GrowingFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, LINE_PX * maxRows + PAD_Y_PX)}px`;
  }, [value, maxRows]);
  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      value={value}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
        const form = e.currentTarget.form;
        if (!form) return;
        e.preventDefault();
        form.requestSubmit();
      }}
      className={cn(CONTROL_CLASS, 'block resize-none overflow-y-auto px-3 py-1.5 leading-5', className)}
    />
  );
}

