import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Todo } from '@atelier/protocol';
import { TaskProgressList } from './task-progress.tsx';

const todos: Todo[] = [
  { content: 'Read the quarterly numbers', status: 'completed' },
  { content: 'Write the summary', status: 'in_progress', activeForm: 'Writing the summary' },
  { content: 'Save report.md', status: 'pending' },
];

const progress = () => screen.getByRole('region', { name: 'Progress' });

describe('TaskProgressList', () => {
  it('lists the steps with their status and counts what is done', () => {
    render(<TaskProgressList todos={todos} running />);
    expect(within(progress()).getByRole('heading').textContent).toBe('Progress1 of 3');
    const rows = within(progress()).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Read the quarterly numbers', 'Writing the summary', 'Save report.md']);
    expect(rows.map((r) => r.querySelector('[role="img"]')?.getAttribute('aria-label'))).toEqual(['Done', 'In progress', 'Pending']);
    // Long steps wrap in the narrow column instead of being cut off.
    expect(within(rows[1]!).getByText('Writing the summary').className).toContain('break-words');
    expect(rows[1]!.querySelector('.animate-spin')).not.toBeNull();
  });

  it('stops the current step from spinning once the run stopped', () => {
    render(<TaskProgressList todos={todos} running={false} />);
    const current = within(progress()).getAllByRole('listitem')[1]!;
    expect(current.querySelector('.animate-spin')).toBeNull();
    expect(current.querySelector('[aria-label="In progress"] svg')).not.toBeNull();
  });

  it('says where the steps will show before there are any, and that there were none after', () => {
    const { rerender } = render(<TaskProgressList todos={[]} running />);
    expect(progress().textContent).toBe('ProgressThe steps show here once the task is planned.');
    rerender(<TaskProgressList todos={[]} running={false} />);
    expect(progress().textContent).toBe('ProgressThis task listed no steps.');
  });
});
