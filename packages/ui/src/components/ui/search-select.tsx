import { Check, ChevronDown } from 'lucide-react';
import { Combobox } from '@base-ui/react/combobox';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';
import type { SelectOption } from './select.tsx';
import { itemClass, itemOneLineClass, popupMotionClass, popupScrollClass, popupSurfaceClass, positionerClass, popupCollisionPadding } from './styles.ts';

export interface SearchSelectProps<V extends string = string> {
  options: readonly SelectOption<V>[];
  value?: V | undefined;
  onValueChange?: (value: V) => void;
  /** Shown in the empty box; typing in it filters the list. */
  placeholder?: string;
  /** What the list says when nothing matches. */
  empty?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

/**
 * A form field that picks one of many options by typing part of its name: the field variant of Select, for lists too
 * long to scroll through (every model of every provider, say). The box shows the chosen option and filters the list as
 * the person types.
 */
export function SearchSelect<V extends string = string>({
  options,
  value,
  onValueChange,
  placeholder,
  empty = 'Nothing matches.',
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SearchSelectProps<V>) {
  const selected = options.find((option) => option.value === value) ?? null;
  return (
    <Combobox.Root<SelectOption<V>>
      items={options}
      value={selected}
      onValueChange={(next) => {
        if (next) onValueChange?.(next.value);
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(option) => option.label}
      disabled={disabled}
      autoHighlight
    >
      <div className={cn('relative w-full min-w-0', className)}>
        <Combobox.Input
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          placeholder={placeholder}
          className={cn(
            'h-8 w-full min-w-0 rounded-lg bg-fill-field pr-8 pl-3 font-sans text-body text-fg inset-ring inset-ring-fill-field-ring outline-none',
            'placeholder:text-fg-muted focus-ring',
            'transition-[color,background-color,box-shadow] duration-(--at-duration-fast) ease-standard',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        />
        <Combobox.Trigger
          aria-label="Show all"
          className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-fg-muted outline-none disabled:opacity-40"
        >
          <Icon icon={ChevronDown} size="sm" />
        </Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner collisionPadding={popupCollisionPadding} side="bottom" align="start" sideOffset={4} className={positionerClass}>
          <Combobox.Popup className={cn(popupSurfaceClass, popupMotionClass, 'w-(--anchor-width) max-w-(--available-width)')}>
            <Combobox.Empty className="px-2.5 py-1.5 text-body text-fg-muted empty:hidden">{empty}</Combobox.Empty>
            <Combobox.List className={cn(popupScrollClass, 'max-h-[min(var(--available-height),20rem)]')}>
              {(option: SelectOption<V>) => (
                <Combobox.Item key={option.value} value={option} disabled={option.disabled} className={cn(itemClass, itemOneLineClass)}>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <Combobox.ItemIndicator>
                      <Icon icon={Check} size="sm" className="text-interactive" />
                    </Combobox.ItemIndicator>
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
