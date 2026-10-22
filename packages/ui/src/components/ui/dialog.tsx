import type { ComponentPropsWithRef, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { cn } from './cn.ts';
import { IconButton } from './icon-button.tsx';
import { dialogBackdropClass, dialogPopupClass } from './styles.ts';

/** Dialog root. Holds open state; renders no element. */
export const Dialog = BaseDialog.Root;

/** Opens the dialog. Compose with a button via `render`. */
export const DialogTrigger = BaseDialog.Trigger;

/** Closes the dialog. Compose with a button via `render`. */
export const DialogClose = BaseDialog.Close;

export interface DialogContentProps extends Omit<BaseDialog.Popup.Props, 'className' | 'style' | 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Popup width in px (default 520). */
  width?: number;
  className?: string;
}

/**
 * Portal, backdrop and popup (pad 24) with a 22/28 title, an optional description,
 * and a 32px close button aligned with the title.
 */
export function DialogContent({ title, description, width = 520, className, children, ...props }: DialogContentProps) {
  return (
    <BaseDialog.Portal>
      {/* Base UI leaves a nested dialog without a backdrop (and so without its click-away): forced on, and lighter, as it lies over another one. */}
      <BaseDialog.Backdrop forceRender className={cn(dialogBackdropClass, 'has-[+[data-nested]]:opacity-60')} />
      <BaseDialog.Popup {...props} style={{ width }} className={cn(dialogPopupClass, 'p-6', className)}>
        <BaseDialog.Title className="pr-10 text-title text-fg">{title}</BaseDialog.Title>
        {description != null && (
          <BaseDialog.Description className="mt-2 text-body text-fg-secondary">{description}</BaseDialog.Description>
        )}
        <div className="mt-6">{children}</div>
        <BaseDialog.Close
          render={<IconButton icon={X} label="Close" iconSize="md" className="absolute top-[22px] right-4" />}
        />
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export type DialogFooterProps = ComponentPropsWithRef<'div'>;

/** Right-aligned action row, 24 below the body, 12 between buttons. */
export function DialogFooter({ className, ...props }: DialogFooterProps) {
  return <div {...props} className={cn('mt-6 flex items-center justify-end gap-3', className)} />;
}
