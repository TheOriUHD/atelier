import { useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { cn } from './cn.ts';
import { Icon } from './icon.tsx';
import { Tooltip } from './tooltip.tsx';

export interface SegmentedControlItem<V extends string = string> {
  value: V;
  /** Visible text, or the accessible name and tooltip in the icon variant. */
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  items: readonly SegmentedControlItem<V>[];
  value?: V;
  defaultValue?: V;
  onValueChange?: (value: V) => void;
  /** `icon` renders 30×30 icon-only segments (32×26 at sm, like the sidebar's mode switch). */
  variant?: 'text' | 'icon';
  /** Track height: md 32 (default), sm 28 (panel headers, the sidebar header), xs 24 (cards). */
  size?: 'xs' | 'sm' | 'md';
  disabled?: boolean;
  name?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
}

const ITEM_CLASS = [
  'relative inline-flex h-[30px] items-center justify-center gap-1.5 rounded-sm text-body text-fg-secondary outline-none focus-ring',
  'data-unchecked:hover:text-fg data-checked:text-fg data-disabled:pointer-events-none data-disabled:opacity-40',
].join(' ');

/**
 * Single-choice control on a track. Arrow keys move the selection; the thumb is a
 * positioned element that slides to the checked segment (200ms ease-out).
 */
export function SegmentedControl<V extends string = string>({
  items,
  value,
  defaultValue,
  onValueChange,
  variant = 'text',
  size = 'md',
  className,
  ...groupProps
}: SegmentedControlProps<V>) {
  const small = size === 'sm';
  const tiny = size === 'xs';
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? items[0]?.value);
  const current = value ?? uncontrolledValue;
  const activeIndex = items.findIndex((item) => item.value === current);

  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!track || !thumb) return;

    const place = () => {
      const segment = track.querySelectorAll<HTMLElement>('[data-segment]')[activeIndex];
      if (!segment) {
        thumb.style.visibility = 'hidden';
        return;
      }
      thumb.style.visibility = '';
      thumb.style.width = `${segment.offsetWidth}px`;
      thumb.style.translate = `${segment.offsetLeft}px 0`;
    };

    place();
    if (!thumb.hasAttribute('data-ready')) {
      // Commit the first position before enabling the transition so the thumb does not slide in on mount.
      void thumb.offsetWidth;
      thumb.setAttribute('data-ready', '');
    }

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(track);
    return () => observer.disconnect();
  }, [activeIndex, items]);

  return (
    <RadioGroup
      {...groupProps}
      ref={trackRef}
      value={current}
      onValueChange={(next: V) => {
        if (value === undefined) setUncontrolledValue(next);
        onValueChange?.(next);
      }}
      className={cn(
        'relative inline-flex h-8 shrink-0 items-center rounded-lg bg-segmented-track p-px',
        small && 'h-7 rounded-md',
        tiny && 'h-6 rounded-sm',
        'data-disabled:opacity-40',
        className,
      )}
    >
      <span
        ref={thumbRef}
        aria-hidden
        className={cn(
          'pointer-events-none absolute top-px left-0 h-[30px] rounded-sm bg-segmented-thumb shadow-field-drop',
          small && 'h-[26px]',
          tiny && 'h-[22px] rounded-[5px]',
          'data-ready:transition-[translate,width] data-ready:duration-(--at-duration-base) data-ready:ease-out',
        )}
      />
      {items.map((item) => {
        if (variant === 'icon' && item.icon) {
          return (
            <Tooltip key={item.value} content={item.label}>
              <Radio.Root
                value={item.value}
                disabled={item.disabled}
                aria-label={item.label}
                data-segment=""
                className={cn(ITEM_CLASS, small ? 'h-[26px] w-8' : 'w-[30px]')}
              >
                <Icon icon={item.icon} size={small ? 'sm' : 'md'} />
              </Radio.Root>
            </Tooltip>
          );
        }
        return (
          <Radio.Root
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            data-segment=""
            className={cn(ITEM_CLASS, 'px-3', small && 'h-[26px] px-2.5 text-control-sm', tiny && 'h-[22px] rounded-[5px] px-2 text-caption')}
          >
            {item.icon && <Icon icon={item.icon} size="sm" />}
            {item.label}
          </Radio.Root>
        );
      })}
    </RadioGroup>
  );
}
