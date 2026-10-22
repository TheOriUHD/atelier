import type { KeyboardEventHandler, ReactNode } from 'react';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';
import {
  itemClass,
  itemHintClass,
  itemOneLineClass,
  itemTwoLineClass,
  popupMotionClass,
  popupScrollClass,
  popupSurfaceClass,
  positionerClass,
} from './styles.ts';

/** Menu root. Holds open state; renders no element. */
export const Menu = BaseMenu.Root;

/** Opens the menu. Compose with a button: `<MenuTrigger render={<Button variant="ghost" />}>…</MenuTrigger>`. */
export const MenuTrigger = BaseMenu.Trigger;

/** Groups related items so a `MenuLabel` can name them. */
export const MenuGroup = BaseMenu.Group;

/** Single-choice group for `MenuRadioItem`s. */
export const MenuRadioGroup = BaseMenu.RadioGroup;

type PositionerProps = BaseMenu.Positioner.Props;

export interface MenuContentProps extends Omit<BaseMenu.Popup.Props, 'className'> {
  className?: string;
  side?: PositionerProps['side'];
  align?: PositionerProps['align'];
  sideOffset?: number;
  alignOffset?: number;
  /** Where it opens instead of at the trigger, such as the pointer of a right-click. */
  anchor?: PositionerProps['anchor'];
}

/** The floating list: portal + positioner + popup (pad 4, r12, popover surface). Opens 4px from the trigger. */
export function MenuContent({
  className,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  alignOffset = 0,
  anchor,
  ...props
}: MenuContentProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        className={positionerClass}
      >
        <BaseMenu.Popup
          {...props}
          className={cn(popupSurfaceClass, popupScrollClass, popupMotionClass, 'min-w-48', className)}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

interface ItemBodyProps {
  icon?: LucideIcon | undefined;
  description?: ReactNode;
  children?: ReactNode;
}

/** Leading 16px icon in a 20px slot, then the label (and the muted second line). */
function ItemBody({ icon, description, children }: ItemBodyProps) {
  return (
    <>
      {icon && (
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Icon icon={icon} size="sm" />
        </span>
      )}
      {description == null ? (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{children}</span>
          <span className="truncate text-footnote text-fg-muted">{description}</span>
        </span>
      )}
    </>
  );
}

/** Row recipe: 32 tall, or 50 tall with a description. */
function rowClass(description: ReactNode) {
  return cn(itemClass, description == null ? itemOneLineClass : itemTwoLineClass);
}

function SelectedCheck() {
  return <Icon icon={Check} size="sm" className="text-interactive" />;
}

export interface MenuItemProps extends Omit<BaseMenu.Item.Props, 'className' | 'children'> {
  className?: string;
  children?: ReactNode;
  icon?: LucideIcon;
  /** Muted second line. */
  description?: ReactNode;
  /** Right-aligned hint such as a key ("P") or chord ("⌘U"). */
  shortcut?: ReactNode;
  /** Destructive action, rendered in danger text. */
  danger?: boolean;
}

export function MenuItem({ icon, description, shortcut, danger, className, children, ...props }: MenuItemProps) {
  return (
    <BaseMenu.Item {...props} className={cn(rowClass(description), danger && 'text-danger-text', className)}>
      <ItemBody icon={icon} description={description}>
        {children}
      </ItemBody>
      {shortcut != null && <span className={itemHintClass}>{shortcut}</span>}
    </BaseMenu.Item>
  );
}

export interface MenuCheckboxItemProps extends Omit<BaseMenu.CheckboxItem.Props, 'className' | 'children'> {
  className?: string;
  children?: ReactNode;
  icon?: LucideIcon;
  description?: ReactNode;
}

/** Toggles a setting; a blue check marks the on state. Stays open when pressed. */
export function MenuCheckboxItem({ icon, description, className, children, ...props }: MenuCheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem {...props} className={cn(rowClass(description), className)}>
      <ItemBody icon={icon} description={description}>
        {children}
      </ItemBody>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <BaseMenu.CheckboxItemIndicator>
          <SelectedCheck />
        </BaseMenu.CheckboxItemIndicator>
      </span>
    </BaseMenu.CheckboxItem>
  );
}

