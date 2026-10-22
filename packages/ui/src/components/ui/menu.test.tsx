import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Pencil, Pin, Trash2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button.tsx';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuTrigger,
} from './menu.tsx';

function ChatMenu({ onRename = () => {}, onDelete = () => {} }: { onRename?: () => void; onDelete?: () => void }) {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" />}>Options</MenuTrigger>
      <MenuContent>
        <MenuItem icon={Pin} shortcut="P">
          Pin
        </MenuItem>
        <MenuItem icon={Pencil} shortcut="R" onClick={onRename}>
          Rename
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} shortcut="D" danger onClick={onDelete}>
          Delete
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

async function openMenu(name = 'Options') {
  const trigger = screen.getByRole('button', { name });
  fireEvent.click(trigger);
  return screen.findByRole('menu');
}

describe('Menu', () => {
  it('opens from its trigger and renders the popover surface', async () => {
    render(<ChatMenu />);
    const trigger = screen.getByRole('button', { name: 'Options' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    const menu = await openMenu();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(menu.className.split(' ')).toEqual(
      expect.arrayContaining(['rounded-2xl', 'bg-popover', 'p-1', 'shadow-popover']),
    );
    expect(menu.className).toContain('duration-(--at-duration-snap)');
    expect(menu.className).toContain('ease-snap');
    expect(menu.className).toContain('data-ending-style:duration-(--at-duration-fast)');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['PinP', 'RenameR', 'DeleteD']);
    expect(screen.getByRole('separator').className.split(' ')).toEqual(
      expect.arrayContaining(['mx-2.5', 'my-1', 'h-px', 'bg-line']),
    );
  });

  it('styles rows: 32 tall, pad 6 10, r8, highlight on hover, danger text', async () => {
    render(<ChatMenu />);
    await openMenu();
    const pin = screen.getByRole('menuitem', { name: /Pin/ });
    expect(pin.className.split(' ')).toEqual(
      expect.arrayContaining([
        'min-h-8',
        'px-2.5',
        'py-1.5',
        'rounded-lg',
        'gap-2',
        'data-highlighted:bg-fill-ghost-hover',
      ]),
    );
    expect(pin.querySelector('.size-5 svg')?.getAttribute('width')).toBe('16');
    expect(screen.getByText('P').className).toContain('text-fg-muted');
    const danger = screen.getByRole('menuitem', { name: /Delete/ }).className.split(' ');
    expect(danger).toContain('text-danger-text');
    // cn() does not dedupe, so rows must not also carry a base text color that could win.
    expect(danger.filter((name) => /^text-(fg|danger)/.test(name))).toEqual(['text-danger-text']);
  });

  it('runs the item action and closes when an item is chosen', async () => {
    const onRename = vi.fn();
    render(<ChatMenu onRename={onRename} />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }));

    expect(onRename).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('opens with the keyboard and moves the highlight with arrows', async () => {
    render(<ChatMenu />);
    const trigger = screen.getByRole('button', { name: 'Options' });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Pin/ })));

    fireEvent.keyDown(document.activeElement ?? menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Rename/ }));

    fireEvent.keyDown(document.activeElement ?? menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('two-line rows show a muted description', async () => {
    render(
      <Menu>
        <MenuTrigger render={<Button />}>Model</MenuTrigger>
        <MenuContent>
          <MenuItem description="For complex work">Opus 5.5</MenuItem>
        </MenuContent>
      </Menu>,
    );
    await openMenu('Model');
    const item = screen.getByRole('menuitem');
    expect(item.className).toContain('pb-[7px]');
    expect(screen.getByText('For complex work').className).toContain('text-fg-muted');
  });

  it('checkbox and radio items mark the selection with a blue check', async () => {
    function Settings() {
      const [effort, setEffort] = useState('high');
      return (
        <Menu>
          <MenuTrigger render={<Button />}>Settings</MenuTrigger>
          <MenuContent>
            <MenuCheckboxItem defaultChecked={false}>Web search</MenuCheckboxItem>
            <MenuRadioGroup value={effort} onValueChange={setEffort}>
              <MenuLabel>Effort</MenuLabel>
              <MenuRadioItem value="low">Low</MenuRadioItem>
              <MenuRadioItem value="high">High</MenuRadioItem>
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      );
    }
    render(<Settings />);
    await openMenu('Settings');

    const search = screen.getByRole('menuitemcheckbox', { name: 'Web search' });
    expect(search.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(search);
    expect(search.getAttribute('aria-checked')).toBe('true');
    expect(search.querySelector('svg')?.getAttribute('class')).toContain('text-interactive');

    expect(screen.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Low' }));
    expect(screen.getByRole('menuitemradio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Effort').className).toContain('text-fg-muted');
  });

  it('labels a group and opens a submenu with its hint and chevron', async () => {
    render(
      <Menu>
        <MenuTrigger render={<Button />}>Model</MenuTrigger>
        <MenuContent>
          <MenuGroup>
            <MenuLabel>Anthropic</MenuLabel>
            <MenuItem>Opus 5.5</MenuItem>
          </MenuGroup>
          <MenuSubmenu label="Effort" hint="Extra">
            <MenuItem>Low</MenuItem>
            <MenuItem>Extra</MenuItem>
          </MenuSubmenu>
        </MenuContent>
      </Menu>,
    );
    await openMenu('Model');
    expect(screen.getByRole('group', { name: 'Anthropic' })).toBeTruthy();

    const submenuTrigger = screen.getByRole('menuitem', { name: /Effort/ });
    expect(submenuTrigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(screen.getByText('Extra').className).toContain('text-fg-muted');

    act(() => submenuTrigger.focus());
    fireEvent.keyDown(submenuTrigger, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2));
    expect(screen.getByRole('menuitem', { name: 'Low' })).toBeTruthy();
  });
});
