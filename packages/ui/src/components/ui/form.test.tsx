import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Field } from './field.tsx';
import { Select, type SelectOption } from './select.tsx';
import { TextArea, TextField } from './text-field.tsx';

describe('TextField and TextArea', () => {
  it('styles the input as a 32px field with an inset ring and muted placeholder', () => {
    render(<TextField aria-label="Name" placeholder="Name your project" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.className.split(' ')).toEqual(
      expect.arrayContaining([
        'h-8',
        'px-3',
        'rounded-lg',
        'bg-fill-field',
        'inset-ring',
        'inset-ring-fill-field-ring',
        'placeholder:text-fg-muted',
        'focus-ring',
      ]),
    );
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('marks an invalid value with the danger ring', () => {
    render(<TextField aria-label="Name" invalid />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.className).toContain('aria-invalid:inset-ring-danger');
  });

  it('textarea is at least 80 tall and resizes vertically', () => {
    render(<TextArea aria-label="Goal" />);
    const textarea = screen.getByRole('textbox', { name: 'Goal' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.className.split(' ')).toEqual(expect.arrayContaining(['min-h-20', 'resize-y', 'px-3', 'py-2']));
  });

  it('reports typed values', () => {
    const onValueChange = vi.fn();
    render(<TextField aria-label="Name" onValueChange={onValueChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Atelier' } });
    expect(onValueChange).toHaveBeenCalledWith('Atelier', expect.anything());
  });
});

describe('Field', () => {
  it('labels the control and describes it', () => {
    render(
      <Field label="What are you working on?" description="Shown in the sidebar.">
        <TextField placeholder="Name your project" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'What are you working on?' });
    const label = screen.getByText('What are you working on?');
    expect(label.className).toContain('mb-2');
    expect(label.className).toContain('font-medium');
    expect(label.className).toContain('text-[14px]/[14px]');
    const description = screen.getByText('Shown in the sidebar.');
    expect(input.getAttribute('aria-describedby')).toContain(description.id);
  });

  it('shows the error and marks the control invalid', () => {
    render(
      <Field label="Name" error="Name is required">
        <TextField />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    const error = screen.getByText('Name is required');
    expect(error.className).toContain('text-danger-text');
    expect(input.hasAttribute('data-invalid')).toBe(true);
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
  });
});

const FONTS: SelectOption<'serif' | 'sans' | 'mono'>[] = [
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans' },
  { value: 'mono', label: 'Mono' },
];

describe('Select', () => {
  it('ghost variant shows the value right-aligned with a muted chevron', () => {
    render(<Select aria-label="Chat font" options={FONTS} defaultValue="sans" />);
    const trigger = screen.getByRole('combobox', { name: 'Chat font' });
    expect(trigger.textContent).toBe('Sans');
    expect(trigger.className.split(' ')).toEqual(
      expect.arrayContaining(['h-8', 'pl-2', 'justify-end', 'hover:bg-fill-ghost-hover']),
    );
    expect(trigger.className).not.toContain('bg-fill-field');
    expect(trigger.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(trigger.querySelector('svg')?.parentElement?.className).toContain('text-fg-muted');
  });

  it('field variant is a full-width field box', () => {
    render(<Select aria-label="Model" variant="field" options={FONTS} placeholder="Choose" />);
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger.textContent).toBe('Choose');
    expect(trigger.className.split(' ')).toEqual(
      expect.arrayContaining(['w-full', 'rounded-lg', 'bg-fill-field', 'inset-ring-fill-field-ring']),
    );
  });

  it('opens a menu-styled list, previews options and selects one', async () => {
    function FontSelect() {
      const [font, setFont] = useState<'serif' | 'sans' | 'mono'>('serif');
      return (
        <Select
          aria-label="Chat font"
          options={FONTS}
          value={font}
          onValueChange={setFont}
          renderOption={(option) => <span className={`font-${option.value}`}>{option.label}</span>}
        />
      );
    }
    render(<FontSelect />);
    const trigger = screen.getByRole('combobox', { name: 'Chat font' });
    expect(trigger.querySelector('.font-serif')?.textContent).toBe('Serif');

    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox');
    expect(listbox.closest('.bg-popover')?.className).toContain('shadow-popover');

    const mono = screen.getByRole('option', { name: 'Mono' });
    expect(mono.querySelector('.font-mono')).not.toBeNull();
    expect(mono.className).toContain('data-highlighted:bg-fill-ghost-hover');
    expect(screen.getByRole('option', { name: 'Serif' }).getAttribute('aria-selected')).toBe('true');

    // Base UI only accepts mouse clicks that started on the option.
    fireEvent.pointerDown(mono, { pointerType: 'mouse' });
    fireEvent.click(mono);

    await waitFor(() => expect(trigger.textContent).toBe('Mono'));
    expect(trigger.querySelector('.font-mono')).not.toBeNull();
  });
});