/**
 * A setting that is on or off, drawn as a small switch on the right (a `menuitemcheckbox` to assistive tech).
 * Stays open when pressed.
 */
export function MenuSwitchItem({ icon, description, className, children, ...props }: MenuCheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem {...props} className={cn(rowClass(description), 'group/switch', className)}>
      <ItemBody icon={icon} description={description}>
        {children}
      </ItemBody>
      <span
        aria-hidden
        className={cn(
          'flex h-[18px] w-8 shrink-0 items-center self-center rounded-full bg-switch-track p-0.5',
          'transition-[background-color] duration-(--at-duration-snap) ease-standard group-data-checked/switch:bg-interactive',
        )}
      >
        <span className="block size-3.5 rounded-full bg-switch-knob shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[translate] duration-(--at-duration-snap) ease-overshoot group-data-checked/switch:translate-x-3.5" />
      </span>
    </BaseMenu.CheckboxItem>
  );
}

export interface MenuRadioItemProps extends Omit<BaseMenu.RadioItem.Props, 'className' | 'children'> {
  className?: string;
  children?: ReactNode;
  icon?: LucideIcon;
  description?: ReactNode;
}

/** One option of a `MenuRadioGroup`; the selected one shows a blue check on the right. */
export function MenuRadioItem({ icon, description, className, children, ...props }: MenuRadioItemProps) {
  return (
    <BaseMenu.RadioItem {...props} className={cn(rowClass(description), className)}>
      <ItemBody icon={icon} description={description}>
        {children}
      </ItemBody>
      <span className="flex size-5 shrink-0 items-center justify-center">
        <BaseMenu.RadioItemIndicator>
          <SelectedCheck />
        </BaseMenu.RadioItemIndicator>
      </span>
    </BaseMenu.RadioItem>
  );
}

export interface MenuSeparatorProps extends Omit<BaseMenu.Separator.Props, 'className'> {
  className?: string;
}

/** 1px rule inset 10 with 4px vertical margin. */
export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return <BaseMenu.Separator {...props} className={cn('mx-2.5 my-1 h-px bg-line', className)} />;
}

export interface MenuLabelProps extends Omit<BaseMenu.GroupLabel.Props, 'className'> {
  className?: string;
}

/** Section label (13 muted). Place inside a `MenuGroup` or `MenuRadioGroup` so it names the group. */
export function MenuLabel({ className, ...props }: MenuLabelProps) {
  return (
    <BaseMenu.GroupLabel
      {...props}
      className={cn('cursor-default select-none px-2.5 pt-1.5 pb-1 text-footnote text-fg-muted', className)}
    />
  );
}

export interface MenuSubmenuProps {
  label: ReactNode;
  icon?: LucideIcon;
  /** Current value shown muted before the chevron (e.g. the selected effort). */
  hint?: ReactNode;
  disabled?: boolean;
  /** Class for the submenu popup. */
  className?: string;
  /** Class for the row that opens it, to match taller sibling rows. */
  triggerClassName?: string;
  /** Key presses inside the nested menu, for numbered items. */
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  /** Items of the nested menu. */
  children: ReactNode;
}

/**
 * Row with a trailing chevron that opens a nested menu to the side on hover or
 * ArrowRight. The nested popup lines its first row up with the trigger row.
 */
export function MenuSubmenu({ label, icon, hint, disabled, className, triggerClassName, onKeyDown, children }: MenuSubmenuProps) {
  return (
    <BaseMenu.SubmenuRoot>
      <BaseMenu.SubmenuTrigger
        disabled={disabled}
        label={typeof label === 'string' ? label : undefined}
        className={cn(itemClass, itemOneLineClass, 'data-popup-open:bg-fill-ghost-hover', triggerClassName)}
      >
        <ItemBody icon={icon}>{label}</ItemBody>
        {hint != null && <span className={itemHintClass}>{hint}</span>}
        <Icon icon={ChevronRight} size="sm" className="text-fg-muted" />
      </BaseMenu.SubmenuTrigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          side="inline-end"
          align="start"
          sideOffset={0}
          alignOffset={-4}
          className={positionerClass}
        >
          <BaseMenu.Popup onKeyDown={onKeyDown} className={cn(popupSurfaceClass, popupScrollClass, popupMotionClass, 'min-w-48', className)}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.SubmenuRoot>
  );
}
