import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionReply } from './selection-reply.tsx';

function Page({ onReply }: { onReply(text: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref} data-testid="transcript">
        <p data-testid="answer">The kettle boils at 100 °C at sea level.</p>
        <button type="button" data-testid="button">
          Retry
        </button>
      </div>
      <textarea data-testid="box" defaultValue="my draft" />
      <p data-testid="outside">Outside the conversation.</p>
      <SelectionReply container={ref} onReply={onReply} />
    </div>
  );
}

/** jsdom has no layout: the selection's first line is stated. */
const line = { left: 120, top: 200, right: 300, bottom: 220, width: 180, height: 20, x: 120, y: 200, toJSON: () => ({}) };

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

async function released() {
  act(() => void document.dispatchEvent(new Event('pointerup')));
  await act(async () => void (await new Promise((r) => setTimeout(r, 5))));
}

/** A selection made without the pointer (keyboard, Select all): it settles on its own. */
async function keyboardSelected() {
  act(() => void document.dispatchEvent(new Event('selectionchange')));
  await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
}

describe('SelectionReply', () => {
  beforeEach(() => {
    Range.prototype.getClientRects = () => [line] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => line as DOMRect;
    Element.prototype.getBoundingClientRect = () => ({ ...line, top: 0, bottom: 800, left: 0, right: 900 }) as DOMRect;
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it('offers to reply to a passage that was selected, and hands over its text', async () => {
    const onReply = vi.fn();
    render(<Page onReply={onReply} />);
    expect(screen.queryByRole('button', { name: 'Reply to the selected text' })).toBeNull();

    select(screen.getByTestId('answer').firstChild!);
    await released();
    const pill = screen.getByRole('button', { name: 'Reply to the selected text' });
    // Above the selection's first line, at its left edge.
    expect(pill.style.left).toBe('120px');
    expect(pill.style.top).toBe(`${200 - 36 - 8}px`);

    fireEvent.click(pill);
    expect(onReply).toHaveBeenCalledWith('The kettle boils at 100 °C at sea level.');
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(screen.queryByRole('button', { name: 'Reply to the selected text' })).toBeNull();
  });

  it('shows for a selection made with the keyboard, but not while the pointer still drags one', async () => {
    render(<Page onReply={() => {}} />);
    act(() => void document.dispatchEvent(new Event('pointerdown')));
    select(screen.getByTestId('answer').firstChild!);
    await keyboardSelected();
    expect(screen.queryByRole('button', { name: 'Reply to the selected text' })).toBeNull();
    await released();
    expect(screen.getByRole('button', { name: 'Reply to the selected text' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    select(screen.getByTestId('answer').firstChild!);
    await keyboardSelected();
    expect(screen.getByRole('button', { name: 'Reply to the selected text' })).toBeTruthy();
  });

  it('stays away from the message box, other controls and text outside the conversation', async () => {
    render(<Page onReply={() => {}} />);
    for (const id of ['box', 'button', 'outside']) {
      const target = screen.getByTestId(id);
      select(target.firstChild ?? target);
      await released();
      expect(screen.queryByRole('button', { name: 'Reply to the selected text' })).toBeNull();
    }
  });

  it('goes away when the selection does, or on Escape', async () => {
    render(<Page onReply={() => {}} />);
    select(screen.getByTestId('answer').firstChild!);
    await released();
    expect(screen.getByRole('button', { name: 'Reply to the selected text' })).toBeTruthy();
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.queryByRole('button', { name: 'Reply to the selected text' })).toBeNull();

    select(screen.getByTestId('answer').firstChild!);
    await released();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Reply to the selected text' })).toBeNull();
  });
});
