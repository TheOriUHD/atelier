import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cn } from './cn.ts';

/** Tabs root: pairs `Tab`s with `TabsPanel`s by `value`. */
export const Tabs = BaseTabs.Root;

export interface TabsListProps extends Omit<BaseTabs.List.Props, 'className'> {
  className?: string;
}

/** Row of underline tabs; the 2px active bar slides between tabs. */
export function TabsList({ className, children, ...props }: TabsListProps) {
  return (
    <BaseTabs.List {...props} className={cn('relative flex items-center gap-4', className)}>
      {children}
      <BaseTabs.Indicator className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-fg transition-[translate,width] duration-(--at-duration-base) ease-out" />
    </BaseTabs.List>
  );
}

export interface TabProps extends Omit<BaseTabs.Tab.Props, 'className'> {
  className?: string;
}

/** 32 tall, 14/20; secondary text at rest, primary when active. */
export function Tab({ className, ...props }: TabProps) {
  return (
    <BaseTabs.Tab
      {...props}
      className={cn(
        'flex h-8 select-none items-center whitespace-nowrap rounded-sm px-0.5 font-sans text-body text-fg-secondary outline-none focus-ring',
        'hover:text-fg data-active:text-fg data-disabled:pointer-events-none data-disabled:opacity-40',
        className,
      )}
    />
  );
}

export interface TabsPanelProps extends Omit<BaseTabs.Panel.Props, 'className'> {
  className?: string;
}

export function TabsPanel({ className, ...props }: TabsPanelProps) {
  return <BaseTabs.Panel {...props} className={cn('outline-none focus-ring', className)} />;
}
