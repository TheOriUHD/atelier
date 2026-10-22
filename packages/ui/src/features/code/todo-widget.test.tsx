import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Todo } from '@atelier/protocol';
import { TodoList, TodoWidget } from './todo-widget.tsx';

const todos: Todo[] = [
  { content: 'Read the code', status: 'completed' },
  { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
  { content: 'Run the tests', status: 'pending' },
];

describe('TodoList', () => {
  it('shows each task with its status; the current one in its present form, done ones struck through', () => {
    render(<TodoList todos={todos} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Read the code', 'Fixing the bug', 'Run the tests']);
    expect(rows.map((r) => r.querySelector('[role="img"]')?.getAttribute('aria-label'))).toEqual(['Done', 'In progress', 'Pending']);
    expect(screen.getByText('Read the code').className).toContain('line-through');
  });
});

describe('TodoWidget', () => {
  it('sums up the current task and opens into the list', () => {
    render(<TodoWidget todos={todos} />);
    const toggle = screen.getByRole('button', { name: /Fixing the bug/ });
    expect(toggle.textContent).toContain('1 of 3 done');
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('stops the current task spinning when the run is over', () => {
    const { container, rerender } = render(<TodoWidget todos={todos} running />);
    fireEvent.click(screen.getByRole('button', { name: /Fixing the bug/ }));
    const current = () => container.querySelector('[role="img"][aria-label="In progress"]')!;
    expect(current().querySelector('[role="status"], .animate-spin, svg')).toBeTruthy();
    const spinning = current().innerHTML;
    rerender(<TodoWidget todos={todos} running={false} />);
    expect(current().innerHTML).not.toBe(spinning);
  });

  it('goes away once everything is done', () => {
    const { container } = render(<TodoWidget todos={todos.map((t) => ({ ...t, status: 'completed' }))} />);
    expect(container.childElementCount).toBe(0);
  });
});
