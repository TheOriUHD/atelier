import type { ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';
import {
  itemClass,
  itemOneLineClass,
  popupMotionClass,
  popupScrollClass,
  popupSurfaceClass,
  positionerClass,
} from './styles.ts';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  options: readonly SelectOption<V>[];
  value?: V;
  defaultValue?: V;
  onValueChange?: (value: V) => void;
  /**
   * `ghost`: borderless, value right-aligned with a muted chevron (settings rows).
   * `field`: full-width input-style box (forms).
   */
  variant?: 'ghost' | 'field';
  placeholder?: string;
  /** Custom rendering for an option, used in the list and for the selected value (e.g. a font preview). */
  renderOption?: (option: SelectOption<V>) => ReactNode;
  disabled?: boolean;
  name?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Class for the trigger. */
  className?: string;
}

const TRIGGER_CLASS = {
  ghost:
    'inline-flex h-8 items-center justify-end gap-1.5 rounded-lg pl-2 text-right hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover',
  field:
    'flex h-8 w-full items-center justify-between gap-2 rounded-lg bg-fill-field pr-2 pl-3 text-left inset-ring inset-ring-fill-field-ring',
} as const;

/** The field list is at least as wide as its box; the ghost list gets a menu-like minimum. */
const POPUP_WIDTH_CLASS = {
  ghost: 'min-w-40',
  field: 'min-w-(--anchor-width)',
} as const;

export function Select<V extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  variant = 'ghost',
  placeholder,
  renderOption,
  disabled,
  name,
  id,
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SelectProps<V>) {
  const display = (option: SelectOption<V>) => (renderOption ? renderOption(option) : option.label);

  return (
    <BaseSelect.Root<V>
      items={options}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next);
      }}
      disabled={disabled}
      name={name}
      id={id}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(
          'min-w-0 cursor-default select-none font-sans text-body text-fg outline-none focus-ring',
          'data-disabled:pointer-events-none data-disabled:opacity-40',
          TRIGGER_CLASS[variant],
          className,
        )}
      >
        <BaseSelect.Value className="min-w-0 truncate data-placeholder:text-fg-muted" placeholder={placeholder}>
          {(selected: V | null) => {
            const option = options.find((candidate) => candidate.value === selected);
            return option ? display(option) : placeholder;
          }}
        </BaseSelect.Value>
        <BaseSelect.Icon className="flex shrink-0 text-fg-muted">
          <Icon icon={ChevronDown} size="sm" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          alignItemWithTrigger={false}
          side="bottom"
          align={variant === 'ghost' ? 'end' : 'start'}
          sideOffset={4}
          className={positionerClass}
        >
          <BaseSelect.Popup className={cn(popupSurfaceClass, popupMotionClass, POPUP_WIDTH_CLASS[variant])}>
            <BaseSelect.List className={popupScrollClass}>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  label={option.label}
                  disabled={option.disabled}
                  className={cn(itemClass, itemOneLineClass)}
                >
                  <BaseSelect.ItemText className="min-w-0 flex-1 truncate">{display(option)}</BaseSelect.ItemText>
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <BaseSelect.ItemIndicator>
                      <Icon icon={Check} size="sm" className="text-interactive" />
                    </BaseSelect.ItemIndicator>
                  </span>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
