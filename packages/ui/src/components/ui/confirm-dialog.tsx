import { useRef, useState, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Button } from './button.tsx';
import { cn } from './cn.ts';
import { dialogBackdropClass, dialogPopupClass } from './styles.ts';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Label of the destructive action (default "Delete"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Runs the action. A returned promise keeps the dialog open with a spinner on the
   * confirm button; the dialog closes when it resolves and stays open if it rejects.
   */
  onConfirm: () => void | Promise<void>;
  className?: string;
}

/** Destructive confirmation (400 wide, pad 20). Focus starts on the confirm button. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  className,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const confirm = async () => {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={dialogBackdropClass} />
        <AlertDialog.Popup
          initialFocus={confirmRef}
          style={{ width: 400 }}
          className={cn(dialogPopupClass, 'p-5', className)}
        >
          <AlertDialog.Title className="text-section-heading text-fg">{title}</AlertDialog.Title>
          {description != null && (
            <AlertDialog.Description className="mt-1 text-body text-fg-secondary">
              {description}
            </AlertDialog.Description>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            <AlertDialog.Close disabled={pending} render={<Button variant="secondary" />}>
              {cancelLabel}
            </AlertDialog.Close>
            <Button ref={confirmRef} variant="danger" loading={pending} onClick={() => void confirm()}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
