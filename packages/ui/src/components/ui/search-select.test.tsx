import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchSelect } from './search-select.tsx';

const OPTIONS = [
  { value: 'a/qwen3', label: 'qwen3 · Homelab' },
  { value: 'b/sonnet', label: 'Claude Sonnet · Anthropic' },
  { value: 'c/gpt', label: 'GPT-6.1-Sol · ChatGPT' },
];

/** Typing, as a keyboard does it (the list opens on typed input, not on autofill). */
const typeInto = (input: HTMLElement, value: string) => fireEvent.input(input, { target: { value }, inputType: 'insertText' });
const pick = (option: HTMLElement) => {
  // Base UI only accepts mouse clicks that started on the option.
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);
};

describe('SearchSelect', () => {
  it('filters the list as the person types, says when nothing matches, and picks', async () => {
    const chosen = vi.fn();
    render(<SearchSelect aria-label="Model" options={OPTIONS} onValueChange={chosen} empty="No model matches." />);
    const input = screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement;
    typeInto(input, 'son');
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Claude Sonnet · Anthropic']));
    typeInto(input, 'zzz');
    expect(await screen.findByText('No model matches.')).toBeTruthy();
    typeInto(input, 'gpt');
    pick(await screen.findByRole('option', { name: 'GPT-6.1-Sol · ChatGPT' }));
    expect(chosen).toHaveBeenCalledWith('c/gpt');
    expect(input.value).toBe('GPT-6.1-Sol · ChatGPT');
  });

  it('shows the chosen option, and opens the whole list from its button', async () => {
    render(<SearchSelect aria-label="Model" options={OPTIONS} value="b/sonnet" />);
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLInputElement).value).toBe('Claude Sonnet · Anthropic');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
  });
});
