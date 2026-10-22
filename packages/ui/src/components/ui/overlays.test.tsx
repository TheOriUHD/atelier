import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from './button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';
import { Tab, Tabs, TabsList, TabsPanel } from './tabs.tsx';
import { Toaster, toast } from './toaster.tsx';
import { Tooltip, TooltipProvider } from './tooltip.tsx';

describe('Tooltip', () => {
  it('describes its trigger on focus with the tooltip surface', async () => {
    render(
      <TooltipProvider>
        <Tooltip content="New chat">
          <Button>New</Button>
        </Tooltip>
      </TooltipProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'New' });
    act(() => trigger.focus());
    fireEvent.focus(trigger);

    const tip = await screen.findByText('New chat');
    expect(tip.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-6',
        'px-2',
        'py-[3px]',
        'rounded-sm',
        'bg-tooltip-bg',
        'text-tooltip-fg',
        'text-[13px]/[18px]',
      ]),
    );
    expect(tip.className).toContain('duration-(--at-duration-snap)');
  });
});

describe('Popover', () => {
  it('opens generic content on the menu surface', async () => {
    render(
      <Popover>
        <PopoverTrigger render={<Button />}>Context</PopoverTrigger>
        <PopoverContent aria-label="Context window">
          <p>804.2k / 1M</p>
        </PopoverContent>
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Context' }));
    const popup = await screen.findByRole('dialog', { name: 'Context window' });
    expect(popup.className.split(' ')).toEqual(
      expect.arrayContaining(['rounded-2xl', 'bg-popover', 'p-1', 'shadow-popover']),
    );
    expect(screen.getByText('804.2k / 1M')).toBeTruthy();
  });
});

describe('Tabs', () => {
  it('switches panels and styles the active tab', async () => {
    render(
      <Tabs defaultValue="overview">
        <TabsList aria-label="Plugin">
          <Tab value="overview">Overview</Tab>
          <Tab value="skills">Skills</Tab>
        </TabsList>
        <TabsPanel value="overview">Overview body</TabsPanel>
        <TabsPanel value="skills">Skills body</TabsPanel>
      </Tabs>,
    );
    const overview = screen.getByRole('tab', { name: 'Overview' });
    const skills = screen.getByRole('tab', { name: 'Skills' });
    expect(overview.getAttribute('aria-selected')).toBe('true');
    expect(overview.className.split(' ')).toEqual(
      expect.arrayContaining(['h-8', 'text-body', 'text-fg-secondary', 'data-active:text-fg']),
    );
    expect(screen.getByText('Overview body')).toBeTruthy();

    fireEvent.click(skills);

    await waitFor(() => expect(skills.getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByText('Skills body')).toBeTruthy();
    const indicator = screen.getByRole('tablist').querySelector('.bg-fg');
    expect(indicator?.className).toContain('h-0.5');
  });
});

describe('Toaster', () => {
  it('shows toasts on the popover surface at bottom center', async () => {
    render(<Toaster />);
    act(() => {
      toast('Chat deleted');
    });
    const message = await screen.findByText('Chat deleted');
    const item = message.closest('[data-sonner-toast]')!;
    expect(item.className.split(' ')).toEqual(
      expect.arrayContaining(['rounded-2xl', 'bg-popover', 'shadow-popover', 'text-body']),
    );
    const toaster = document.querySelector('[data-sonner-toaster]') as HTMLElement;
    expect(toaster.getAttribute('data-y-position')).toBe('bottom');
    expect(toaster.getAttribute('data-x-position')).toBe('center');
    expect(toaster.style.zIndex).toBe('var(--at-layout-z-toast)');
  });
});
