import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { Toaster as Sonner, toast, type ToasterProps } from 'sonner';
import { Icon } from './icon.tsx';
import { Spinner } from './spinner.tsx';

export { toast };
export type { ToasterProps };

const ICONS: ToasterProps['icons'] = {
  success: <Icon icon={CircleCheck} size="sm" className="text-success" />,
  error: <Icon icon={CircleAlert} size="sm" className="text-danger" />,
  warning: <Icon icon={TriangleAlert} size="sm" className="text-warning" />,
  info: <Icon icon={Info} size="sm" className="text-fg-muted" />,
  loading: <Spinner size="sm" className="text-fg-muted" />,
};

/*
 * Toasts are unstyled Sonner toasts so the tokens apply. Sonner's own stylesheet is
 * unlayered and would beat Tailwind's layered utilities, so the motion overrides use `!`.
 */
const TOAST_OPTIONS: ToasterProps['toastOptions'] = {
  unstyled: true,
  classNames: {
    toast:
      'flex w-(--width) items-center gap-2 rounded-2xl bg-popover px-4 py-3 font-sans text-body text-fg shadow-popover duration-(--at-duration-base)! ease-out!',
    content: 'flex min-w-0 flex-1 flex-col gap-0.5',
    title: 'text-body text-fg',
    description: 'text-footnote text-fg-muted',
    icon: 'flex size-4 shrink-0 items-center justify-center',
    actionButton:
      'ml-2 inline-flex h-7 shrink-0 items-center rounded-md bg-fill-primary px-2.5 text-body font-medium text-on-primary hover:bg-fill-primary-hover focus-ring',
    cancelButton:
      'ml-2 inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-body text-fg hover:bg-fill-ghost-hover focus-ring',
  },
};

/** Bottom-center toasts on the popover surface (r12, 14/20), above modals (z 60), auto-dismiss after 4s. */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-center"
      duration={4000}
      icons={ICONS}
      toastOptions={TOAST_OPTIONS}
      style={{ zIndex: 'var(--at-layout-z-toast)' }}
      {...props}
    />
  );
}
