import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/index.ts';
import { STARTERS, Starters, pickRandom } from './starters.tsx';

function renderStarters() {
  const onPick = vi.fn();
  render(
    <TooltipProvider>
      <Starters onPick={onPick} />
    </TooltipProvider>,
  );
  return onPick;
}

describe('Starters', () => {
  it('opens a category onto example prompts, and picking one hands it over and closes the list', () => {
    const onPick = renderStarters();
    const chips = screen.getByRole('group', { name: 'Ideas to start with' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['Write', 'Learn', 'Code', 'Life stuff', 'Surprise me']);

    fireEvent.click(within(chips).getByRole('button', { name: 'Learn' }));
    const learn = screen.getByRole('region', { name: 'Learn' });
    expect(within(learn).getAllByRole('listitem')).toHaveLength(4);
    fireEvent.click(within(learn).getByRole('button', { name: STARTERS[1]!.prompts[1]! }));
    expect(onPick).toHaveBeenCalledWith(STARTERS[1]!.prompts[1]);
    expect(screen.getByRole('group', { name: 'Ideas to start with' })).toBeTruthy();
  });

  it('surprises with four prompts, and closes back to the chips', () => {
    renderStarters();
    fireEvent.click(screen.getByRole('button', { name: 'Surprise me' }));
    const surprise = screen.getByRole('region', { name: 'Surprise me' });
    expect(within(surprise).getAllByRole('listitem')).toHaveLength(4);
    fireEvent.click(within(surprise).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Surprise me' })).toBeNull();
  });

  it('picks distinct prompts in random order', () => {
    expect(pickRandom(['a', 'b', 'c', 'd'], 3, () => 0)).toEqual(['b', 'c', 'd']);
    expect(new Set(pickRandom(['a', 'b', 'c', 'd', 'e'], 4)).size).toBe(4);
  });
});
